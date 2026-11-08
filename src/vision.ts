import type { Corners, Detection, Orientation, Point } from "./types";

// Il pacchetto è caricato con import dinamico (chunk separato, ~13 MB con il wasm incorporato).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

/** Carica OpenCV.js gestendo le varie forme in cui il modulo si presenta (Promise / già pronto / callback). */
export async function loadCv(): Promise<CV> {
  const mod = await import("@techstark/opencv-js");
  let cv: CV = (mod as CV).default ?? mod;
  if (cv instanceof Promise) return await cv;
  if (!cv.Mat) {
    await new Promise<void>((resolve) => {
      cv.onRuntimeInitialized = () => resolve();
    });
  }
  return cv;
}

export interface VisionParams {
  scale: number; // fattore di riduzione del frame (0.2–1)
  canny1: number;
  canny2: number;
  closeSize: number; // lato kernel della chiusura morfologica (px, dispari)
  minAreaPct: number; // area minima, % del frame
  maxAreaPct: number; // area massima, % del frame
  ratioTol: number; // tolleranza relativa sul rapporto corto/lungo
  maxHz: number; // frequenza massima di rilevamento
}

export const DEFAULT_VISION: VisionParams = {
  scale: 0.5,
  canny1: 50,
  canny2: 150,
  closeSize: 5,
  minAreaPct: 1,
  maxAreaPct: 40,
  ratioTol: 0.15,
  maxHz: 15,
};

/** Rapporto corto/lungo di una carta Yu-Gi-Oh!: 59 x 86 mm. */
export const CARD_RATIO = 59 / 86;

export interface DetectResult {
  detections: Detection[];
  rejected: Point[][]; // quadrilateri convessi scartati dai filtri (coordinate video), per il debug
  ms: number;
}

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** Ordina 4 punti in TL, TR, BR, BL (orario nell'immagine, partendo dal più vicino all'angolo in alto a sinistra). */
export function orderCorners(pts: Point[]): Corners {
  const cx = pts.reduce((s, p) => s + p.x, 0) / 4;
  const cy = pts.reduce((s, p) => s + p.y, 0) / 4;
  // y verso il basso: angolo crescente = senso orario a schermo
  const sorted = [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((i) => sorted[(start + i) % 4]) as Corners;
}

export function orientationOf(c: Corners): Orientation {
  const w = (dist(c[0], c[1]) + dist(c[3], c[2])) / 2;
  const h = (dist(c[0], c[3]) + dist(c[1], c[2])) / 2;
  return w <= h ? "portrait" : "landscape";
}

export class CardDetector {
  private work = document.createElement("canvas");
  private wctx = this.work.getContext("2d", { willReadFrequently: true })!;

  constructor(private cv: CV) {}

  /**
   * Esegue la pipeline su un frame. Se `debugCanvas` è passato, ci disegna la mappa dei bordi
   * (dopo la chiusura) con i quadrilateri accettati (verde) e scartati (rosso).
   */
  detect(video: HTMLVideoElement, p: VisionParams, debugCanvas?: HTMLCanvasElement): DetectResult {
    const cv = this.cv;
    const t0 = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const w = Math.max(32, Math.round(vw * p.scale));
    const h = Math.max(32, Math.round(vh * p.scale));
    if (this.work.width !== w || this.work.height !== h) {
      this.work.width = w;
      this.work.height = h;
    }
    this.wctx.drawImage(video, 0, 0, w, h);

    // Ogni Mat/Vector creata passa da qui e viene liberata nel finally.
    const trash: { delete(): void }[] = [];
    const own = <T extends { delete(): void }>(x: T): T => (trash.push(x), x);

    const detections: Detection[] = [];
    const rejected: Point[][] = [];
    const accepted: Point[][] = [];
    const inv = 1 / p.scale; // da coordinate ridotte a coordinate video
    const frameArea = w * h;

    try {
      const rgba = own(cv.matFromImageData(this.wctx.getImageData(0, 0, w, h)));
      const gray = own(new cv.Mat());
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
      const edges = own(new cv.Mat());
      cv.Canny(gray, edges, p.canny1, p.canny2);
      const k = Math.max(1, p.closeSize | 1);
      const kernel = own(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(k, k)));
      cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);

      const contours = own(new cv.MatVector());
      const hierarchy = own(new cv.Mat());
      cv.findContours(edges, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i); // ogni get() alloca una nuova Mat
        const approx = new cv.Mat();
        try {
          const area0 = cv.contourArea(cnt);
          if (area0 < frameArea * (p.minAreaPct / 100) * 0.5) continue; // scarto rapido prima di approx
          cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true);
          if (approx.rows !== 4 || !cv.isContourConvex(approx)) continue;

          const raw: Point[] = [];
          for (let j = 0; j < 4; j++) raw.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
          const corners = orderCorners(raw);
          const area = cv.contourArea(approx);
          const a = frameArea / 100;
          const wEdge = (dist(corners[0], corners[1]) + dist(corners[3], corners[2])) / 2;
          const hEdge = (dist(corners[0], corners[3]) + dist(corners[1], corners[2])) / 2;
          const ratio = Math.min(wEdge, hEdge) / Math.max(wEdge, hEdge);
          const ok =
            area >= a * p.minAreaPct &&
            area <= a * p.maxAreaPct &&
            Math.abs(ratio - CARD_RATIO) / CARD_RATIO <= p.ratioTol; // vale anche per la carta ruotata

          if (ok) {
            accepted.push(corners);
            const full = corners.map((c) => ({ x: c.x * inv, y: c.y * inv })) as Corners;
            detections.push({ corners: full, orientation: orientationOf(full) });
          } else {
            rejected.push(corners.map((c) => ({ x: c.x * inv, y: c.y * inv })));
          }
        } finally {
          cnt.delete();
          approx.delete();
        }
      }

      if (debugCanvas) {
        cv.imshow(debugCanvas, edges); // ridimensiona il canvas alle dimensioni di `edges`
        const dctx = debugCanvas.getContext("2d")!;
        dctx.lineWidth = 2;
        const poly = (pts: Point[], color: string) => {
          dctx.strokeStyle = color;
          dctx.beginPath();
          pts.forEach((q, n) => (n ? dctx.lineTo(q.x, q.y) : dctx.moveTo(q.x, q.y)));
          dctx.closePath();
          dctx.stroke();
        };
        for (const r of rejected) poly(r.map((q) => ({ x: q.x * p.scale, y: q.y * p.scale })), "#f44");
        for (const r of accepted) poly(r, "#4f4");
      }
    } finally {
      for (const m of trash) m.delete();
    }
    return { detections, rejected, ms: performance.now() - t0 };
  }
}
