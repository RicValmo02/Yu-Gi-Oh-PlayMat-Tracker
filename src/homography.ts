import { Matrix4 } from "three";
import type { Corners } from "./types";

/** Matrice 3x3 row-major. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * Omografia dal quadrato unitario ((0,0),(1,0),(1,1),(0,1)) ai 4 punti TL,TR,BR,BL
 * (soluzione chiusa di Heckbert). Equivale a cv.getPerspectiveTransform ma senza allocare Mat WASM per frame.
 */
export function squareToQuad(c: Corners): Mat3 {
  const [p0, p1, p2, p3] = c;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function mul3(a: Mat3, b: Mat3): Mat3 {
  const r = new Array(9).fill(0) as Mat3;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return r;
}

/**
 * Inserisce l'omografia in una Matrix4. La terza riga dell'omografia (w) finisce nella riga w della 4x4:
 * la camera ortografica ha ultima riga (0,0,0,1), quindi clip.w = w della nostra matrice e la GPU
 * esegue da sola la divisione prospettica (e l'interpolazione delle UV corretta per prospettiva).
 */
export function toMatrix4(m: Mat3, out: Matrix4): Matrix4 {
  return out.set(
    m[0], m[1], 0, m[2],
    m[3], m[4], 0, m[5],
    0, 0, 1, 0,
    m[6], m[7], 0, m[8],
  );
}
