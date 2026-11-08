import { defineConfig } from "vite";

export default defineConfig({
  build: { chunkSizeWarningLimit: 15000 }, // il chunk di OpenCV.js (wasm incorporato) pesa ~13 MB
});
