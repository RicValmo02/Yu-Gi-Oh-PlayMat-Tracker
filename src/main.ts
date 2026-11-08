import "./style.css";
import { Camera, describeError, type Resolution } from "./camera";
import { Overlay } from "./overlay";

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
    setRunning(false);
    setStatus(describeError(e), true);
  }
}

function stop() {
  camera.stop();
  overlay.stop();
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
