import { MEAN, STD } from "./modelConfig";
import type { Region } from "./cardGeometry";

/** Preprocessing identico in browser (worker) e in Node: stesso codice, nessun resampler di libreria. */
export interface RgbaImage {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

export function rotate180(img: RgbaImage): RgbaImage {
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(img.data.length);
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const j = (n - 1 - i) * 4;
    const k = i * 4;
    out[j] = img.data[k];
    out[j + 1] = img.data[k + 1];
    out[j + 2] = img.data[k + 2];
    out[j + 3] = img.data[k + 3];
  }
  return { data: out, width: w, height: h };
}

/**
 * Ritaglia `region` (relativa, null = immagine intera), ridimensiona a size x size con media ad area
 * (filtro box frazionario, antialias corretto in riduzione) e normalizza. Ritorna CHW float32.
 */
export function toModelInput(img: RgbaImage, region: Region | null, size: number): Float32Array {
  const { width: W, height: H, data } = img;
  const r = region ?? { x: 0, y: 0, w: 1, h: 1 };
  const sx = Math.max(0, r.x * W);
  const sy = Math.max(0, r.y * H);
  const sw = Math.min(W - sx, r.w * W);
  const sh = Math.min(H - sy, r.h * H);
  const out = new Float32Array(3 * size * size);
  const plane = size * size;
  const stepX = sw / size;
  const stepY = sh / size;
  for (let dy = 0; dy < size; dy++) {
    const y0 = sy + dy * stepY;
    const y1 = y0 + stepY;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(H, Math.ceil(y1));
    for (let dx = 0; dx < size; dx++) {
      const x0 = sx + dx * stepX;
      const x1 = x0 + stepX;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(W, Math.ceil(x1));
      let rs = 0, gs = 0, bs = 0, ws = 0;
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y1, y + 1) - Math.max(y0, y);
        for (let x = ix0; x < ix1; x++) {
          const w = wy * (Math.min(x1, x + 1) - Math.max(x0, x));
          const p = (y * W + x) * 4;
          rs += data[p] * w;
          gs += data[p + 1] * w;
          bs += data[p + 2] * w;
          ws += w;
        }
      }
      const o = dy * size + dx;
      out[o] = (rs / ws / 255 - MEAN[0]) / STD[0];
      out[plane + o] = (gs / ws / 255 - MEAN[1]) / STD[1];
      out[2 * plane + o] = (bs / ws / 255 - MEAN[2]) / STD[2];
    }
  }
  return out;
}

export function l2normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}
