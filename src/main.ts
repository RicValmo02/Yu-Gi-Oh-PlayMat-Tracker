import "./style.css";
import { Camera, describeError, type Resolution } from "./camera";
import { Overlay, drawCards } from "./overlay";
import { CardDetector, DEFAULT_VISION, loadCv, type VisionParams } from "./vision";
import { Tracker, DEFAULT_TRACKER, type TrackerParams } from "./tracker";
import { buildSliders, loadJson, saveJson } from "./panel";
import { Renderer } from "./renderer";
import { CardLayer, DEFAULT_ART, type ArtParams } from "./cardLayer";
import { buildLibraryUI, loadLibrary } from "./library";
import { artUrlFor } from "./artSource";
import { DeckCache } from "./deckCache";
import { DeckManager } from "./deck";
import { DeckUI } from "./deckUI";
import { Embedder } from "./embedder";
import { EmbeddingDb, loadIndex } from "./db";
import { Rectifier } from "./rectify";
import { DEFAULT_IDENT, Identifier, type IdentParams, type Identification } from "./identifier";
import { MODEL, type EmbeddingIndex, type Mode, type ModelInfo } from "./modelConfig";
import type { CardInfo, TrackedCard } from "./types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const video = $<HTMLVideoElement>("video");
const canvas = $<HTMLCanvasElement>("overlay");
const deviceSel = $<HTMLSelectElement>("device");
const resSel = $<HTMLSelectElement>("resolution");
const startBtn = $<HTMLButtonElement>("start");
const stopBtn = $<HTMLButtonElement>("stop");
const statusEl = $<HTMLSpanElement>("status");

const camera = new Camera(video);
const glCanvas = $<HTMLCanvasElement>("gl");
const renderer = new Renderer(glCanvas);
const overlay = new Overlay(canvas, video, $("stage"), {
  extra: [glCanvas],
  onLayout: (cssW, cssH, vw, vh) => renderer.resize(cssW, cssH, vw, vh),
});
let library: CardInfo[] = [];
const cardLayer = new CardLayer(renderer.scene, artUrlFor, renderer.maxAnisotropy);

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
let rectifier: Rectifier | null = null;
let cards: TrackedCard[] = [];
let lastDetect = 0;
let procMs = 0;
let lastCount = 0;
let lastTimingsAt = 0;

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
    rectifier = new Rectifier(cv);
    statsEl.textContent = "OpenCV pronto";
  })
  .catch((e) => (statsEl.textContent = `OpenCV non caricato: ${e}`));

debugChk.onchange = () => (debugCanvas.hidden = !debugChk.checked);

