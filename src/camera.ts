export type Resolution = 720 | 1080 | 2160;

const RES: Record<Resolution, { width: number; height: number }> = {
  720: { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  2160: { width: 3840, height: 2160 },
};

export class Camera {
  private stream: MediaStream | null = null;

  constructor(readonly video: HTMLVideoElement) {}

  get running() {
    return this.stream !== null;
  }

  /** Elenca le webcam. Le label sono vuote finché non è stato concesso il permesso. */
  async listDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === "videoinput");
  }

  /** Avvia lo stream; ritorna la risoluzione effettiva ottenuta. */
  async start(deviceId: string | undefined, res: Resolution) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia non disponibile (serve HTTPS o localhost).");
    }
    this.stop();
    const { width, height } = RES[res];
    // "ideal": se la camera non supporta 4K il browser ripiega sul massimo disponibile
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: width },
        height: { ideal: height },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    const s = this.stream.getVideoTracks()[0].getSettings();
    return { width: s.width ?? this.video.videoWidth, height: s.height ?? this.video.videoHeight };
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
  }
}

/** Traduce gli errori di getUserMedia in messaggi leggibili. */
export function describeError(e: unknown): string {
  const name = (e as DOMException)?.name;
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Permesso webcam negato. Abilitalo dalle impostazioni del sito.";
    case "NotFoundError":
    case "DevicesNotFoundError":
      return "Nessuna webcam trovata.";
    case "NotReadableError":
      return "Webcam occupata da un'altra applicazione.";
    case "OverconstrainedError":
      return "La webcam scelta non supporta la risoluzione richiesta.";
    default:
      return e instanceof Error ? e.message : String(e);
  }
}
