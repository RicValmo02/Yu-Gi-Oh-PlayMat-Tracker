import * as THREE from "three";
import { mul3, squareToQuad, toMatrix4, type Mat3 } from "./homography";
import type { Assignment, Corners, Point, TrackedCard } from "./types";

export interface ArtParams {
  opacity: number; // 0–1
  scale: number; // 1 = dimensione della finestra artwork della carta
  lift: number; // spostamento verso l'alto, come frazione del lato lungo della carta
}
export const DEFAULT_ART: ArtParams = { opacity: 1, scale: 1, lift: 0.08 };

// Finestra artwork di una carta standard (421x614 px): quadrata 321 px, centro a (0.5, 0.442).
const CARD_W = 421;
const CARD_H = 614;
const ART_SIDE = 321;
const ART_CU = 0.5;
const ART_CV = 271.5 / CARD_H;
const SHADOW_GROW = 1.4; // l'ombra è più grande dell'artwork per contenere la sfumatura
const GHOST_MS = 5 * 60_000; // per quanto ricordare l'artwork di una carta sparita
const GHOST_RADIUS = 0.8; // distanza massima del centro per riconoscerla, in lunghezze del lato lungo
const SMOOTH_TAU_MS = 50; // costante di tempo dello smoothing lato rendering

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const shift = (c: Corners, s: number) => [0, 1, 2, 3].map((i) => c[(i + s) % 4]) as Corners;

/** Cache delle texture per cardId con conteggio dei riferimenti: più carte tracciate condividono la stessa texture. */
class TextureStore {
  private map = new Map<number, { tex: THREE.Texture; refs: number; loaded: boolean }>();
  private loader = new THREE.TextureLoader();

  constructor(private urlOf: (cardId: number) => string, private anisotropy: number) {}

  acquire(cardId: number) {
    let e = this.map.get(cardId);
    if (!e) {
      const entry = { tex: new THREE.Texture(), refs: 0, loaded: false };
      this.loader.load(
        this.urlOf(cardId),
        (t) => {
          // il loader crea una Texture propria: copiamo l'immagine in quella già distribuita ai materiali
          entry.tex.image = t.image;
          entry.tex.colorSpace = THREE.SRGBColorSpace;
          entry.tex.anisotropy = this.anisotropy;
          entry.tex.needsUpdate = true;
          t.dispose();
          entry.loaded = true;
        },
        undefined,
        () => console.warn(`Artwork non caricato: ${this.urlOf(cardId)}`),
      );
      this.map.set(cardId, entry);
      e = entry;
    }
    e.refs++;
    return e;
  }

  release(cardId: number) {
    const e = this.map.get(cardId);
    if (!e || --e.refs > 0) return;
    e.tex.dispose();
    this.map.delete(cardId);
  }
}

interface Entry {
  trackedId: number;
  cardId: number;
  flip: boolean;
  tex: { tex: THREE.Texture; loaded: boolean };
  art: THREE.Mesh;
  shadow: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  cur: Corners | null; // angoli mostrati (inseguono quelli del tracker al frame rate di rendering)
}

/** Ricordo di una carta con artwork che il tracker ha perso (es. coperta da una mano). */
interface Ghost {
  cardId: number;
  flip: boolean;
  center: Point;
  longSide: number;
  at: number;
}

const centerOf = (c: Corners): Point => ({
  x: (c[0].x + c[1].x + c[2].x + c[3].x) / 4,
  y: (c[0].y + c[1].y + c[2].y + c[3].y) / 4,
});
const longSideOf = (c: Corners) => Math.max(dist(c[0], c[1]), dist(c[1], c[2]));

/** Un piano con artwork + uno d'ombra per ogni carta tracciata a cui è stata assegnata una carta. */
export class CardLayer {
  private entries = new Map<number, Entry>();
  private textures: TextureStore;
  private geo = new THREE.PlaneGeometry(1, 1); // condivisa da tutte le mesh
  private shadowTex = makeShadowTexture();
  private shadowMat = new THREE.MeshBasicMaterial({
    map: this.shadowTex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
  });
  private m4 = new THREE.Matrix4();
  private ghosts: Ghost[] = [];
  private seen = new Set<number>(); // ID già visti: l'adozione di un ricordo vale solo per ID nuovi