// ---- Artwork e selezione ----
const artParams: ArtParams = loadJson("ygo-art", DEFAULT_ART);
const ui = loadJson("ygo-ui", { mirror: false, showBoxes: true });
buildSliders($("artSliders"), artParams, [
  { key: "opacity", label: "Opacità", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "scale", label: "Scala", min: 0.5, max: 2, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { key: "lift", label: "Sollevamento", min: 0, max: 0.4, step: 0.01, fmt: (v) => `${Math.round(v * 100)}%` },
], () => saveJson("ygo-art", artParams));

const mirrorChk = $<HTMLInputElement>("mirror");
const boxesChk = $<HTMLInputElement>("showBoxes");
const trackedSel = $<HTMLSelectElement>("trackedSelect");
const flipBtn = $<HTMLButtonElement>("flip");
const reidBtn = $<HTMLButtonElement>("reid");
const unassignBtn = $<HTMLButtonElement>("unassign");
let selectedId: number | null = null;
let idsKey = "";

mirrorChk.checked = ui.mirror;
boxesChk.checked = ui.showBoxes;
const applyMirror = () => {
  video.style.transform = ui.mirror ? "scaleX(-1)" : "";
  renderer.setMirror(ui.mirror);
};
mirrorChk.onchange = () => ((ui.mirror = mirrorChk.checked), applyMirror(), saveJson("ygo-ui", ui));
boxesChk.onchange = () => ((ui.showBoxes = boxesChk.checked), saveJson("ygo-ui", ui));
applyMirror();

// ---- Identificazione ----
const identParams: IdentParams = loadJson("ygo-ident", DEFAULT_IDENT);
const modelStatusEl = $<HTMLDivElement>("modelStatus");
const timingsEl = $<HTMLDivElement>("timings");
const candidatesEl = $<HTMLDivElement>("candidates");
const modeSel = $<HTMLSelectElement>("mode");
let embedder: Embedder | null = null;
let embIndex: EmbeddingIndex | null = null;
const dbs = new Map<Mode, EmbeddingDb>();
const dbLoading = new Set<Mode>();
const names = new Map<number, string>();

const identifier = new Identifier(
  {
    rectify: (card) => rectifier?.rectify(video, card.corners, card.orientation) ?? null,
    embed: (frame, mode) => embedder!.embed(frame.rgba, frame.w, frame.h, mode),
    db: (mode) => {
      if (!embedder?.ready) return null;
      // Con un mazzo caricato si cerca solo tra le sue carte (molto più preciso); null finché non è pronto.
      if (deckUI?.scopeOnly && deckMgr.active) return deckMgr.db(mode);
      if (!embIndex) return null;
      const db = dbs.get(mode);
      if (!db && !dbLoading.has(mode)) {
        dbLoading.add(mode);
        EmbeddingDb.load(embIndex, mode).then((d) => {
          if (d) dbs.set(mode, d);
          else modelStatusEl.textContent = `Manca il database per la modalità "${mode}": rilancia npm run embeddings.`;
        });
      }
      return db ?? null;
    },
  },
  identParams,
);
buildSliders($("identSliders"), identParams, [
  { key: "threshold", label: "Soglia di confidenza", min: 0, max: 1, step: 0.01, fmt: (v) => v.toFixed(2) },
  { key: "margin", label: "Distacco 1°-2° candidato", min: 0, max: 0.2, step: 0.005, fmt: (v) => v.toFixed(3) },
  { key: "frames", label: "Frame per la votazione", min: 1, max: 12, step: 1 },
  { key: "intervalMs", label: "Intervallo tra frame (ms)", min: 0, max: 500, step: 25 },
  { key: "retryMs", label: "Riprova sconosciute dopo (ms)", min: 500, max: 10000, step: 250 },
], () => saveJson("ygo-ident", identParams));
modeSel.value = identParams.mode;
modeSel.onchange = () => {
  identParams.mode = modeSel.value as Mode;
  saveJson("ygo-ident", identParams);
  identifier.reidentifyAll();
  if (deckMgr.active) void deckUI.prepare(true); // ricalcola/scarica quanto serve per la nuova modalità
};

/** Modello usato per gli embedding: quello del database (se c'è) altrimenti quello di default. */
function modelInfo(): ModelInfo {
  if (embIndex) return embIndex.model;
  if (new URLSearchParams(location.search).get("embedder") === "thumb")
    return { backend: "thumb", id: "thumb-8x8", dtype: "none", dim: 8 * 8 * 3, input: MODEL.input }; // solo test
  return MODEL;
}

let modelPromise: Promise<void> | null = null;
/** Carica il modello nel worker, una sola volta (parte da subito se c'è un database, altrimenti alla prima richiesta). */
function ensureModel(): Promise<void> {
  return (modelPromise ??= (async () => {
    embedder = new Embedder();
    embedder.onProgress = (p) => (modelStatusEl.textContent = `Scaricamento modello: ${Math.round(p)}%`);
    modelStatusEl.textContent = `Caricamento modello ${modelInfo().id}…`;
    try {
      const localModel = new URLSearchParams(location.search).get("localModel") ?? undefined;
      const r = await embedder.init(modelInfo(), localModel);
      modelStatusEl.textContent = `Modello pronto: ${r.name} su ${r.device}`;
    } catch (e) {
      embedder = null;
      modelPromise = null;
      modelStatusEl.textContent = `Modello non caricato: ${e instanceof Error ? e.message : e}`;
      throw e;
    }
  })());
}

async function initIdentification() {
  embIndex = await loadIndex();
  if (embIndex) {
    for (const c of embIndex.cards) if (!c.back) names.set(c.id, c.name);
    modelStatusEl.textContent = `Database: ${embIndex.cards.length} voci.`;
    void ensureModel().catch(() => {});
  } else {
    modelStatusEl.textContent = "Nessun database globale: carica un mazzo (📂 Mazzo…) oppure esegui npm run embeddings.";
  }
  // Mazzo usato l'ultima volta: dalla cache, senza rete.
  let last: string | null = null;
  try { last = localStorage.getItem("ygo-deck"); } catch { /* storage non disponibile */ }
  if (last) void deckUI.restore(last);
}

// ---- Mazzo (.ydk) ----
const deckCache = await DeckCache.open();
const deckMgr = new DeckManager({
  cache: deckCache,
  embedder: () => embedder,
  whenReady: ensureModel,
  model: modelInfo,
});
const deckStatusEl = $<HTMLSpanElement>("deckStatus");
let staticLibrary: CardInfo[] = [];
const deckUI: DeckUI = new DeckUI({
  dialog: $<HTMLDialogElement>("deckDialog"),
  manager: deckMgr,
  cache: deckCache,
  getMode: () => identParams.mode,
  onChange: (cards, scopeOnly) => {
    if (cards) for (const c of cards) names.set(c.id, c.name);
    setLibrary(cards ?? staticLibrary);
    deckStatusEl.textContent = cards ? `Mazzo: ${deckMgr.name} · ${cards.length} carte${scopeOnly ? "" : " (ricerca su tutto il database)"}` : "";
    identifier.reidentifyAll(); // il database di ricerca è cambiato
  },
});
$<HTMLButtonElement>("deckBtn").onclick = () => deckUI.open();
void initIdentification();

const nameOf = (id: number | undefined) => (id === undefined ? "?" : names.get(id) ?? library.find((c) => c.id === id)?.name ?? `#${id}`);

/** Testo e colore sul riquadro di una carta, in base allo stato di identificazione. */
function labelOf(st: Identification | undefined): { lines: string[]; color: string } | undefined {
  if (!st) return undefined;
  const [c1, c2] = st.candidates;
  const sc = (c?: { score: number }) => (c ? c.score.toFixed(2) : "–");
  if (st.manual) return { lines: [st.cardId !== undefined ? nameOf(st.cardId) : "nessuna", "manuale"], color: "#8cf" };
  switch (st.status) {
    case "identified":
      return { lines: [nameOf(st.cardId), `${sc(c1)} · identificata`], color: "#7f7" };
    case "uncertain":
      return { lines: ["incerta", `${c1?.name} ${sc(c1)}`, `${c2?.name} ${sc(c2)}`], color: "#fc4" };
    case "unknown":
      return { lines: ["sconosciuta", `migliore ${sc(c1)}`], color: "#f77" };
    case "covered":
      return { lines: ["coperta (dorso)", sc(c1)], color: "#8cf" };
    default:
      return { lines: [embedder?.ready ? "analisi…" : "in attesa del modello", st.sampling ? `${st.sampling.done}/${st.sampling.total}` : ""].filter(Boolean), color: "#ccc" };
  }
}

function refreshTrackedUI() {
  const key = cards.map((c) => { const s = identifier.get(c.id); return `${c.id}:${s?.status}:${s?.cardId}:${s?.manual}`; }).join(",") + `|${selectedId}`;
  if (key === idsKey) return;
  idsKey = key;
  if (selectedId !== null && !cards.some((c) => c.id === selectedId)) selectedId = null;
  trackedSel.replaceChildren(
    new Option("— nessuna —", ""),
    ...cards.map((c) => {
      const s = identifier.get(c.id);
      const what = s?.status === "identified" || s?.manual ? nameOf(s.cardId) : s?.status === "covered" ? "coperta" : s?.status ?? "";
      return new Option(`#${c.id} · ${what}`, String(c.id));
    }),
  );
  trackedSel.value = selectedId === null ? "" : String(selectedId);
  flipBtn.disabled = reidBtn.disabled = unassignBtn.disabled = selectedId === null;
}

/** Primi 3 candidati della carta selezionata; clic = correzione manuale. */
function refreshCandidates() {
  const st = selectedId === null ? undefined : identifier.get(selectedId);
  const key = st ? `${st.trackedId}:${st.manual}:${st.cardId}:` + st.candidates.map((c) => `${c.cardId}:${c.score.toFixed(3)}`).join(",") : "";
  if (key === candidatesEl.dataset.key) return;
  candidatesEl.dataset.key = key;
  if (!st || !st.candidates.length) return void (candidatesEl.textContent = st ? "Nessun candidato ancora." : "Seleziona una carta.");
  candidatesEl.replaceChildren(
    ...st.candidates.map((c) => {
      const b = document.createElement("button");
      b.className = "lib-item" + (st.manual && st.cardId === c.cardId ? " manual" : "");
      if (c.cardId > 0) {
        const img = document.createElement("img");
        img.src = artUrlFor(c.cardId);
        img.alt = "";
        b.append(img);
      }
      const name = document.createElement("span");
      name.textContent = c.name;
      const score = document.createElement("span");
      score.className = "score";
      score.textContent = c.score.toFixed(2);
      b.append(name, score);
      b.disabled = c.cardId < 0;
      b.onclick = () => ((idsKey = ""), identifier.override(st.trackedId, c.cardId));
      return b;
    }),
  );
}

trackedSel.onchange = () => ((selectedId = trackedSel.value ? Number(trackedSel.value) : null), (idsKey = ""));
flipBtn.onclick = () => selectedId !== null && identifier.toggleFlip(selectedId);
reidBtn.onclick = () => selectedId !== null && (identifier.reidentify(selectedId), (idsKey = ""));
unassignBtn.onclick = () => selectedId !== null && (identifier.override(selectedId, null), (idsKey = ""));

/** Elenco per l'assegnazione manuale: le carte del mazzo caricato, altrimenti quelle scaricate con npm run cards. */
function setLibrary(list: CardInfo[]) {
  library = list;
  buildLibraryUI($("library"), $<HTMLInputElement>("search"), list, (c) => {
    if (selectedId === null) return void (timingsEl.textContent = "Seleziona prima una carta tracciata.");
    identifier.override(selectedId, c.id);
    idsKey = "";
  });
}
loadLibrary().then((list) => {
  staticLibrary = list;
  if (!deckMgr.active) setLibrary(list);
});

/** Click sul video → coordinate del frame → carta tracciata sotto il puntatore (l'ultima disegnata vince). */
video.addEventListener("click", (ev) => {
  const r = video.getBoundingClientRect();
  let x = ((ev.clientX - r.left) / r.width) * video.videoWidth;
  const y = ((ev.clientY - r.top) / r.height) * video.videoHeight;
  if (ui.mirror) x = video.videoWidth - x;
  const hit = [...cards].reverse().find((c) => pointInQuad(x, y, c.corners));
  selectedId = hit ? hit.id : null;
  idsKey = "";
});

function pointInQuad(x: number, y: number, q: readonly { x: number; y: number }[]) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 1) % 4];
    const cr = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cr !== 0) {
      if (sign && Math.sign(cr) !== sign) return false;
      sign = Math.sign(cr);
    }
  }
  return true;
}

