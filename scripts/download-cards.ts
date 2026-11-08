/**
 * Scarica da YGOPRODeck dati e artwork ritagliato delle carte elencate in cards.config.json
 * e li salva in public/cards/ (immagini + cards.json). Esegui UNA volta: il sito non chiama più l'API.
 *
 *   npm run cards            (Node >= 22.18 esegue direttamente i .ts; altrimenti: npx tsx scripts/download-cards.ts)
 *
 * Variabile opzionale YGOPRODECK_API per puntare a un altro endpoint (utile nei test).
 */
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "cards");
const API = process.env.YGOPRODECK_API ?? "https://db.ygoprodeck.com/api/v7/cardinfo.php";
const HEADERS = { "User-Agent": "ygo-playmat-tracker/0.3 (uso personale)" };

interface Config {
  cardIds: number[];
  delayMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const exists = (p: string) => access(p).then(() => true, () => false);

async function main() {
  const cfg: Config = JSON.parse(await readFile(join(root, "cards.config.json"), "utf8"));
  const delay = Math.max(cfg.delayMs ?? 1000, 100);
  await mkdir(outDir, { recursive: true });

  // Una sola richiesta per i dati di tutte le carte (l'API accetta id separati da virgola).
  console.log(`Dati di ${cfg.cardIds.length} carte…`);
  const res = await fetch(`${API}?id=${cfg.cardIds.join(",")}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`API: HTTP ${res.status} ${await res.text()}`);
  const { data } = (await res.json()) as { data: any[] };

  const manifest: { id: number; [k: string]: unknown }[] = [];
  for (const c of data) {
    const file = `${c.id}.jpg`;
    const dest = join(outDir, file);
    if (!(await exists(dest))) {
      await sleep(delay); // pausa tra le richieste
      const url: string = c.card_images?.[0]?.image_url_cropped;
      if (!url) {
        console.warn(`  ${c.id} ${c.name}: nessun artwork ritagliato, salto`);
        continue;
      }
      const img = await fetch(url, { headers: HEADERS });
      if (!img.ok) {
        console.warn(`  ${c.id} ${c.name}: HTTP ${img.status}, salto`);
        continue;
      }
      await writeFile(dest, Buffer.from(await img.arrayBuffer()));
      console.log(`  scaricata ${c.id} ${c.name}`);
    } else {
      console.log(`  già presente ${c.id} ${c.name}`);
    }
    manifest.push({
      id: c.id,
      name: c.name,
      type: c.type,
      attribute: c.attribute,
      race: c.race,
      level: c.level,
      atk: c.atk,
      def: c.def,
      desc: c.desc,
      art: `cards/${file}`,
    });
  }
  await writeFile(join(outDir, "cards.json"), JSON.stringify(manifest, null, 1));
  const missing = cfg.cardIds.filter((id) => !manifest.some((m) => m.id === id));
  console.log(`Fatto: ${manifest.length} carte in public/cards/` + (missing.length ? ` (non trovate: ${missing.join(", ")})` : ""));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
