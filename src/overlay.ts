import type { TrackedCard } from "./types";

/** Canvas sovrapposto al video + loop di disegno. */
export type DrawFn = (ctx: CanvasRenderingContext2D, w: number, h: number, dt: number) => void;

export class Overlay {
  private ctx: CanvasRenderingContext2D;
  private raf = 0;
  private last = 0;
  private fps = 0;
  private frames = 0;
  private fpsTime = 0;
  private extraDraw: DrawFn[] = [];

  constructor(
    private canvas: HTMLCanvasElement,
    private video: HTMLVideoElement,
    private stage: HTMLElement,
    private opts: {
      extra?: HTMLElement[]; // altri elementi (es. canvas WebGL) da dimensionare come il video
      onLayout?: (cssW: number, cssH: number, vw: number, vh: number) => void;
    } = {},
  ) {
    this.ctx = canvas.getContext("2d")!;
    new ResizeObserver(() => this.layout()).observe(stage);
    this.video.addEventListener("loadedmetadata", () => this.layout());
    this.layout();
  }

  /** Permette ai passi successivi di aggiungere disegni (es. riquadro carta). */
  addLayer(fn: DrawFn) {
    this.extraDraw.push(fn);
  }

  /**
   * Adatta video e canvas allo stage mantenendo l'aspect ratio (letterbox).
   * Il buffer del canvas è in coordinate-video, così al passo 2 i punti
   * rilevati nel frame si disegnano senza conversioni.
   */
  layout() {
    const vw = this.video.videoWidth || 16;
    const vh = this.video.videoHeight || 9;
    const sw = this.stage.clientWidth;
    const sh = this.stage.clientHeight;
    const scale = Math.min(sw / vw, sh / vh);
    const cssW = Math.round(vw * scale);
    const cssH = Math.round(vh * scale);
    for (const el of [this.video, this.canvas, ...(this.opts.extra ?? [])]) {
      el.style.width = `${cssW}px`;
      el.style.height = `${cssH}px`;
    }
    if (this.canvas.width !== vw || this.canvas.height !== vh) {
      this.canvas.width = vw;
      this.canvas.height = vh;
    }
    this.opts.onLayout?.(cssW, cssH, vw, vh);
  }

  start() {
    if (this.raf) return;
    this.last = performance.now();
    this.fpsTime = this.last;
    this.frames = 0;
    const tick = (now: number) => {
      const dt = now - this.last;
      this.last = now;
      this.frames++;
      if (now - this.fpsTime >= 500) {
        this.fps = (this.frames * 1000) / (now - this.fpsTime);
        this.frames = 0;
        this.fpsTime = now;
      }
      this.draw(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private draw(dt: number) {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const fn of this.extraDraw) fn(ctx, canvas.width, canvas.height, dt);
    this.drawFps();
  }

  private drawFps() {
    const { ctx, canvas } = this;
    // dimensioni relative al frame, così il testo resta leggibile a 720p come a 4K
    const size = Math.round(canvas.height / 30);
    ctx.font = `bold ${size}px monospace`;
    ctx.textBaseline = "top";
    const text = `${this.fps.toFixed(1)} FPS`;
    const pad = size * 0.4;
    const m = ctx.measureText(text);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(pad, pad, m.width + pad * 2, size + pad * 2);
    ctx.fillStyle = "#0f0";
    ctx.fillText(text, pad * 2, pad * 2);
  }
}

export interface CardDrawOptions {
  mirror: boolean; // video specchiato: si riflettono le coordinate X
  showBoxes: boolean; // riquadro per le carte con artwork (le carte senza artwork lo mostrano sempre)
  selectedId: number | null;
  assigned: ReadonlySet<number>;
}

/** Disegna le carte tracciate: riquadro, ID, orientamento e marcatore dell'angolo TL. */
export function drawCards(ctx: CanvasRenderingContext2D, cards: TrackedCard[], now: number, o: CardDrawOptions) {
  const W = ctx.canvas.width;
  const base = Math.max(2, Math.round(ctx.canvas.height / 270));
  for (const card of cards) {
    const isAssigned = o.assigned.has(card.id);
    const isSel = card.id === o.selectedId;
    if (isAssigned && !o.showBoxes && !isSel) continue;
    const pts = card.corners.map((c) => ({ x: o.mirror ? W - c.x : c.x, y: c.y }));
    const hue = (card.id * 67) % 360;
    const missing = now - card.lastSeen > 100; // non vista di recente: tratteggiata e più tenue
    const color = `hsl(${hue} 90% 55%)`;
    ctx.save();
    ctx.globalAlpha = missing ? 0.45 : 1;
    ctx.lineWidth = base;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.setLineDash(missing ? [base * 3, base * 2] : []);
    const path = () => {
      ctx.beginPath();
      pts.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
      ctx.closePath();
    };
    if (isSel) {
      // alone bianco sotto il riquadro per la carta selezionata
      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = base * 3;
      path();
      ctx.stroke();
      ctx.restore();
    }
    path();
    ctx.stroke();
    ctx.setLineDash([]);

    // Pallino sull'angolo TL (primo angolo) + linea del lato superiore più spessa.
    const [tl, tr] = pts;
    ctx.beginPath();
    ctx.arc(tl.x, tl.y, base * 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = base * 2.5;
    ctx.beginPath();
    ctx.moveTo(tl.x, tl.y);
    ctx.lineTo(tr.x, tr.y);
    ctx.stroke();

    const cx = pts.reduce((s, c) => s + c.x, 0) / 4;
    const cy = pts.reduce((s, c) => s + c.y, 0) / 4;
    const size = Math.round(ctx.canvas.height / 36);
    const label = `#${card.id} ${card.orientation === "portrait" ? "verticale" : "orizzontale"}`;
    ctx.font = `bold ${size}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(cx - tw / 2 - 6, cy - size / 2 - 4, tw + 12, size + 8);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }
}
