export interface Point {
  x: number;
  y: number;
}

/** Quattro angoli in ordine orario a partire da quello in alto a sinistra dell'immagine: TL, TR, BR, BL. */
export type Corners = [Point, Point, Point, Point];

/**
 * "portrait": il lato TL→TR è quello corto (carta in piedi, posizione di attacco).
 * "landscape": il lato TL→TR è quello lungo (carta ruotata di 90°, difesa).
 */
export type Orientation = "portrait" | "landscape";

/** Rettangolo grezzo rilevato in un singolo frame, in pixel del video. */
export interface Detection {
  corners: Corners;
  orientation: Orientation;
}

/** Carta tracciata nel tempo. Coordinate in pixel del video; lastSeen in ms (performance.now). */
export interface TrackedCard {
  id: number;
  corners: Corners;
  orientation: Orientation;
  lastSeen: number;
}

/** Associazione tra una carta tracciata (ID del tracker) e una carta del database scelta a mano. */
export interface Assignment {
  trackedId: number;
  cardId: number;
}

/** Voce di public/cards/cards.json (scritta da scripts/download-cards.ts). */
export interface CardInfo {
  id: number;
  name: string;
  type: string;
  attribute?: string;
  race?: string;
  level?: number;
  atk?: number;
  def?: number;
  desc?: string;
  art: string; // percorso relativo a BASE_URL
}
