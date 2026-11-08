/** Configurazione del modello di embedding, condivisa da browser (worker) e script offline. */
export const MODEL = {
  backend: "dinov2" as "dinov2" | "thumb",
  id: "Xenova/dinov2-small", // DINOv2 ViT-S/14, export ONNX per Transformers.js
  dtype: "fp32",
  dim: 384, // CLS token dell'ultimo strato
  input: 224, // lato dell'immagine in ingresso (squash, senza crop al centro)
};

/** Normalizzazione ImageNet usata da DINOv2. */
export const MEAN = [0.485, 0.456, 0.406];
export const STD = [0.229, 0.224, 0.225];

export type Mode = "art" | "full";

export type ModelInfo = { backend: "dinov2" | "thumb"; id: string; dtype: string; dim: number; input: number };

export interface IndexCard {
  id: number; // id YGOPRODeck; negativo = dorso
  name: string;
  type?: string;
  atk?: number | null;
  def?: number | null;
  level?: number | null;
  attribute?: string;
  back?: boolean;
}

/** public/embeddings/index.json */
export interface EmbeddingIndex {
  version: 1;
  model: ModelInfo;
  modes: Mode[];
  /** file dei vettori per modalità; layout: Float32[N] (1/norma della riga int8) + Int8[N*dim] */
  files: Partial<Record<Mode, string>>;
  cards: IndexCard[];
}
