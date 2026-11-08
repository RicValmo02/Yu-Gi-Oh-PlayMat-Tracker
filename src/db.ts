import type { EmbeddingIndex, IndexCard, Mode } from "./modelConfig";

export interface Candidate {
  cardId: number; // negativo = dorso
  name: string;
  score: number; // similarità coseno
}

const base = () => import.meta.env.BASE_URL + "embeddings/";

export async function loadIndex(): Promise<EmbeddingIndex | null> {
  try {
    const r = await fetch(base() + "index.json", { cache: "no-cache" });
    return r.ok ? ((await r.json()) as EmbeddingIndex) : null;
  } catch {
    return null;
  }
}

/** Database di embedding in memoria (int8) con ricerca per prodotto scalare su tutte le righe. */
export class EmbeddingDb {
  private constructor(
    readonly mode: Mode,
    readonly dim: number,
    readonly cards: IndexCard[],
    private invNorm: Float32Array,
    private q: Int8Array,
  ) {}

  static async load(index: EmbeddingIndex, mode: Mode): Promise<EmbeddingDb | null> {
    const file = index.files[mode];
    if (!file) return null;
    const r = await fetch(base() + file);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    const n = index.cards.length;
    const invNorm = new Float32Array(buf, 0, n);
    const q = new Int8Array(buf, n * 4, n * index.model.dim);
    return new EmbeddingDb(mode, index.model.dim, index.cards, invNorm, q);
  }

  /** Costruisce un database in memoria da vettori unitari (es. le carte di un mazzo). null = riga senza vettore. */
  static fromVectors(mode: Mode, dim: number, cards: IndexCard[], vectors: (Float32Array | null)[]): EmbeddingDb {
    const n = cards.length;
    const inv = new Float32Array(n);
    const q = new Int8Array(n * dim);
    vectors.forEach((v, r) => {
      if (!v) return;
      let max = 0;
      for (const x of v) max = Math.max(max, Math.abs(x));
      let norm = 0;
      for (let i = 0; i < dim; i++) {
        const qi = Math.round((v[i] / (max || 1)) * 127);
        q[r * dim + i] = qi;
        norm += qi * qi;
      }
      inv[r] = 1 / Math.sqrt(norm || 1);
    });
    return new EmbeddingDb(mode, dim, cards, inv, q);
  }

  get size() {
    return this.cards.length;
  }

  get byteSize() {
    return this.q.byteLength + this.invNorm.byteLength;
  }

  /** Primi k candidati (carte distinte; i dorsi sono fusi in un'unica voce "Dorso"). query: vettore unitario. */
  search(query: Float32Array, k = 3): Candidate[] {
    const { dim, q, invNorm, cards } = this;
    const n = cards.length;
    const top: Candidate[] = [];
    let bestBack: Candidate | null = null;
    let worst = -Infinity; // soglia per entrare nella top-k
    for (let r = 0; r < n; r++) {
      const inv = invNorm[r];
      if (inv === 0) continue; // riga senza vettore
      let s = 0;
      const o = r * dim;
      for (let i = 0; i < dim; i++) s += query[i] * q[o + i];
      s *= inv;
      const card = cards[r];
      if (card.back) {
        if (!bestBack || s > bestBack.score) bestBack = { cardId: -1, name: "Dorso", score: s };
        continue;
      }
      if (top.length < k || s > worst) {
        top.push({ cardId: card.id, name: card.name, score: s });
        top.sort((a, b) => b.score - a.score);
        if (top.length > k) top.pop();
        worst = top.length === k ? top[k - 1].score : -Infinity;
      }
    }
    if (bestBack) top.push(bestBack);
    top.sort((a, b) => b.score - a.score);
    return top.slice(0, k);
  }
}
