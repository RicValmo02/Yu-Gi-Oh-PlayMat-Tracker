import { MODEL, type ModelInfo } from "./modelConfig";
import { l2normalize } from "./preprocess";

/** Backend di embedding: stesso codice nel worker del browser e nello script Node. */
export interface EmbedBackend {
  readonly name: string;
  readonly device: string;
  /** chw: Float32Array 3 x input x input già normalizzato. Ritorna un vettore unitario. */
  embed(chw: Float32Array): Promise<Float32Array>;
}

export interface BackendOptions {
  device?: "webgpu" | "wasm" | "cpu";
  onProgress?: (p: { file: string; progress: number }) => void;
  /** Cartella locale con il modello (solo test offline): niente download da Hugging Face. */
  localModelPath?: string;
  /** Callback per configurare ONNX Runtime Web (percorsi dei file wasm) prima della creazione della sessione. */
  configureOrt?: (ortEnv: any) => void;
}

/** Backend "thumb": miniatura 8x8 a colori. Solo per i test della pipeline, senza scaricare il modello. */
function thumbBackend(info: ModelInfo): EmbedBackend {
  const grid = 8;
  return {
    name: "thumb",
    device: "cpu",
    async embed(chw) {
      const s = info.input;
      const cell = s / grid;
      const out = new Float32Array(grid * grid * 3);
      for (let c = 0; c < 3; c++)
        for (let gy = 0; gy < grid; gy++)
          for (let gx = 0; gx < grid; gx++) {
            let sum = 0;
            for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) sum += chw[c * s * s + (gy * cell + y) * s + gx * cell + x];
            out[(c * grid + gy) * grid + gx] = sum / (cell * cell);
          }
      const mean = out.reduce((a, b) => a + b, 0) / out.length;
      for (let i = 0; i < out.length; i++) out[i] -= mean;
      return l2normalize(out);
    },
  };
}

export async function createBackend(info: ModelInfo = MODEL, opts: BackendOptions = {}): Promise<EmbedBackend> {
  if (info.backend === "thumb") return thumbBackend(info);

  const tf: any = await import("@huggingface/transformers");
  const { AutoModel, Tensor, env } = tf;
  if (opts.localModelPath) {
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = opts.localModelPath;
  }
  opts.configureOrt?.(env.backends.onnx);

  const order: ("webgpu" | "wasm" | "cpu")[] = opts.device ? [opts.device] : ["wasm"];
  if (opts.device === "webgpu") order.push("wasm"); // fallback
  let lastErr: unknown;
  for (const device of order) {
    try {
      const model = await AutoModel.from_pretrained(info.id, {
        device,
        dtype: info.dtype,
        progress_callback: (p: any) => {
          if (p?.status === "progress" && opts.onProgress) opts.onProgress({ file: p.file, progress: p.progress });
        },
      });
      const size = info.input;
      return {
        name: `${info.id} (${info.dtype})`,
        device,
        async embed(chw) {
          const input = new Tensor("float32", chw, [1, 3, size, size]);
          const out = await model({ pixel_values: input });
          const t = out.last_hidden_state ?? Object.values(out)[0];
          const data: Float32Array = typeof t.getData === "function" ? await t.getData() : t.data;
          const cls = Float32Array.from(data.subarray(0, info.dim)); // token CLS
          for (const o of Object.values(out) as any[]) o.dispose?.();
          return l2normalize(cls);
        },
      };
    } catch (e) {
      lastErr = e;
      console.warn(`Backend ${device} non disponibile:`, e);
    }
  }
  throw lastErr;
}
