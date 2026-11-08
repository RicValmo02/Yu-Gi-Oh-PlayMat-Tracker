import type { Candidate, EmbeddingDb } from "./db";
import type { EmbedResult } from "./embedder";
import type { Mode } from "./modelConfig";
import { l2normalize } from "./preprocess";
import type { RectifiedCard } from "./rectify";
import type { Corners, Point, TrackedCard } from "./types";

/**
 * pending    = campionamento in corso / mai provata
 * identified = carta riconosciuta con confidenza sufficiente
 * uncertain  = primo e secondo candidato troppo vicini
 * unknown    = punteggio sotto soglia
 * covered    = la miglior corrispondenza è il dorso (carta coperta)
 */
export type IdStatus = "pending" | "identified" | "uncertain" | "unknown" | "covered";

export interface Identification {
  trackedId: number;
  status: IdStatus;
  candidates: Candidate[]; // primi 3
  cardId?: number; // solo se identified
  flip: boolean; // true = l'artwork va ruotato di 180° rispetto agli angoli del tracker
  manual: boolean; // scelta a mano: non viene più toccata dall'identificazione automatica
  sampling?: { done: number; total: number };
}

export interface IdentParams {
  threshold: number; // punteggio coseno minimo per accettare il primo candidato
  margin: number; // distacco minimo tra primo e secondo candidato
  frames: number; // frame raccolti per la votazione (media degli embedding)
  intervalMs: number; // pausa tra un campione e il successivo
  retryMs: number; // dopo quanto riprovare una carta sconosciuta/incerta
  backRecheckMs: number; // ogni quanto ricontrollare una carta coperta
  mode: Mode;
}

export const DEFAULT_IDENT: IdentParams = {
  threshold: 0.5,
  margin: 0.04,
  frames: 6,
  intervalMs: 150,
  retryMs: 3000,
  backRecheckMs: 2000,
  mode: "art",
};

export interface IdentDeps {
  rectify(card: TrackedCard): RectifiedCard | null;
  embed(frame: RectifiedCard, mode: Mode): Promise<EmbedResult>;
  db(mode: Mode): EmbeddingDb | null; // null finché il database non è caricato
}

export interface IdentTimings {
  rectify: number;
  embed: number;
  search: number;
}

type Sample = [Float32Array, Float32Array];

interface Round {
  samples: Sample[];
  keep: boolean; // true = verifica di un'identità già nota: se fallisce, la si mantiene
}

interface State extends Identification {
  card: TrackedCard;
  orientation: TrackedCard["orientation"]; // orientamento (etichetta del tracker) al momento del flip
  round: Round | null;
  nextTryAt: number;
  lastSample: number;
  prevCorners: Corners | null;
  stable: boolean;
}

interface Ghost {
  snapshot: Pick<State, "status" | "candidates" | "cardId" | "flip" | "manual" | "orientation">;
  center: Point;
  longSide: number;
  at: number;
}

const GHOST_MS = 5 * 60_000;
const GHOST_RADIUS = 0.8; // in lunghezze del lato lungo
const VISIBLE_MS = 150; // la carta deve essere stata vista di recente (altrimenti è coperta da una mano)
const STABLE_MOTION = 0.03; // spostamento massimo degli angoli tra due update, in frazione del lato corto

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const centerOf = (c: Corners): Point => ({
  x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
  y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
});
const longSideOf = (c: Corners) => Math.max(dist(c[0], c[1]), dist(c[1], c[2]));
const shortSideOf = (c: Corners) => Math.min(dist(c[0], c[1]), dist(c[1], c[2]));

function meanUnit(vs: Float32Array[]): Float32Array {
  const out = new Float32Array(vs[0].length);
  for (const v of vs) for (let i = 0; i < out.length; i++) out[i] += v[i];
  return l2normalize(out);
}

/**
 * Identifica le carte tracciate. Una carta nuova (o riassegnata dal tracker) avvia un "round":
 * si raccolgono `frames` embedding a intervalli, si fa la media, si cerca nel database sia per
 * l'immagine raddrizzata sia per quella ruotata di 180° e si tiene la migliore.
 * L'identità resta finché il tracker mantiene la carta; se sparisce (mano) e riappare nello stesso
 * punto la si eredita e la si ricontrolla senza mostrare sfarfallii.
 */