  constructor(private scene: THREE.Scene, urlOf: (cardId: number) => string, anisotropy = 1) {
    this.textures = new TextureStore(urlOf, anisotropy);
  }

  get assignments(): Assignment[] {
    return [...this.entries.values()].map((e) => ({ trackedId: e.trackedId, cardId: e.cardId }));
  }
  cardIdOf(trackedId: number) {
    return this.entries.get(trackedId)?.cardId;
  }

  assign(trackedId: number, cardId: number) {
    const old = this.entries.get(trackedId);
    if (old) {
      if (old.cardId === cardId) return;
      this.textures.release(old.cardId);
      old.tex = this.textures.acquire(cardId);
      old.cardId = cardId;
      old.mat.map = old.tex.tex;
      old.mat.needsUpdate = true;
      return;
    }
    const tex = this.textures.acquire(cardId);
    const mat = new THREE.MeshBasicMaterial({
      map: tex.tex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const art = this.makeMesh(mat, 2);
    const shadow = this.makeMesh(this.shadowMat, 1);
    this.entries.set(trackedId, { trackedId, cardId, flip: false, tex, art, shadow, mat, cur: null });
  }

  unassign(trackedId: number) {
    const e = this.entries.get(trackedId);
    if (!e) return;
    this.scene.remove(e.art, e.shadow);
    e.mat.dispose(); // il materiale è per-carta; geometria e materiale d'ombra sono condivisi
    this.textures.release(e.cardId);
    this.entries.delete(trackedId);
  }

  toggleFlip(trackedId: number) {
    const e = this.entries.get(trackedId);
    if (e) e.flip = !e.flip;
  }
  isFlipped(trackedId: number) {
    return this.entries.get(trackedId)?.flip ?? false;
  }

  /** Allinea i piani alle carte tracciate: rimuove quelli orfani, aggiorna gli altri. dtMs = tempo dal frame precedente. */
  sync(cards: TrackedCard[], p: ArtParams, dtMs: number) {
    const now = performance.now();
    const alive = new Map(cards.map((c) => [c.id, c]));
    for (const id of [...this.entries.keys()]) {
      if (alive.has(id)) continue;
      this.remember(this.entries.get(id)!, now);
      this.unassign(id);
    }
    this.ghosts = this.ghosts.filter((g) => now - g.at < GHOST_MS);
    // Una carta nuova nello stesso punto di una sparita (mano tolta) eredita artwork e rotazione.
    for (const c of cards) {
      if (this.seen.has(c.id)) continue;
      this.seen.add(c.id);
      this.adopt(c);
    }
    for (const id of this.seen) if (!alive.has(id)) this.seen.delete(id);
    this.shadowMat.opacity = p.opacity * 0.45 * Math.min(1, p.lift / 0.04);
    for (const e of this.entries.values()) this.update(e, alive.get(e.trackedId)!, p, dtMs);
  }

  private remember(e: Entry, now: number) {
    if (!e.cur) return;
    const center = centerOf(e.cur);
    const longSide = longSideOf(e.cur);
    // una sola memoria per posizione: se la carta è stata sostituita, vale l'ultima
    this.ghosts = this.ghosts.filter((g) => dist(g.center, center) > longSide * 0.3);
    this.ghosts.push({ cardId: e.cardId, flip: e.flip, center, longSide, at: now });
  }

  private adopt(c: TrackedCard) {
    const center = centerOf(c.corners);
    const max = longSideOf(c.corners) * GHOST_RADIUS;
    let best = -1;
    let bestD = max;
    this.ghosts.forEach((g, i) => {
      const d = dist(g.center, center);
      if (d < bestD) (best = i), (bestD = d);
    });
    if (best < 0) return;
    const [g] = this.ghosts.splice(best, 1);
    this.assign(c.id, g.cardId);
    if (g.flip) this.toggleFlip(c.id);
  }

  /** Rimuove tutto, ricordi compresi (es. quando si ferma la webcam). */
  clear() {
    for (const id of [...this.entries.keys()]) this.unassign(id);
    this.ghosts = [];
    this.seen.clear();
  }

  private makeMesh(mat: THREE.Material, order: number) {
    const m = new THREE.Mesh(this.geo, mat);
    m.matrixAutoUpdate = false; // la matrice (con la prospettiva) la impostiamo noi
    m.frustumCulled = false; // il culling di three non conosce la divisione per w
    m.renderOrder = order;
    m.visible = false;
    this.scene.add(m);
    return m;
  }

  private update(e: Entry, card: TrackedCard, p: ArtParams, dtMs: number) {
    // Smoothing al frame rate di rendering: la visione gira a frequenza ridotta, qui si interpola.
    const target = card.corners;
    if (!e.cur) {
      e.cur = target.map((c) => ({ ...c })) as Corners;
    } else {
      const side = Math.min(dist(target[0], target[1]), dist(target[1], target[2]));
      const far = e.cur.some((c, i) => dist(c, target[i]) > side * 0.5); // salto (es. rotazione 90°): aggancio diretto
      const k = far ? 1 : 1 - Math.exp(-dtMs / SMOOTH_TAU_MS);
      e.cur = e.cur.map((c, i) => ({ x: c.x + (target[i].x - c.x) * k, y: c.y + (target[i].y - c.y) * k })) as Corners;
    }

    // Quadrato unitario = carta dritta (u lungo la larghezza, v lungo l'altezza).
    // Landscape: il lato TL→TR è quello lungo, quindi si ruota di uno; flip aggiunge 180°.
    const s = (card.orientation === "landscape" ? 1 : 0) + (e.flip ? 2 : 0);
    const base = shift(e.cur, s);

    const longSide = Math.max(dist(base[0], base[1]), dist(base[1], base[2]));
    const dy = -p.lift * longSide; // "su" nello spazio schermo
    const lifted = base.map((c) => ({ x: c.x, y: c.y + dy })) as Corners;

    const tex = e.tex.tex.image as { width: number; height: number } | undefined;
    const aspect = tex ? tex.width / tex.height : 1;
    const sx = (ART_SIDE / CARD_W) * p.scale;
    const sy = ((ART_SIDE / aspect) / CARD_H) * p.scale;

    e.art.matrix.copy(toMatrix4(mul3(squareToQuad(lifted), planeToUnit(sx, sy)), this.m4));
    e.art.matrixWorldNeedsUpdate = true;
    e.shadow.matrix.copy(toMatrix4(mul3(squareToQuad(base), planeToUnit(sx * SHADOW_GROW, sy * SHADOW_GROW)), this.m4));
    e.shadow.matrixWorldNeedsUpdate = true;

    e.mat.opacity = p.opacity;
    const ready = e.tex.loaded;
    e.art.visible = ready;
    e.shadow.visible = ready && p.lift > 0.001;
  }

  dispose() {
    this.clear();
    this.geo.dispose();
    this.shadowMat.dispose();
    this.shadowTex.dispose();
  }
}

/** Piano locale (x,y in [-0.5,0.5], y verso l'alto) → coordinate quadrato-carta (u, v con v verso il basso). */
function planeToUnit(sx: number, sy: number): Mat3 {
  return [sx, 0, ART_CU, 0, -sy, ART_CV, 0, 0, 1];
}

/** Rettangolo nero con bordi sfumati, generato una volta sola. */
function makeShadowTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const inset = size * (1 - 1 / SHADOW_GROW) / 2;
  g.shadowColor = "#000";
  g.shadowBlur = inset;
  g.fillStyle = "#000";
  g.fillRect(inset + 2, inset + 2, size - 2 * inset - 4, size - 2 * inset - 4);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
