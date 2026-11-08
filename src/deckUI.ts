import { artUrlFor } from "./artSource";
import type { DeckCache } from "./deckCache";
import { parseYdk, rowsOf, toSaved, type DeckManager, type DeckRow, type Include, type ParsedDeck } from "./deck";
import type { Mode } from "./modelConfig";
import type { CardInfo } from "./types";

export interface DeckUIOptions {
  dialog: HTMLDialogElement;
  manager: DeckManager;
  cache: DeckCache;
  getMode: () => Mode;
  /** il mazzo è pronto (o rimosso): main aggiorna elenco carte e stato */
  onChange: (cards: CardInfo[] | null, scopeOnly: boolean) => void;
}

const SECTION_LABEL = { main: "Main", extra: "Extra", side: "Side" } as const;

/** Finestra "Carica mazzo": scegli un .ydk, scarica gli artwork, prepara l'identificazione sul solo mazzo. */
export class DeckUI {
  private el = (id: string) => document.getElementById(id)!;
  private parsed: ParsedDeck | null = null;
  private busy = false;
  scopeOnly = true;

  constructor(private o: DeckUIOptions) {
    const { dialog } = o;
    const file = this.el("deckFile") as HTMLInputElement;
    file.onchange = () => file.files?.[0] && this.loadFile(file.files[0]);
    const drop = this.el("deckDrop");
    drop.ondragover = (e) => (e.preventDefault(), drop.classList.add("over"));
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove("over");
      const f = e.dataTransfer?.files?.[0];
      if (f) void this.loadFile(f);
    };
    for (const id of ["incMain", "incExtra", "incSide"]) (this.el(id) as HTMLInputElement).onchange = () => this.render();
    (this.el("deckScope") as HTMLInputElement).onchange = (e) => {
      this.scopeOnly = (e.target as HTMLInputElement).checked;
      if (o.manager.active) this.publish();
    };
    this.el("deckGo").onclick = () => void this.prepare();
    this.el("deckClear").onclick = () => this.clearDeck();
    this.el("deckClose").onclick = () => dialog.close();
    const back = this.el("backFile") as HTMLInputElement;
    back.onchange = async () => {
      const f = back.files?.[0];
      if (!f) return;
      await o.cache.putMeta("backBlob", f);
      o.manager.invalidate();
      this.msg("Dorso salvato. Premi «Scarica e prepara» per ricalcolare.");
    };
    void this.renderRecent();
  }

  open() {
    void this.renderRecent();
    this.o.dialog.showModal();
  }

  include(): Include {
    return {
      main: (this.el("incMain") as HTMLInputElement).checked,
      extra: (this.el("incExtra") as HTMLInputElement).checked,
      side: (this.el("incSide") as HTMLInputElement).checked,
    };
  }

  async loadFile(f: File) {
    this.setDeck(parseYdk(await f.text(), f.name.replace(/\.[^.]+$/, "")));
  }

  setDeck(d: ParsedDeck) {
    this.parsed = d;
    this.el("deckName").textContent = d.name;
    this.render();
  }

  /** Riapre l'ultimo mazzo usato (dalla cache, senza rete se è già tutto scaricato). */
  async restore(name: string) {
    const saved = await this.o.cache.getDeck(name);
    if (!saved) return;
    this.setDeck(saved);
    await this.prepare(true);
  }

  private rows(): DeckRow[] {
    return this.parsed ? rowsOf(this.parsed, this.include()) : [];
  }

  private msg(text: string) {
    this.el("deckMsg").textContent = text;
  }

  private render(rows: DeckRow[] = this.rows()) {
    const list = this.el("deckList");
    const total = rows.reduce((n, r) => n + r.count, 0);
    this.el("deckCount").textContent = this.parsed ? `${rows.length} carte uniche, ${total} totali` : "";
    (this.el("deckGo") as HTMLButtonElement).disabled = !rows.length || this.busy;
    list.replaceChildren(
      ...rows.map((r) => {
        const row = document.createElement("div");
        row.className = `deck-row ${r.status}`;
        row.id = `deckrow-${r.id}`;
        const img = document.createElement("img");
        img.alt = "";
        if (r.card?.art) img.src = artUrlFor(r.id);
        const name = document.createElement("span");
        name.className = "n";
        name.textContent = r.card?.name || `#${r.id}`;
        const meta = document.createElement("span");
        meta.className = "m";
        const label = { pending: "", ok: "✓", missing: "non trovata", error: "errore" }[r.status];
        meta.textContent = `×${r.count} · ${r.sections.map((s) => SECTION_LABEL[s]).join("/")} ${label}`;
        row.append(img, name, meta);
        return row;
      }),
    );
  }

  private updateRow(r: DeckRow) {
    const el = document.getElementById(`deckrow-${r.id}`);
    if (!el) return;
    el.className = `deck-row ${r.status}`;
    if (r.card?.art) (el.querySelector("img") as HTMLImageElement).src = artUrlFor(r.id);
    (el.querySelector(".n") as HTMLElement).textContent = r.card?.name || `#${r.id}`;
    const label = { pending: "", ok: "✓", missing: "non trovata", error: "errore" }[r.status];
    (el.querySelector(".m") as HTMLElement).textContent = `×${r.count} · ${r.sections.map((s) => SECTION_LABEL[s]).join("/")} ${label}`;
  }

  async prepare(silent = false) {
    if (this.busy || !this.parsed) return;
    const rows = this.rows();
    this.busy = true;
    (this.el("deckGo") as HTMLButtonElement).disabled = true;
    const bar = this.el("deckProgress") as HTMLProgressElement;
    bar.hidden = false;
    try {
      await this.o.cache.putDeck(toSaved(this.parsed));
      const res = await this.o.manager.prepare(
        this.parsed.name, rows, this.o.getMode(),
        (m, d, t) => ((bar.max = t || 1), (bar.value = d), this.msg(`${m} ${d}/${t}`)),
        (r) => this.updateRow(r),
      );
      this.msg(
        `Mazzo pronto: ${res.ok} carte` +
          (res.missing ? `, ${res.missing} non trovate` : "") +
          (res.errors ? `, ${res.errors} con errori` : "") +
          (res.backs ? "" : ". Nessun dorso: scegline uno qui sotto per riconoscere le carte coperte"),
      );
      try { localStorage.setItem("ygo-deck", this.parsed.name); } catch { /* storage non disponibile */ }
      this.publish();
      if (!silent) this.o.dialog.close();
    } catch (e) {
      this.msg(`Errore: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.busy = false;
      bar.hidden = true;
      (this.el("deckGo") as HTMLButtonElement).disabled = false;
    }
  }

  private publish() {
    const cards: CardInfo[] = this.o.manager.rows
      .filter((r) => r.card?.name && r.status !== "missing")
      .map((r) => ({
        id: r.id, name: r.card!.name, type: r.card!.type ?? "", attribute: r.card!.attribute, level: r.card!.level ?? undefined,
        atk: r.card!.atk ?? undefined, def: r.card!.def ?? undefined, art: `cards/${r.id}.jpg`, count: r.count,
      }));
    this.o.onChange(cards, this.scopeOnly);
  }

  private clearDeck() {
    this.o.manager.clear();
    this.parsed = null;
    this.el("deckName").textContent = "";
    this.render();
    this.msg("Mazzo rimosso: l'identificazione usa tutto il database (se presente).");
    try { localStorage.removeItem("ygo-deck"); } catch { /* storage non disponibile */ }
    this.o.onChange(null, false);
  }

  private async renderRecent() {
    const host = this.el("deckRecent");
    const decks = await this.o.cache.listDecks();
    host.replaceChildren(
      ...decks.slice(0, 6).map((d) => {
        const b = document.createElement("button");
        b.textContent = d.name;
        b.title = `${d.main.length + d.extra.length + d.side.length} carte`;
        b.onclick = () => this.setDeck(d);
        return b;
      }),
    );
    host.hidden = !decks.length;
  }
}