export class Identifier {
  private states = new Map<number, State>();
  private ghosts: Ghost[] = [];
  private busy = false;
  readonly timings: IdentTimings = { rectify: 0, embed: 0, search: 0 };
  lastError = "";

  constructor(private deps: IdentDeps, public params: IdentParams = { ...DEFAULT_IDENT }) {}

  get(trackedId: number): Identification | undefined {
    return this.states.get(trackedId);
  }

  clear() {
    this.states.clear();
    this.ghosts = [];
  }

  /** Da chiamare a ogni frame: sincronizza con il tracker e, se libero, lancia al massimo un lavoro. */
  update(cards: TrackedCard[], now: number) {
    const alive = new Set(cards.map((c) => c.id));

    for (const [id, st] of this.states) {
      if (alive.has(id)) continue;
      if (st.status === "identified" || st.status === "covered" || st.manual) this.remember(st, now);
      this.states.delete(id);
    }
    this.ghosts = this.ghosts.filter((g) => now - g.at < GHOST_MS);

    for (const card of cards) {
      let st = this.states.get(card.id);
      if (!st) {
        st = {
          trackedId: card.id, status: "pending", candidates: [], flip: false, manual: false,
          card, orientation: card.orientation, round: null, nextTryAt: 0, lastSample: 0, prevCorners: null, stable: false,
        };
        this.states.set(card.id, st);
        this.adopt(st, card, now);
      }
      st.card = card;
      const side = shortSideOf(card.corners);
      st.stable = !st.prevCorners || st.prevCorners.every((p, i) => dist(p, card.corners[i]) < side * STABLE_MOTION);
      st.prevCorners = card.corners.map((c) => ({ ...c })) as Corners;

      // L'etichetta di orientamento è cambiata (es. carta girata in difesa): l'orientamento dell'artwork va riverificato.
      if (st.status === "identified" && !st.manual && !st.round && st.orientation !== card.orientation) st.nextTryAt = now;
    }

    if (!this.busy) {
      const next = this.pick(now);
      if (next) void this.run(next, now);
    }
  }

  // ---- override manuale ----
  /** Assegna a mano una carta (o nessuna con null). Resta finché la carta è tracciata. */
  override(trackedId: number, cardId: number | null) {
    const st = this.states.get(trackedId);
    if (!st) return;
    st.manual = true;
    st.round = null;
    st.nextTryAt = Infinity;
    st.sampling = undefined;
    st.cardId = cardId ?? undefined;
    st.status = cardId === null ? "unknown" : "identified";
  }

  toggleFlip(trackedId: number) {
    const st = this.states.get(trackedId);
    if (st) st.flip = !st.flip;
  }

  /** Riparte da zero per tutte le carte non assegnate a mano (es. dopo il cambio di modalità). */
  reidentifyAll() {
    for (const st of this.states.values()) if (!st.manual) this.reidentify(st.trackedId);
  }

  /** Cancella l'identità e riparte da zero. */
  reidentify(trackedId: number) {
    const st = this.states.get(trackedId);
    if (!st) return;
    Object.assign(st, { status: "pending", candidates: [], cardId: undefined, manual: false, round: null, nextTryAt: 0, sampling: undefined });
  }

  // ---- interno ----
  private remember(st: State, now: number) {
    const center = centerOf(st.card.corners);
    const longSide = longSideOf(st.card.corners);
    this.ghosts = this.ghosts.filter((g) => dist(g.center, center) > longSide * 0.3); // una sola memoria per posizione
    const { status, candidates, cardId, flip, manual, orientation } = st;
    this.ghosts.push({ snapshot: { status, candidates, cardId, flip, manual, orientation }, center, longSide, at: now });
  }

