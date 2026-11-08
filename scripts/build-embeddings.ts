/**
 * Calcola gli embedding di tutte le carte scaricate e dei dorsi, con lo STESSO modello e lo STESSO
 * preprocessing del browser (src/embedderCore.ts + src/preprocess.ts), e scrive:
 *
 *   public/embeddings/index.json        modello usato + elenco carte (id, nome, tipo, ATK/DEF, livello, attributo)
 *   public/embeddings/vectors-art.bin   modalità "art":  immagine = artwork ritagliato
 *   public/embeddings/vectors-full.bin  modalità "full": immagine = carta intera
 *
 * Layout di ogni .bin: Float32[N] (1/norma di ogni riga) seguito da Int8[N * dim] (riga = vettore
 * unitario quantizzato: round(v / max|v| * 127)). Le righe senza immagine hanno 1/norma = 0.
 *
 *   npm run embeddings
 *
 * Variabili: EMBEDDER=thumb (backend di prova, senza modello), MODEL_DIR=<cartella> (modello locale).
 * Perché TypeScript e non Python: stesso pacchetto (@huggingface/transformers) e stessi pesi ONNX del
 * browser, quindi nessuna discrepanza di preprocessing o di conversione tra due implementazioni.
 */
import { mkdir, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createBackend } from "../src/embedderCore";
import { ART_REGION } from "../src/cardGeometry";
import { MODEL, type EmbeddingIndex, type IndexCard, type Mode, type ModelInfo } from "../src/modelConfig";
import { rotate180, toModelInput, type RgbaImage } from "../src/preprocess";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardsDir = join(root, "public", "cards");
const outDir = join(root, "public", "embeddings");

const info: ModelInfo =
  process.env.EMBEDDER === "thumb" ? { backend: "thumb", id: "thumb-8x8", dtype: "none", dim: 8 * 8 * 3, input: MODEL.input } : MODEL;

const exists = (p: string) => stat(p).then((s) => s.size > 0, () => false);

async function decode(path: string): Promise<RgbaImage> {
  const { data, info: i } = await sharp(path).flatten({ background: "#000" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: i.width, height: i.height };
}

function quantize(v: Float32Array): { q: Int8Array; inv: number } {
  let max = 0;
  for (const x of v) max = Math.max(max, Math.abs(x));
  const q = new Int8Array(v.length);
  let n = 0;
  for (let i = 0; i < v.length; i++) {
    q[i] = Math.round((v[i] / max) * 127);
    n += q[i] * q[i];
  }
  return { q, inv: 1 / Math.sqrt(n || 1) };
}

async function main() {
  const cfg = JSON.parse(await readFile(join(root, "cards.config.json"), "utf8"));
  const modes: Mode[] = (cfg.images?.length ? cfg.images : ["art"]) as Mode[];
  const manifest: any[] = JSON.parse(await readFile(join(cardsDir, "cards.json"), "utf8"));
  const backend = await createBackend(info, {
    device: "cpu",
    localModelPath: process.env.MODEL_DIR,
    onProgress: (p) => process.stdout.write(`\r  modello ${p.file}: ${Math.round(p.progress)}%   `),
  });
  console.log(`\nBackend: ${backend.name} su ${backend.device}`);

  const imagePath = (id: number, m: Mode) => (m === "art" ? join(cardsDir, `${id}.jpg`) : join(cardsDir, "full", `${id}.jpg`));

  // Carte indicizzate: quelle con almeno un'immagine tra le modalità richieste.
  const cards: IndexCard[] = [];
  const withImage = new Map<number, Mode[]>();
  for (const c of manifest) {
    const have: Mode[] = [];
    for (const m of modes) if (await exists(imagePath(c.id, m))) have.push(m);
    if (!have.length) continue;
    withImage.set(c.id, have);
    cards.push({ id: c.id, name: c.name, type: c.type, atk: c.atk, def: c.def, level: c.level, attribute: c.attribute });
  }

  // Dorsi: public/cards/back*.{jpg,png}. Ogni immagine genera due righe (dritta e ruotata di 180°).
  const backFiles = (await readdir(cardsDir)).filter((f) => /^back.*\.(jpe?g|png|webp)$/i.test(f));
  if (!backFiles.length) console.warn("Nessun dorso (public/cards/back*.jpg): le carte coperte non saranno riconosciute.");
  const backRows: { img: RgbaImage; rot: boolean; idx: number }[] = [];
  for (const [i, f] of backFiles.entries()) {
    const img = await decode(join(cardsDir, f));
    for (const rot of [false, true]) {
      cards.push({ id: -(backRows.length + 1), name: `Dorso (${f}${rot ? ", 180°" : ""})`, back: true });
      backRows.push({ img, rot, idx: i });
    }
  }

  const files: EmbeddingIndex["files"] = {};
  await mkdir(outDir, { recursive: true });
  for (const mode of modes) {
    const N = cards.length;
    const inv = new Float32Array(N);
    const q = new Int8Array(N * info.dim);
    const region = mode === "art" ? ART_REGION : null;
    const t0 = Date.now();
    let done = 0;
    for (let r = 0; r < N; r++) {
      const c = cards[r];
      let img: RgbaImage | null = null;
      if (c.back) {
        const b = backRows[-c.id - 1];
        img = b.rot ? rotate180(b.img) : b.img;
        // Il dorso è un'immagine di carta intera: in modalità art si ritaglia la stessa regione dell'illustrazione.
      } else if (withImage.get(c.id)?.includes(mode)) {
        img = await decode(imagePath(c.id, mode));
      }
      if (!img) continue;
      // art: l'immagine è già il ritaglio dell'illustrazione (region null); full: carta intera (region null).
      const useRegion = c.back ? region : null;
      const v = await backend.embed(toModelInput(img, useRegion, info.input));
      const { q: qq, inv: ii } = quantize(v);
      q.set(qq, r * info.dim);
      inv[r] = ii;
      if (++done % 200 === 0) {
        const per = (Date.now() - t0) / done;
        console.log(`  [${mode}] ${done}/${N}  ~${Math.round((per * (N - done)) / 1000)} s rimanenti`);
      }
    }
    const buf = Buffer.concat([Buffer.from(inv.buffer), Buffer.from(q.buffer)]);
    files[mode] = `vectors-${mode}.bin`;
    await writeFile(join(outDir, files[mode]!), buf);
    console.log(`[${mode}] ${done} vettori, ${(buf.length / 1e6).toFixed(1)} MB`);
  }

  const index: EmbeddingIndex = { version: 1, model: info, modes, files, cards };
  await writeFile(join(outDir, "index.json"), JSON.stringify(index));
  console.log(`index.json: ${cards.length} voci (${cards.filter((c) => c.back).length} dorsi)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
