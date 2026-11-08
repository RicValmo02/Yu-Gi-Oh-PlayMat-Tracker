import type { CardInfo } from "./types";

import { artUrlFor } from "./artSource";

/** Legge il manifest scritto da `npm run cards`. Nessuna chiamata all'API YGOPRODeck. */
export async function loadLibrary(): Promise<CardInfo[]> {
  try {
    const r = await fetch(import.meta.env.BASE_URL + "cards/cards.json", { cache: "no-cache" });
    if (!r.ok) return [];
    const data = await r.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Elenco con casella di ricerca; onPick riceve la carta cliccata. */
export function buildLibraryUI(host: HTMLElement, search: HTMLInputElement, cards: CardInfo[], onPick: (c: CardInfo) => void) {
  const render = () => {
    const MAX = 80; // l'elenco può avere migliaia di carte: se ne mostrano solo le prime
    const q = search.value.trim().toLowerCase();
    const shown = cards.filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.id).includes(q)).slice(0, MAX);
    host.replaceChildren(
      ...shown.map((c) => {
        const b = document.createElement("button");
        b.className = "lib-item";
        b.title = `${c.name} (${c.type})`;
        const img = document.createElement("img");
        img.src = artUrlFor(c.id);
        img.loading = "lazy";
        img.alt = "";
        const span = document.createElement("span");
        span.textContent = c.count ? `${c.name}  ×${c.count}` : c.name;
        b.append(img, span);
        b.onclick = () => onPick(c);
        return b;
      }),
    );
    if (!cards.length) host.textContent = "Nessuna carta: carica un mazzo (.ydk) oppure esegui `npm run cards`.";
    else if (!shown.length) host.textContent = "Nessun risultato.";
  };
  search.oninput = render;
  render();
}
