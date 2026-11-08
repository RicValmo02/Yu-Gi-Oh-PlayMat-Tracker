import { defineConfig } from "vite";

export default defineConfig({
  // Il worker dell'embedder usa import dinamici (transformers.js): serve il formato ES.
  worker: { format: "es" },
  build: { chunkSizeWarningLimit: 15000 }, // il chunk di OpenCV.js (wasm incorporato) pesa ~13 MB
});
