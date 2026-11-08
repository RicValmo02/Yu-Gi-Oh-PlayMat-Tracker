import { setArtBlob } from "./artSource";
import type { CachedCard, DeckCache, SavedDeck } from "./deckCache";
import { EmbeddingDb } from "./db";
import type { Embedder } from "./embedder";
import type { IndexCard, Mode, ModelInfo } from "./modelConfig";

export type Section = "main" | "extra" | "side";

export interface ParsedDeck {
  name: string;
  main: number[];
  extra: number[];
  side: number[];
}

/** Legge un file .ydk: sezioni `#main`, `#extra`, `!side`, un passcode per riga (le copie sono righe ripetute). */
export function parseYdk(text: string, name: string): ParsedDeck {
  const deck: ParsedDeck = { name, main: [], extra: [], side: [] };
  let section: Section = "main";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "#main") section = "main";
    else if (line === "#extra") section = "extra";
    else if (line === "!side") section = "side";
    else if (/^\d+$/.test(line)) deck[section].push(Number(line));
    // altre righe che iniziano con # (es. "#created by ...") sono commenti
  }
  return deck;
}

export interface DeckRow {
  id: number;
  count: number;
  sections: Section[];
  card?: CachedCard;
  status: "pending" | "ok" | "missing" | "error";
}

export type Include = Record<Section, boolean>;

/** Carte uniche del mazzo con numero di copie, nelle sezioni incluse. */
export function rowsOf(deck: ParsedDeck, include: Include): DeckRow[] {
  const rows = new Map<number, DeckRow>();
  for (const s of ["main", "extra", "side"] as Section[]) {
    if (!include[s]) continue;
    for (const id of deck[s]) {
      const r = rows.get(id) ?? { id, count: 0, sections: [], status: "pending" as const };
      r.count++;
      if (!r.sections.includes(s)) r.sections.push(s);
      rows.set(id, r);
    }
  }
  return [...rows.values()];
}

export const toSaved = (d: ParsedDeck): SavedDeck => ({ ...d, at: Date.now() });

/** Il browser scarica tramite il proxy di Vite (/ygo-api, /ygo-img): nessun problema di CORS. */
const API = "/ygo-api/cardinfo.php";
const IMG_PAUSE_MS = 150; // pausa tra due download di immagini (YGOPRODeck chiede di non martellare)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRetry(url: string, tries = 3): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    await sleep(800 * 2 ** i);
  }
  throw last;
}

/** Il campo image_url dell'API è assoluto (https://images.ygoprodeck.com/...): lo si fa passare dal proxy. */
const viaProxy = (u: string) => "/ygo-img" + new URL(u).pathname;

