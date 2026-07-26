import * as THREE from 'three';

export interface EngineHooks {
  /** Fixed-timestep simulation. Called 0..N times per frame. */
  fixedUpdate(dt: number): void;
  /** Variable-rate visual update, with `alpha` = interpolation into the next step. */
  update(dt: number, alpha: number): void;
  render(): void;
  resize(width: number, height: number): void;
}

const FIXED_DT = 1 / 120;
/** Never simulate more than this per frame -- prevents a spiral of death. */
const MAX_FRAME = 0.1;

/**
 * Render loop, canvas sizing and the adaptive resolution scaler.
 *
 * On a phone the GPU budget is the binding constraint, so rather than dropping
 * frames we drop pixels: the render scale walks down when frames get long and
 * back up when there is headroom.
 */
export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly canvas: HTMLCanvasElement;

  /** Wall-clock seconds since start, excluding paused time. */
  time = 0;
  running = false;

  /** Current resolution multiplier, 0.55..1. */
  renderScale = 1;
  /** Upper bound on devicePixelRatio. */
  maxPixelRatio = 2;

  private hooks: EngineHooks | null = null;
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private frameEma = 16.7;
  private scaleCooldown = 0;
  private warmup = 60;
  private cssWidth = 1;
  private cssHeight = 1;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false, // we run our own FXAA in the post chain
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
    });

    this.renderer.autoClear = false;
    this.renderer.setClearColor(0x000000, 1);
    // Everything downstream of the scene render is hand-tonemapped in the post
    // chain, so three must not apply its own conversion.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;

    window.addEventListener('resize', this.onResize);
    window.addEventListener('orientationchange', this.onResize);
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  setHooks(hooks: EngineHooks): void {
    this.hooks = hooks;
    this.onResize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /** Drawing-buffer size in pixels, after DPR clamp and adaptive scaling. */
  get drawWidth(): number {
    return Math.max(1, Math.floor(this.cssWidth * this.pixelRatio()));
  }

  get drawHeight(): number {
    return Math.max(1, Math.floor(this.cssHeight * this.pixelRatio()));
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * this.renderScale;
  }

  private onResize = (): void => {
    // visualViewport is the reliable one on iOS, where the URL bar changes the
    // reported innerHeight mid-scroll.
    const vv = window.visualViewport;
    this.cssWidth = Math.max(1, Math.floor(vv?.width ?? window.innerWidth));
    this.cssHeight = Math.max(1, Math.floor(vv?.height ?? window.innerHeight));

    this.canvas.style.width = `${this.cssWidth}px`;
    this.canvas.style.height = `${this.cssHeight}px`;
    this.applySize();
  };

  private applySize(): void {
    const w = this.drawWidth;
    const h = this.drawHeight;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.hooks?.resize(w, h);
  }

  private onVisibility = (): void => {
    if (document.hidden) {
      this.stop();
    } else if (this.hooks) {
      this.start();
    }
  };

  /**
   * Nudges the render scale towards whatever keeps us near 60fps.
   *
   * The thresholds straddle the vsync interval rather than sitting below it.
   * A GPU-bound frame and a comfortable frame both measure ~16.7ms on a 60Hz
   * panel, so a step-up threshold under that would strand the scaler at
   * whatever value it first dropped to and never recover.
   */
  private adapt(frameMs: number): void {
    // Ignore the opening frames: shader compilation makes them meaningless.
    if (this.warmup > 0) { this.warmup -= 1; return; }

    this.frameEma += (frameMs - this.frameEma) * 0.06;
    this.scaleCooldown -= 1;
    if (this.scaleCooldown > 0) return;

    if (this.frameEma > 22 && this.renderScale > 0.55) {
      this.renderScale = Math.max(0.55, this.renderScale - 0.1);
      this.scaleCooldown = 120;
      this.applySize();
    } else if (this.frameEma < 18 && this.renderScale < 1) {
      this.renderScale = Math.min(1, this.renderScale + 0.05);
      // Long cooldown: if the step up was a mistake we want to have measured a
      // few real seconds before trying again.
      this.scaleCooldown = 300;
      this.applySize();
    }
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    const frameMs = now - this.lastTime;
    this.lastTime = now;

    const dt = Math.min(frameMs / 1000, MAX_FRAME);
    this.time += dt;

    const hooks = this.hooks;
    if (!hooks) return;

    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < 8) {
      hooks.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // If we blew the step budget, drop the backlog rather than compounding it.
    if (steps >= 8) this.accumulator = 0;

    hooks.update(dt, this.accumulator / FIXED_DT);
    hooks.render();

    this.adapt(frameMs);
  };

  dispose(): void {
    this.stop();
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('orientationchange', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.renderer.dispose();
  }
}
