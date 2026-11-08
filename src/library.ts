import type { CardInfo } from "./types";

export const artUrl = (c: CardInfo) => import.meta.env.BASE_URL + c.art;
export const artUrlById = (list: CardInfo[], id: number) => {
  const c = list.find((x) => x.id === id);
  return c ? artUrl(c) : "";
};

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
    const q = search.value.trim().toLowerCase();
    const shown = cards.filter((c) => !q || c.name.toLowerCase().includes(q) || String(c.id).includes(q));
    host.replaceChildren(
      ...shown.map((c) => {
        const b = document.createElement("button");
        b.className = "lib-item";
        b.title = `${c.name} (${c.type})`;
        const img = document.createElement("img");
        img.src = artUrl(c);
        img.loading = "lazy";
        img.alt = "";
        const span = document.createElement("span");
        span.textContent = c.name;
        b.append(img, span);
        b.onclick = () => onPick(c);
        return b;
      }),
    );
    if (!cards.length) host.textContent = "Nessuna carta: esegui `npm run cards` e ricarica la pagina.";
    else if (!shown.length) host.textContent = "Nessun risultato.";
  };
  search.oninput = render;
  render();
}
