/**
 * Scarica da YGOPRODeck dati e immagini delle carte e le salva in public/cards/.
 *
 *   public/cards/<id>.jpg        artwork ritagliato (images contiene "art")
 *   public/cards/full/<id>.jpg   carta intera 421x614 (images contiene "full")
 *   public/cards/back.jpg        dorso della carta (config.back)
 *   public/cards/cards.json      elenco delle carte disponibili
 *
 * Configurazione: cards.config.json
 *   mode: "subset" (solo cardIds) | "all" (tutto il database, ~13.000 carte)
 *   images: ["art"], ["full"] o entrambe; delayMs: pausa tra due download di immagini
 *
 * È ripristinabile: i file già presenti non si riscaricano e ogni file è scritto in modo atomico,
 * quindi si può interrompere (Ctrl+C) e rilanciare. Esegui `npm run cards`.
 * Variabile opzionale YGOPRODECK_API per puntare a un altro endpoint (test).
 */
import { mkdir, readFile, writeFile, rename, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "cards");
const cacheDir = join(root, "scripts", ".cache");
const API = process.env.YGOPRODECK_API ?? "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const HEADERS = { "User-Agent": "ygo-playmat-tracker/0.4 (uso personale)" };

type Kind = "art" | "full";
interface Config {
  mode: "subset" | "all";
  cardIds: number[];
  images: Kind[];
  delayMs: number;
  back?: { url: string; file: string };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fileOk = (p: string) => stat(p).then((s) => s.size > 0, () => false);

/** fetch con timeout e nuovi tentativi (429/5xx/errori di rete), backoff esponenziale. */
async function fetchRetry(url: string, tries = 4): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) });
      if (res.ok) return res;
      if (res.status !== 429 && res.status < 500) return res; // 404 ecc.: inutile riprovare
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(1000 * 2 ** i);
  }
  throw lastErr;
}

async function saveAtomic(dest: string, data: Buffer) {
  const tmp = dest + ".part";
  await writeFile(tmp, data);
  await rename(tmp, dest);
}

async function loadCardData(cfg: Config): Promise<any[]> {
  if (cfg.mode === "subset") {
    console.log(`Dati di ${cfg.cardIds.length} carte…`);
    const res = await fetchRetry(`${API}?id=${cfg.cardIds.join(",")}`);
    if (!res.ok) throw new Error(`API: HTTP ${res.status}`);
    return ((await res.json()) as { data: any[] }).data;
  }
  // Tutto il database: una sola richiesta, risultato in cache per le esecuzioni successive.
  await mkdir(cacheDir, { recursive: true });
  const cache = join(cacheDir, "cardinfo.json");
  if (await fileOk(cache)) {
    console.log("Uso scripts/.cache/cardinfo.json (cancellalo per riscaricarlo)");
    return JSON.parse(await readFile(cache, "utf8")).data;
  }
  console.log("Scarico l'elenco completo delle carte (una richiesta, qualche decina di MB)…");
  const res = await fetchRetry(API);
  if (!res.ok) throw new Error(`API: HTTP ${res.status}`);
  const text = await res.text();
  await writeFile(cache, text);
  return JSON.parse(text).data;
}

async function main() {
  const cfg: Config = JSON.parse(await readFile(join(root, "cards.config.json"), "utf8"));
  const delay = Math.max(cfg.delayMs ?? 300, 50);
  const kinds = cfg.images?.length ? cfg.images : (["art"] as Kind[]);
  await mkdir(join(outDir, "full"), { recursive: true });

  const data = await loadCardData(cfg);
  const paths = (id: number): Record<Kind, string> => ({ art: join(outDir, `${id}.jpg`), full: join(outDir, "full", `${id}.jpg`) });
  const urlOf = (c: any, k: Kind): string | undefined =>
    c.card_images?.[0]?.[k === "art" ? "image_url_cropped" : "image_url"];

  let downloaded = 0;
  let failed = 0;
  const manifest: Record<string, unknown>[] = [];
  const writeManifest = () => writeFile(join(outDir, "cards.json"), JSON.stringify(manifest));

  let n = 0;
  for (const c of data) {
    n++;
    let haveArt = false;
    for (const k of kinds) {
      const dest = paths(c.id)[k];
      if (await fileOk(dest)) {
        haveArt ||= k === "art";
        continue;
      }
      const url = urlOf(c, k);
      if (!url) continue;
      await sleep(delay); // pausa tra le richieste
      try {
        const img = await fetchRetry(url);
        if (!img.ok) {
          console.warn(`  ${c.id} ${c.name} [${k}]: HTTP ${img.status}`);
          failed++;
          continue;
        }
        await saveAtomic(dest, Buffer.from(await img.arrayBuffer()));
        downloaded++;
        haveArt ||= k === "art";
        if (downloaded % 25 === 0) console.log(`  ${n}/${data.length}  scaricate ${downloaded} immagini (ultima: ${c.name})`);
      } catch (e) {
        console.warn(`  ${c.id} ${c.name} [${k}]: ${e}`);
        failed++;
      }
    }
    // Il sito mostra l'artwork ritagliato: la carta compare in elenco solo se ce l'ha.
    if (haveArt || (await fileOk(paths(c.id).art))) {
      manifest.push({
        id: c.id, name: c.name, type: c.type, attribute: c.attribute, race: c.race,
        level: c.level, atk: c.atk, def: c.def, art: `cards/${c.id}.jpg`,
      });
    }
    if (n % 200 === 0) await writeManifest(); // salvataggio parziale: l'interruzione non perde l'elenco
  }
  await writeManifest();

  if (cfg.back) {
    const dest = join(outDir, cfg.back.file);
    if (await fileOk(dest)) console.log(`Dorso già presente: ${cfg.back.file}`);
    else {
      try {
        const res = await fetchRetry(cfg.back.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await saveAtomic(dest, Buffer.from(await res.arrayBuffer()));
        console.log(`Dorso scaricato: ${cfg.back.file}`);
      } catch (e) {
        console.warn(`Dorso non scaricato (${e}). Metti a mano una foto/immagine del dorso in public/cards/back.jpg.`);
      }
    }
  }

  const asked = cfg.mode === "subset" ? cfg.cardIds : [];
  const missing = asked.filter((id) => !data.some((c) => c.id === id));
  console.log(
    `Fatto: ${manifest.length} carte in public/cards/, ${downloaded} immagini nuove` +
      (failed ? `, ${failed} errori (rilancia per riprovare)` : "") +
      (missing.length ? `, ID non trovati: ${missing.join(", ")}` : ""),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
