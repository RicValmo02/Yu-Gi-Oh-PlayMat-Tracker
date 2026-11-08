import * as THREE from "three";

/**
 * Scena Three.js sopra il video. La camera ortografica usa le coordinate in pixel del frame
 * (origine in alto a sinistra, y verso il basso): il punto (x, y) del video è lo stesso punto sullo schermo.
 * Il canvas WebGL è dimensionato in CSS come il video (lo fa Overlay.layout), qui si gestisce solo buffer e camera.
 */
export class Renderer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.OrthographicCamera(0, 1, 0, 1, -1, 1);
  readonly gl: THREE.WebGLRenderer;
  private vw = 1;
  private vh = 1;
  private mirror = false;

  constructor(canvas: HTMLCanvasElement) {
    this.gl = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true });
    this.gl.setClearColor(0x000000, 0);
  }

  /** Chiamata a ogni layout: cssW/cssH = dimensione a schermo, vw/vh = dimensione del frame video. */
  resize(cssW: number, cssH: number, vw: number, vh: number) {
    this.vw = vw;
    this.vh = vh;
    this.gl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.gl.setSize(cssW, cssH, false);
    this.updateCamera();
  }

  /** Video specchiato: si inverte l'asse X della camera, così l'artwork resta incollato alla carta. */
  setMirror(mirror: boolean) {
    this.mirror = mirror;
    this.updateCamera();
  }

  private updateCamera() {
    const c = this.camera;
    c.left = this.mirror ? this.vw : 0;
    c.right = this.mirror ? 0 : this.vw;
    c.top = 0; // y verso il basso, come nel frame
    c.bottom = this.vh;
    c.updateProjectionMatrix();
  }

  render() {
    this.gl.render(this.scene, this.camera);
  }

  get maxAnisotropy() {
    return this.gl.capabilities.getMaxAnisotropy();
  }

  dispose() {
    this.gl.dispose();
  }
}
