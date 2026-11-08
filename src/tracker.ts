import type { Corners, Detection, Point, TrackedCard } from "./types";
import { orientationOf } from "./vision";

export interface TrackerParams {
  smoothing: number; // 0 = nessuno smoothing, 0.9 = molto morbido (peso del valore precedente)
  timeoutMs: number; // quanto mantenere una carta non vista
  minHits: number; // rilevamenti consecutivi prima di mostrare una nuova carta
}

export const DEFAULT_TRACKER: TrackerParams = { smoothing: 0.5, timeoutMs: 600, minHits: 3 };

interface Track extends TrackedCard {
  hits: number;
}

const center = (c: Corners): Point => ({
  x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
  y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
});
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const sideLen = (c: Corners) => Math.min(dist(c[0], c[1]), dist(c[1], c[2]));

/** Ruota ciclicamente gli angoli della detection per farli corrispondere a quelli della traccia. */
function alignCorners(prev: Corners, cur: Corners): { corners: Corners; cost: number } {
  let best = { corners: cur, cost: Infinity };
  for (let s = 0; s < 4; s++) {
    const cand = [0, 1, 2, 3].map((i) => cur[(i + s) % 4]) as Corners;
    const cost = cand.reduce((sum, c, i) => sum + dist(c, prev[i]), 0) / 4;
    if (cost < best.cost) best = { corners: cand, cost };
  }
  return best;
}

export class Tracker {
  private tracks: Track[] = [];
  private nextId = 1;

  constructor(public params: TrackerParams = { ...DEFAULT_TRACKER }) {}

  reset() {
    this.tracks = [];
  }

  /** Aggiorna con le detection del frame corrente; ritorna le carte confermate e non scadute. */
  update(detections: Detection[], now: number): TrackedCard[] {
    const { smoothing, timeoutMs } = this.params;

    // Associazione greedy per distanza tra centri, con soglia proporzionale alla carta.
    const pairs: { t: number; d: number; dist: number }[] = [];
    this.tracks.forEach((t, ti) => {
      const ct = center(t.corners);
      const maxDist = sideLen(t.corners) * 1.0;
      detections.forEach((d, di) => {
        const dd = dist(ct, center(d.corners));
        if (dd <= maxDist) pairs.push({ t: ti, d: di, dist: dd });
      });
    });
    pairs.sort((a, b) => a.dist - b.dist);
    const usedT = new Set<number>();
    const usedD = new Set<number>();

    for (const p of pairs) {
      if (usedT.has(p.t) || usedD.has(p.d)) continue;
      usedT.add(p.t);
      usedD.add(p.d);
      const t = this.tracks[p.t];
      const { corners: aligned, cost } = alignCorners(t.corners, detections[p.d].corners);
      // Se gli angoli sono lontani (es. rotazione di 90°) niente smoothing: si aggancia direttamente.
      const a = cost > sideLen(t.corners) * 0.35 ? 0 : smoothing;
      t.corners = t.corners.map((c, i) => ({
        x: c.x * a + aligned[i].x * (1 - a),
        y: c.y * a + aligned[i].y * (1 - a),
      })) as Corners;
      t.orientation = orientationOf(t.corners);
      t.lastSeen = now;
      t.hits++;
      this.confirm(t);
    }

    // Nuove tracce per le detection non associate.
    detections.forEach((d, di) => {
      if (usedD.has(di)) return;
      const t: Track = { id: 0, corners: d.corners, orientation: d.orientation, lastSeen: now, hits: 1 };
      this.confirm(t);
      this.tracks.push(t);
    });

    // Elimina le tracce scadute; una traccia non confermata che sparisce muore subito.
    this.tracks = this.tracks.filter((t) => {
      const age = now - t.lastSeen;
      return t.id !== 0 ? age <= timeoutMs : age <= 0;
    });

    return this.cards();
  }

  /** L'ID stabile si assegna solo a conferma avvenuta, così i falsi positivi non bruciano numeri. */
  private confirm(t: Track) {
    if (t.id === 0 && t.hits >= this.params.minHits) t.id = this.nextId++;
  }

  /** Carte confermate (anche quelle temporaneamente non viste, finché non scadono). */
  cards(): TrackedCard[] {
    return this.tracks
      .filter((t) => t.id !== 0)
      .map(({ id, corners, orientation, lastSeen }) => ({ id, corners, orientation, lastSeen }));
  }
}
