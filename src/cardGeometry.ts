/**
 * Geometria della carta: UNICO punto in cui sono definite le dimensioni dell'immagine frontale
 * e la regione dell'illustrazione. Usato da cardLayer (posizione dell'artwork), identifier/worker
 * (ritaglio per l'embedding) e dagli script offline.
 *
 * Riferimento: immagine di carta YGOPRODeck 421 x 614 px; la finestra dell'illustrazione è un
 * quadrato di 321 px con angolo in alto a sinistra a (50, 111).
 */
export const CARD_PX = { w: 421, h: 614 } as const;

/** Regione artwork in pixel dell'immagine 421x614. */
export const ART_BOX_PX = { x: 50, y: 111, w: 321, h: 321 } as const;

/** Regione relativa (0–1) a larghezza/altezza della carta: valida a qualsiasi risoluzione. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const ART_REGION: Region = {
  x: ART_BOX_PX.x / CARD_PX.w,
  y: ART_BOX_PX.y / CARD_PX.h,
  w: ART_BOX_PX.w / CARD_PX.w,
  h: ART_BOX_PX.h / CARD_PX.h,
};

/** Centro della finestra artwork in coordinate relative (u, v), v verso il basso. */
export const ART_CENTER = { u: ART_REGION.x + ART_REGION.w / 2, v: ART_REGION.y + ART_REGION.h / 2 } as const;
