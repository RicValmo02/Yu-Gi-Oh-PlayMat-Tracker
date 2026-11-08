import { CARD_PX } from "./cardGeometry";
import type { CV } from "./vision";
import type { Corners, Orientation } from "./types";

export interface RectifiedCard {
  rgba: Uint8ClampedArray;
  w: number;
  h: number;
  ms: number;
}

/** Raddrizza una carta tracciata in un'immagine frontale CARD_PX (421x614) con cv.warpPerspective. */
export class Rectifier {
  private canvas = document.createElement("canvas");
  private ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;

  constructor(private cv: CV) {}

  rectify(video: HTMLVideoElement, corners: Corners, orientation: Orientation): RectifiedCard | null {
    const cv = this.cv;
    const t0 = performance.now();
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return null;

    // Landscape: il lato TL→TR è quello lungo, quindi la carta dritta parte dall'angolo successivo (come in cardLayer).
    const s = orientation === "landscape" ? 1 : 0;
    const c = [0, 1, 2, 3].map((i) => corners[(i + s) % 4]);

    // Copiamo solo il rettangolo che contiene la carta: molto più leggero di un frame 4K intero.
    const pad = 4;
    const bx = Math.max(0, Math.floor(Math.min(...c.map((p) => p.x))) - pad);
    const by = Math.max(0, Math.floor(Math.min(...c.map((p) => p.y))) - pad);
    const bw = Math.min(vw, Math.ceil(Math.max(...c.map((p) => p.x))) + pad) - bx;
    const bh = Math.min(vh, Math.ceil(Math.max(...c.map((p) => p.y))) + pad) - by;
    if (bw < 8 || bh < 8) return null;
    this.canvas.width = bw;
    this.canvas.height = bh;
    this.ctx.drawImage(video, bx, by, bw, bh, 0, 0, bw, bh);

    const trash: { delete(): void }[] = [];
    const own = <T extends { delete(): void }>(x: T): T => (trash.push(x), x);
    try {
      const src = own(cv.matFromImageData(this.ctx.getImageData(0, 0, bw, bh)));
      const { w, h } = CARD_PX;
      const from = own(cv.matFromArray(4, 1, cv.CV_32FC2, c.flatMap((p) => [p.x - bx, p.y - by])));
      const to = own(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, w, 0, w, h, 0, h]));
      const M = own(cv.getPerspectiveTransform(from, to));
      const dst = own(new cv.Mat());
      cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_REPLICATE);
      return { rgba: new Uint8ClampedArray(dst.data), w, h, ms: performance.now() - t0 };
    } finally {
      for (const m of trash) m.delete();
    }
  }
}
