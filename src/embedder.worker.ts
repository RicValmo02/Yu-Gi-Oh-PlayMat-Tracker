/// <reference lib="webworker" />
import { createBackend, type EmbedBackend } from "./embedderCore";
import { ART_REGION } from "./cardGeometry";
import { MODEL, type Mode, type ModelInfo } from "./modelConfig";
import { rotate180, toModelInput, type RgbaImage } from "./preprocess";

// File wasm di ONNX Runtime Web serviti da Vite (niente CDN a runtime).
const ortMjs = new URL("../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs", import.meta.url).href;
const ortWasm = new URL("../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm", import.meta.url).href;

let backend: EmbedBackend | null = null;
let info: ModelInfo = MODEL;

export type WorkerIn =
  | { type: "init"; model: ModelInfo; device: "webgpu" | "wasm"; localModelPath?: string }
  | { type: "embed"; id: number; rgba: ArrayBuffer; w: number; h: number; mode: Mode };

export type WorkerOut =
  | { type: "progress"; file: string; progress: number }
  | { type: "ready"; device: string; name: string }
  | { type: "error"; id?: number; message: string }
  | { type: "result"; id: number; vectors: [Float32Array, Float32Array]; ms: number };

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = async (ev: MessageEvent<WorkerIn>) => {
  const m = ev.data;
  try {
    if (m.type === "init") {
      info = m.model;
      // WebGPU solo se esiste davvero un adattatore (navigator.gpu può esserci senza GPU utilizzabile).
      let device = m.device;
      if (device === "webgpu") {
        const adapter = await (navigator as any).gpu?.requestAdapter?.().catch(() => null);
        if (!adapter) device = "wasm";
      }
      backend = await createBackend(info, {
        device,
        localModelPath: m.localModelPath,
        onProgress: (p) => post({ type: "progress", ...p }),
        configureOrt: (ort) => {
          ort.wasm.wasmPaths = { mjs: ortMjs, wasm: ortWasm };
        },
      });
      post({ type: "ready", device: backend.device, name: backend.name });
    } else if (m.type === "embed") {
      if (!backend) throw new Error("modello non inizializzato");
      const t0 = performance.now();
      const img: RgbaImage = { data: new Uint8ClampedArray(m.rgba), width: m.w, height: m.h };
      const region = m.mode === "art" ? ART_REGION : null;
      // Due varianti: immagine raddrizzata e ruotata di 180° (ambiguità degli angoli).
      const v0 = await backend.embed(toModelInput(img, region, info.input));
      const v180 = await backend.embed(toModelInput(rotate180(img), region, info.input));
      post({ type: "result", id: m.id, vectors: [v0, v180], ms: performance.now() - t0 }, [v0.buffer, v180.buffer]);
    }
  } catch (e) {
    post({ type: "error", id: m.type === "embed" ? m.id : undefined, message: e instanceof Error ? e.message : String(e) });
  }
};
