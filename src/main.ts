import "./style.css";
import { Camera, describeError, type Resolution } from "./camera";
import { Overlay, drawCards } from "./overlay";
import { CardDetector, DEFAULT_VISION, loadCv, type VisionParams } from "./vision";
import { Tracker, DEFAULT_TRACKER, type TrackerParams } from "./tracker";
import { buildSliders, loadJson, saveJson } from "./panel";
import type { TrackedCard } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("overlay");
const deviceSel = $<HTMLSelectElement>("device");
const resSel = $<HTMLSelectElement>("resolution");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const statusEl = $<HTMLSpanElement>("status");

const camera = new Camera(video);
const overlay = new Overlay(canvas, video, $("stage"));

const STORAGE_KEY = "ygo-tracker-settings";
type Settings = { deviceId?: string; resolution?: Resolution };

function loadSettings(): Settings {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function saveSettings() {
  try {
    const s: Settings = { deviceId: deviceSel.value, resolution: Number(resSel.value) as Resolution };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage non disponibile: la scelta non viene ricordata */
  }
}

// ---- Visione ----
const vision: VisionParams = loadJson("ygo-vision", DEFAULT_VISION);
const trackerParams: TrackerParams = loadJson("ygo-tracker", DEFAULT_TRACKER);
const tracker = new Tracker(trackerParams);
const debugCanvas = $<HTMLCanvasElement>("debug");
const detectChk = $<HTMLInputElement>("detect");
const debugChk = $<HTMLInputElement>("showDebug");
const statsEl = $<HTMLDivElement>("stats");
let detector: CardDetector | null = null;
let cards: TrackedCard[] = [];
let lastDetect = 0;
let procMs = 0;
let lastCount = 0;

const persist = () => (saveJson("ygo-vision", vision), saveJson("ygo-tracker", trackerParams));
buildSliders($("sliders"), vision, [
  { key: "scale", label: "Scala elaborazione", min: 0.2, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "canny1", label: "Canny soglia bassa", min: 0, max: 255, step: 1 },
  { key: "canny2", label: "Canny soglia alta", min: 0, max: 255, step: 1 },
  { key: "closeSize", label: "Chiusura morfologica (px)", min: 1, max: 15, step: 2 },
  { key: "minAreaPct", label: "Area minima (% frame)", min: 0.1, max: 10, step: 0.1, fmt: (v) => `${v.toFixed(1)}%` },
  { key: "maxAreaPct", label: "Area massima (% frame)", min: 5, max: 90, step: 1, fmt: (v) => `${v}%` },
  { key: "maxHz", label: "Rilevamenti/s max", min: 1, max: 30, step: 1 },
  { key: "ratioTol", label: "Tolleranza proporzioni", min: 0.02, max: 0.4, step: 0.01, fmt: (v) => `±${Math.round(v * 100)}%` },
], persist);
buildSliders($("sliders"), trackerParams, [
  { key: "smoothing", label: "Smoothing angoli", min: 0, max: 0.95, step: 0.05 },
  { key: "timeoutMs", label: "Timeout carta persa (ms)", min: 0, max: 3000, step: 50 },
  { key: "minHits", label: "Conferme prima di mostrarla", min: 1, max: 10, step: 1 },
], persist);

loadCv()
  .then((cv) => {
    detector = new CardDetector(cv);
    statsEl.textContent = "OpenCV pronto";
  })
  .catch((e) => (statsEl.textContent = `OpenCV non caricato: ${e}`));

debugChk.onchange = () => (debugCanvas.hidden = !debugChk.checked);

/** Layer dell'overlay: rileva (a frequenza limitata), aggiorna il tracker e disegna le carte. */
overlay.addLayer((ctx) => {
  const now = performance.now();
  const ready = detector && camera.running && video.readyState >= 2 && detectChk.checked;
  if (ready && now - lastDetect >= 1000 / vision.maxHz) {
    lastDetect = now;
    const r = detector!.detect(video, vision, debugChk.checked ? debugCanvas : undefined);
    procMs = procMs ? procMs * 0.8 + r.ms * 0.2 : r.ms;
    lastCount = r.detections.length;
    cards = tracker.update(r.detections, now);
    statsEl.textContent = `Elaborazione: ${procMs.toFixed(1)} ms\nRilevati: ${lastCount}\nTracciati: ${cards.length}`;
  } else if (!ready && cards.length) {
    tracker.reset();
    cards = [];
  }
  drawCards(ctx, cards, now);
});

function setStatus(msg: string, error = false) {
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", error);
}

function setRunning(running: boolean) {
  startBtn.disabled = running;
  stopBtn.disabled = !running;
}

async function refreshDevices() {
  const saved = deviceSel.value || loadSettings().deviceId;
  const devices = await camera.listDevices();
  deviceSel.replaceChildren(
    ...devices.map((d, i) => new Option(d.label || `Webcam ${i + 1}`, d.deviceId)),
  );
  if (!devices.length) deviceSel.add(new Option("Nessuna webcam", ""));
  if (saved && devices.some((d) => d.deviceId === saved)) deviceSel.value = saved;
}

async function start() {
  setStatus("Avvio…");
  try {
    const { width, height } = await camera.start(deviceSel.value || undefined, Number(resSel.value) as Resolution);
    // dopo il permesso le label diventano disponibili: riempiamo di nuovo la lista
    await refreshDevices();
    overlay.layout();
    overlay.start();
    setRunning(true);
    saveSettings();
    setStatus(`${width}×${height}`);
  } catch (e) {
    camera.stop();
    overlay.stop();
    tracker.reset();
    cards = [];
    setRunning(false);
    setStatus(describeError(e), true);
  }
}

function stop() {
  camera.stop();
  overlay.stop();
  tracker.reset();
  cards = [];
  setRunning(false);
  setStatus("Fermata");
}

async function init() {
  const s = loadSettings();
  if (s.resolution) resSel.value = String(s.resolution);
  try {
    await refreshDevices();
  } catch (e) {
    setStatus(describeError(e), true);
  }
  navigator.mediaDevices?.addEventListener("devicechange", () => refreshDevices().catch(() => {}));
  startBtn.onclick = start;
  stopBtn.onclick = stop;
  // cambiare webcam/risoluzione a stream attivo lo riavvia
  const onChange = () => (saveSettings(), camera.running && start());
  deviceSel.onchange = onChange;
  resSel.onchange = onChange;
}

init();