/** Un solo requestAnimationFrame (in Overlay): visione a frequenza ridotta, poi rendering ogni frame. */
overlay.addLayer((ctx, _w, _h, dt) => {
  const now = performance.now();
  const ready = detector && camera.running && video.readyState >= 2 && detectChk.checked;
  // La visione non può occupare più di ~1/3 del tempo: l'intervallo cresce se l'elaborazione è lenta.
  const interval = Math.max(1000 / vision.maxHz, procMs * 3);
  if (ready && now - lastDetect >= interval) {
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
  identifier.update(cards, now); // al massimo un lavoro alla volta, il modello gira nel worker
  for (const c of cards) {
    const st = identifier.get(c.id);
    const want = st?.status === "identified" ? st.cardId : undefined;
    if (want !== cardLayer.cardIdOf(c.id)) want !== undefined ? cardLayer.assign(c.id, want) : cardLayer.unassign(c.id);
    if (want !== undefined) cardLayer.setFlip(c.id, st!.flip);
  }
  cardLayer.sync(cards, artParams, dt);
  renderer.render();
  refreshTrackedUI();
  refreshCandidates();
  if (now - lastTimingsAt > 250) {
    lastTimingsAt = now;
    const t = identifier.timings;
    timingsEl.textContent = `Raddrizzamento: ${t.rectify.toFixed(1)} ms\nEmbedding (2 varianti): ${t.embed.toFixed(0)} ms\nRicerca: ${t.search.toFixed(1)} ms` +
      (identifier.lastError ? `\nErrore: ${identifier.lastError}` : "");
  }
  const labels = new Map(cards.map((c) => [c.id, labelOf(identifier.get(c.id))!]));
  drawCards(ctx, cards, now, {
    labels,
    mirror: ui.mirror,
    showBoxes: ui.showBoxes,
    selectedId,
    assigned: new Set(cardLayer.assignments.map((a) => a.trackedId)),
  });
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
  cardLayer.clear(); // rimuove piani e texture
  identifier.clear();
  renderer.render(); // svuota il canvas WebGL
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
