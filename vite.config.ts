import { defineConfig } from "vite";

// Il sito scarica mazzi da YGOPRODeck passando da questi proxy (stessa origine: nessun problema di CORS).
// YGO_API_TARGET / YGO_API_PATH / YGO_IMG_TARGET servono solo ai test con un finto server.
const api = process.env.YGO_API_TARGET ?? "https://db.ygoprodeck.com";
const apiPath = process.env.YGO_API_PATH ?? "/api/v7";
const img = process.env.YGO_IMG_TARGET ?? "https://images.ygoprodeck.com";
const proxy = {
  "/ygo-api": { target: api, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/ygo-api/, apiPath) },
  "/ygo-img": { target: img, changeOrigin: true, rewrite: (p: string) => p.replace(/^\/ygo-img/, "") },
};

export default defineConfig({
  // Il worker dell'embedder usa import dinamici (transformers.js): serve il formato ES.
  worker: { format: "es" },
  server: { proxy },
  preview: { proxy },
  build: { chunkSizeWarningLimit: 15000 }, // il chunk di OpenCV.js (wasm incorporato) pesa ~13 MB
});