  /** Carta nuova nello stesso punto di una sparita (mano tolta): eredita l'identità e la ricontrolla. */
  private adopt(st: State, card: TrackedCard, now: number) {
    const center = centerOf(card.corners);
    let best = -1;
    let bestD = longSideOf(card.corners) * GHOST_RADIUS;
    this.ghosts.forEach((g, i) => {
      const d = dist(g.center, center);
      if (d < bestD) (best = i), (bestD = d);
    });
    if (best < 0) return;
    const [g] = this.ghosts.splice(best, 1);
    Object.assign(st, g.snapshot);
    st.nextTryAt = g.snapshot.manual ? Infinity : now; // verifica in silenzio: l'identità resta visibile
  }

  private pick(now: number): State | null {
    const { params } = this;
    if (!this.deps.db(params.mode)) return null;
    let best: State | null = null;
    for (const st of this.states.values()) {
      if (st.manual || !st.stable) continue;
      if (now - st.card.lastSeen > VISIBLE_MS) continue; // coperta da una mano: non identificare
      const due = st.round ? now - st.lastSample >= params.intervalMs : now >= st.nextTryAt;
      if (!due) continue;
      // priorità: round già avviati, poi chi aspetta da più tempo
      if (!best || (st.round && !best.round) || (!!st.round === !!best.round && st.nextTryAt < best.nextTryAt)) best = st;
    }
    return best;
  }

  private async run(st: State, now: number) {
    this.busy = true;
    const { params } = this;
    try {
      if (!st.round) {
        st.round = { samples: [], keep: st.status === "identified" };
        st.nextTryAt = Infinity;
      }
      const frame = this.deps.rectify(st.card);
      if (!frame) {
        st.lastSample = now;
        return;
      }
      this.timings.rectify = ema(this.timings.rectify, frame.ms);
      const r = await this.deps.embed(frame, params.mode);
      this.timings.embed = ema(this.timings.embed, r.ms);
      if (this.states.get(st.trackedId) !== st || !st.round) return; // sparita o resettata nel frattempo
      st.round.samples.push(r.vectors);
      st.lastSample = performance.now();
      st.sampling = { done: st.round.samples.length, total: params.frames };
      if (st.round.samples.length >= params.frames) this.finalize(st);
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      console.error("Identificazione fallita:", e);
      st.round = null;
      st.sampling = undefined;
      st.nextTryAt = performance.now() + params.retryMs;
    } finally {
      this.busy = false;
    }
  }

  private finalize(st: State) {
    const { params } = this;
    const round = st.round!;
    const db = this.deps.db(params.mode);
    st.round = null;
    st.sampling = undefined;
    const t = performance.now();
    if (!db) {
      st.nextTryAt = t + params.retryMs;
      return;
    }

    // Media degli embedding dei frame (riduce l'effetto di riflessi che cambiano) per ciascun orientamento.
    const found0 = db.search(meanUnit(round.samples.map((s) => s[0])), 3);
    const found180 = db.search(meanUnit(round.samples.map((s) => s[1])), 3);
    this.timings.search = ema(this.timings.search, performance.now() - t);
    const useFlip = (found180[0]?.score ?? -1) > (found0[0]?.score ?? -1);
    const cands = useFlip ? found180 : found0;
    const [top1, top2] = cands;

    let status: IdStatus;
    if (!top1 || top1.score < params.threshold) status = "unknown";
    else if (top1.cardId < 0) status = "covered";
    else if (top2 && top1.score - top2.score < params.margin) status = "uncertain";
    else status = "identified";

    const now = performance.now();
    st.orientation = st.card.orientation;
    if (round.keep && status !== "identified" && status !== "covered") {
      st.nextTryAt = Infinity; // verifica non conclusiva: si tiene l'identità già nota
      return;
    }
    st.status = status;
    st.candidates = cands;
    st.cardId = status === "identified" ? top1.cardId : undefined;
    if (status === "identified") st.flip = useFlip;
    st.nextTryAt = status === "identified" ? Infinity : now + (status === "covered" ? params.backRecheckMs : params.retryMs);
  }
}

const ema = (prev: number, x: number) => (prev ? prev * 0.8 + x * 0.2 : x);
