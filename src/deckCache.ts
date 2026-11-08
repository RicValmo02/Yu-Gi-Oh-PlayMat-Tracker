/** Cache persistente (IndexedDB) di carte, immagini, embedding e mazzi. Se IndexedDB non c'è, resta in memoria. */
export interface CachedCard {
  id: number;
  name: string;
  type?: string;
  atk?: number | null;
  def?: number | null;
  level?: number | null;
  attribute?: string;
  artUrl?: string; // URL (percorso sul sito YGOPRODeck) da cui scaricare, finché non è in cache
  fullUrl?: string;
  art?: Blob;
  full?: Blob;
  /** embedding unitari per chiave `${modello}|${dtype}|${modalità}` */
  vec?: Record<string, Float32Array>;
}

export interface SavedDeck {
  name: string;
  main: number[];
  extra: number[];
  side: number[];
  at: number;
}

type StoreName = "cards" | "decks" | "meta";

export class DeckCache {
  private mem: Record<StoreName, Map<unknown, unknown>> = { cards: new Map(), decks: new Map(), meta: new Map() };

  private constructor(private db: IDBDatabase | null) {}

  static async open(): Promise<DeckCache> {
    try {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("ygo-tracker", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("cards", { keyPath: "id" });
          req.result.createObjectStore("decks", { keyPath: "name" });
          req.result.createObjectStore("meta");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return new DeckCache(db);
    } catch {
      return new DeckCache(null); // modalità privata / storage bloccato
    }
  }

  private tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    if (!this.db) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      try {
        const req = fn(this.db!.transaction(store, mode).objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      } catch {
        resolve(undefined);
      }
    });
  }

  private async get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
    if (!this.db) return this.mem[store].get(key) as T | undefined;
    return (await this.tx<T>(store, "readonly", (s) => s.get(key))) as T | undefined;
  }
  private async put(store: StoreName, value: unknown, key?: IDBValidKey) {
    if (!this.db) return void this.mem[store].set(key ?? (value as { id?: unknown; name?: unknown }).id ?? (value as { name: unknown }).name, value);
    await this.tx(store, "readwrite", (s) => (key === undefined ? s.put(value) : s.put(value, key)));
  }

  getCard = (id: number) => this.get<CachedCard>("cards", id);
  /** Unisce i campi nuovi a quelli già salvati (non perde Blob e vettori). */
  async putCard(patch: Partial<CachedCard> & { id: number }) {
    const old = (await this.getCard(patch.id)) ?? ({ id: patch.id, name: "" } as CachedCard);
    const merged = { ...old, ...patch, vec: { ...old.vec, ...patch.vec } };
    await this.put("cards", merged);
    return merged;
  }
  getDeck = (name: string) => this.get<SavedDeck>("decks", name);
  putDeck = (d: SavedDeck) => this.put("decks", d);
  async listDecks(): Promise<SavedDeck[]> {
    const all = this.db ? ((await this.tx<SavedDeck[]>("decks", "readonly", (s) => s.getAll())) ?? []) : ([...this.mem.decks.values()] as SavedDeck[]);
    return all.sort((a, b) => b.at - a.at);
  }
  getMeta = <T>(key: string) => this.get<T>("meta", key);
  putMeta = (key: string, v: unknown) => this.put("meta", v, key);
}
