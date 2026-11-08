import type { Mode, ModelInfo } from "./modelConfig";
import type { WorkerIn, WorkerOut } from "./embedder.worker";

export interface EmbedResult {
  /** vettori unitari: [immagine raddrizzata, ruotata di 180°] */
  vectors: [Float32Array, Float32Array];
  ms: number;
}

/** Client del Web Worker che esegue il modello: il thread principale non si blocca durante l'inferenza. */
export class Embedder {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: EmbedResult) => void; reject: (e: Error) => void }>();
  private initWaiter: { resolve: (v: { device: string; name: string }) => void; reject: (e: Error) => void } | null = null;
  ready = false;
  device = "";
  /** Progresso di scaricamento 0–100 (media sui file in corso). */
  private files = new Map<string, number>();
  onProgress: ((percent: number) => void) | null = null;

  constructor() {
    this.spawn();
  }

  private spawn() {
    this.worker?.terminate();
    this.worker = new Worker(new URL("./embedder.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<WorkerOut>) => {
      const m = ev.data;
      if (m.type === "progress") {
        this.files.set(m.file, m.progress);
        const vals = [...this.files.values()];
        this.onProgress?.(vals.reduce((a, b) => a + b, 0) / vals.length);
      } else if (m.type === "ready") {
        this.ready = true;
        this.device = m.device;
        this.initWaiter?.resolve({ device: m.device, name: m.name });
      } else if (m.type === "result") {
        this.pending.get(m.id)?.resolve({ vectors: m.vectors, ms: m.ms });
        this.pending.delete(m.id);
      } else if (m.type === "error") {
        const err = new Error(m.message);
        if (m.id !== undefined) {
          this.pending.get(m.id)?.reject(err);
          this.pending.delete(m.id);
        } else this.initWaiter?.reject(err);
      }
    };
  }

  /** Carica il modello (una volta sola). WebGPU se disponibile; se non parte, nuovo worker con WASM. */
  async init(model: ModelInfo, localModelPath?: string) {
    const wantGpu = "gpu" in navigator && model.backend === "dinov2";
    try {
      return await this.initOn(wantGpu ? "webgpu" : "wasm", model, localModelPath);
    } catch (e) {
      if (!wantGpu) throw e;
      console.warn("WebGPU non utilizzabile, passo a WASM:", e);
      this.spawn(); // sessione ONNX pulita: un errore di init WebGPU può restare in cache nel worker
      return this.initOn("wasm", model, localModelPath);
    }
  }

  private initOn(device: "webgpu" | "wasm", model: ModelInfo, localModelPath?: string) {
    return new Promise<{ device: string; name: string }>((resolve, reject) => {
      this.initWaiter = { resolve, reject };
      const msg: WorkerIn = { type: "init", model, device, localModelPath };
      this.worker.postMessage(msg);
    });
  }

  /** Embedding di un'immagine di riferimento del database (artwork o carta intera, senza ritaglio né rotazione). */
  async embedReference(rgba: Uint8ClampedArray, w: number, h: number, mode: Mode): Promise<Float32Array> {
    return (await this.embed(rgba, w, h, mode, true)).vectors[0];
  }

  embed(rgba: Uint8ClampedArray, w: number, h: number, mode: Mode, reference = false) {
    const id = this.nextId++;
    return new Promise<EmbedResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const buf = rgba.buffer as ArrayBuffer;
      const msg: WorkerIn = { type: "embed", id, rgba: buf, w, h, mode, reference };
      this.worker.postMessage(msg, [buf]);
    });
  }
}