async function toImageData(blob: Blob): Promise<ImageData> {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement("canvas");
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext("2d", { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0);
  bmp.close();
  return g.getImageData(0, 0, c.width, c.height);
}

export type Progress = (msg: string, done: number, total: number) => void;

export interface DeckDeps {
  cache: DeckCache;
  embedder: () => Embedder | null;
  /** risolve quando il modello è pronto (lo avvia se serve), rifiuta se non si può caricare */
  whenReady: () => Promise<void>;
  model: () => ModelInfo;
}

/**
 * Prepara un mazzo: metadati (una sola richiesta all'API), immagini (una volta, poi in cache),
 * embedding (calcolati nel browser con lo stesso modello e preprocessing dell'identificazione)
 * e infine un database in memoria con le sole carte del mazzo più i dorsi.
 */
export class DeckManager {
  private dbs = new Map<Mode, EmbeddingDb>();
  rows: DeckRow[] = [];
  name = "";

  constructor(private deps: DeckDeps) {}

  db(mode: Mode): EmbeddingDb | null {
    return this.dbs.get(mode) ?? null;
  }
  get active() {
    return this.rows.length > 0;
  }
  clear() {
    this.rows = [];
    this.name = "";
    this.dbs.clear();
  }
  invalidate() {
    this.dbs.clear();
  }

  async prepare(name: string, rows: DeckRow[], mode: Mode, onProgress: Progress, onRow?: (r: DeckRow) => void) {
    const { cache } = this.deps;
    this.name = name;
    this.rows = rows;
    this.dbs.delete(mode);
    const model = this.deps.model();
    const vkey = `${model.id}|${model.dtype}|${mode}`;

    // 1) metadati: dalla cache, il resto con UNA richiesta all'API
    onProgress("Dati delle carte…", 0, rows.length);
    for (const r of rows) r.card = await cache.getCard(r.id);
    const unknown = rows.filter((r) => !r.card?.name);
    for (let i = 0; i < unknown.length; i += 40) {
      const batch = unknown.slice(i, i + 40);
      try {
        const res = await fetchRetry(`${API}?id=${batch.map((r) => r.id).join(",")}`);
        const data: any[] = res.ok ? ((await res.json()).data ?? []) : [];
        for (const c of data) {
          const img = c.card_images?.[0];
          const saved = await cache.putCard({
            id: c.id, name: c.name, type: c.type, atk: c.atk, def: c.def, level: c.level, attribute: c.attribute,
            artUrl: img?.image_url_cropped, fullUrl: img?.image_url,
          });
          const row = batch.find((r) => r.id === c.id);
          if (row) row.card = saved;
        }
      } catch (e) {
        console.warn("API YGOPRODeck non raggiungibile:", e);
      }
    }
    for (const r of rows) {
      r.status = r.card?.name ? "pending" : "missing";
      onRow?.(r);
    }
    const usable = rows.filter((r) => r.status !== "missing");

    // 2) immagini (artwork sempre, carta intera solo in modalità "full")
    let done = 0;
    for (const r of usable) {
      onProgress("Download immagini…", done++, usable.length);
      try {
        for (const kind of mode === "full" ? (["art", "full"] as const) : (["art"] as const)) {
          if (r.card![kind]) continue;
          const url = kind === "art" ? r.card!.artUrl : r.card!.fullUrl;
          if (!url) throw new Error("URL immagine assente");
          await sleep(IMG_PAUSE_MS);
          const res = await fetchRetry(viaProxy(url));
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          r.card = await cache.putCard({ id: r.id, [kind]: await res.blob() });
        }
        if (r.card!.art) setArtBlob(r.id, r.card!.art);
      } catch (e) {
        console.warn(`Immagine di ${r.id} non scaricata:`, e);
        r.status = "error";
      }
      onRow?.(r);
    }

    // 3) embedding (serve il modello solo se mancano vettori in cache)
    const withImages = usable.filter((r) => r.status !== "error");
    const toEmbed = withImages.filter((r) => !r.card!.vec?.[vkey]);
    const embedder = () => this.deps.embedder()!;
    if (toEmbed.length) {
      onProgress("Attendo il modello…", 0, toEmbed.length);
      await this.deps.whenReady();
    }
    done = 0;
    for (const r of toEmbed) {
      onProgress("Calcolo gli embedding…", done++, toEmbed.length);
      const blob = mode === "art" ? r.card!.art : r.card!.full;
      if (!blob) {
        r.status = "error";
        continue;
      }
      const img = await toImageData(blob);
      const v = await embedder().embedReference(img.data, img.width, img.height, mode);
      r.card = await cache.putCard({ id: r.id, vec: { [vkey]: v } });
      onRow?.(r);
    }

    // 4) dorso: immagine scelta dall'utente (cache) oppure cards/back.jpg
    const backs = await this.backVectors(mode, vkey, onProgress);

    // 5) database in memoria
    const cards: IndexCard[] = [];
    const vecs: (Float32Array | null)[] = [];
    for (const r of withImages) {
      const v = r.card?.vec?.[vkey];
      if (!v) continue;
      r.status = "ok";
      cards.push({ id: r.id, name: r.card!.name, type: r.card!.type, atk: r.card!.atk, def: r.card!.def, level: r.card!.level, attribute: r.card!.attribute });
      vecs.push(v);
      onRow?.(r);
    }
    backs.forEach((v, i) => {
      cards.push({ id: -(i + 1), name: `Dorso${i % 2 ? " (180°)" : ""}`, back: true });
      vecs.push(v);
    });
    this.dbs.set(mode, EmbeddingDb.fromVectors(mode, model.dim, cards, vecs));
    onProgress("Pronto", 1, 1);
    return { ok: cards.filter((c) => !c.back).length, missing: rows.filter((r) => r.status === "missing").length, errors: rows.filter((r) => r.status === "error").length, backs: backs.length / 2 };
  }

  /** Vettori (dritto + 180°) del dorso. Nessun dorso = le carte coperte non saranno riconosciute. */
  private async backVectors(mode: Mode, vkey: string, onProgress: Progress): Promise<Float32Array[]> {
    const { cache } = this.deps;
    let blob = await cache.getMeta<Blob>("backBlob");
    if (!blob) {
      try {
        const r = await fetch(import.meta.env.BASE_URL + "cards/back.jpg");
        if (r.ok && (r.headers.get("content-type") ?? "").startsWith("image")) blob = await r.blob();
      } catch {
        /* nessun dorso statico */
      }
    }
    if (!blob) return [];
    const sig = `${blob.size}:${blob.type}`;
    const key = `backvec|${vkey}`;
    const cached = await cache.getMeta<{ sig: string; v: Float32Array[] }>(key);
    if (cached?.sig === sig) return cached.v;
    onProgress("Dorso…", 0, 1);
    await this.deps.whenReady();
    const img = await toImageData(blob);
    const r = await this.deps.embedder()!.embed(img.data, img.width, img.height, mode); // il dorso è una carta intera: stesso ritaglio delle carte reali
    await cache.putMeta(key, { sig, v: r.vectors });
    return r.vectors;
  }
}
