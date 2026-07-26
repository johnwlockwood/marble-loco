import * as THREE from 'three';

export type ControlMode = 'tilt' | 'stick';

interface OrientationEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

/** Degrees of tilt from neutral that corresponds to full deflection. */
const TILT_RANGE = 26;

/**
 * Unified input.
 *
 * `move` is in *screen* space: x is right, y is away from the player. The game
 * rotates it into world space using the camera yaw, so tilting the phone right
 * always sends the marble right on screen regardless of the level's camera.
 */
export class Input {
  readonly move = new THREE.Vector2();
  mode: ControlMode = 'stick';
  /** True on the frame the jump was pressed. Cleared by `endFrame()`. */
  jumpPressed = false;
  jumpHeld = false;
  tiltAvailable = false;
  tiltGranted = false;

  private readonly stick = new THREE.Vector2();
  private readonly keys = new THREE.Vector2();
  private readonly tilt = new THREE.Vector2();

  private betaBase: number | null = null;
  private gammaBase = 0;
  private lastBeta = 0;
  private lastGamma = 0;
  private hasOrientationData = false;

  private stickEl: HTMLElement | null = null;
  private nubEl: HTMLElement | null = null;
  private jumpEl: HTMLElement | null = null;
  private stickPointer: number | null = null;
  private readonly stickOrigin = new THREE.Vector2();
  private stickRadius = 52;

  constructor() {
    this.tiltAvailable =
      typeof window !== 'undefined' && typeof window.DeviceOrientationEvent !== 'undefined';
  }

  /** Wires up the on-screen controls. */
  attach(stickEl: HTMLElement, nubEl: HTMLElement, jumpEl: HTMLElement): void {
    this.stickEl = stickEl;
    this.nubEl = nubEl;
    this.jumpEl = jumpEl;

    stickEl.addEventListener('pointerdown', this.onStickDown, { passive: false });
    stickEl.addEventListener('pointermove', this.onStickMove, { passive: false });
    stickEl.addEventListener('pointerup', this.onStickUp, { passive: false });
    stickEl.addEventListener('pointercancel', this.onStickUp, { passive: false });

    jumpEl.addEventListener('pointerdown', this.onJumpDown, { passive: false });
    jumpEl.addEventListener('pointerup', this.onJumpUp, { passive: false });
    jumpEl.addEventListener('pointercancel', this.onJumpUp, { passive: false });

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('deviceorientation', this.onOrientation);
  }

  /**
   * Asks iOS for motion access. Must be called from inside a user gesture --
   * Safari silently denies otherwise.
   */
  async requestTilt(): Promise<boolean> {
    const ctor = window.DeviceOrientationEvent as unknown as OrientationEventCtor;
    if (!ctor) return false;

    if (typeof ctor.requestPermission === 'function') {
      try {
        const result = await ctor.requestPermission();
        this.tiltGranted = result === 'granted';
      } catch {
        this.tiltGranted = false;
      }
    } else {
      // Android and desktop browsers with a sensor: no prompt, but we still do
      // not know whether events will actually arrive until one does.
      this.tiltGranted = true;
    }

    if (this.tiltGranted) {
      this.mode = 'tilt';
      this.betaBase = null; // re-calibrate on the next reading
    }
    return this.tiltGranted;
  }

  /** Takes the current phone attitude as "level". */
  calibrate(): void {
    if (this.hasOrientationData) {
      this.betaBase = this.lastBeta;
      this.gammaBase = this.lastGamma;
    } else {
      this.betaBase = null;
    }
  }

  setMode(mode: ControlMode): void {
    this.mode = mode;
    if (mode === 'tilt') this.betaBase = null;
    this.stick.set(0, 0);
    this.stickPointer = null;
    this.nubEl?.style.setProperty('transform', 'translate(0px, 0px)');
    this.stickEl?.classList.remove('active');
    this.stickEl?.classList.toggle('hide', mode === 'tilt');
  }

  /** Recomputes `move` for this frame. */
  update(): void {
    this.move.set(0, 0);

    if (this.mode === 'tilt' && this.hasOrientationData) {
      this.move.add(this.tilt);
    }
    if (this.mode === 'stick') {
      this.move.add(this.stick);
    }
    // Keyboard always works, so a desktop browser is usable for testing.
    this.move.add(this.keys);

    if (this.move.lengthSq() > 1) this.move.normalize();
  }

  endFrame(): void {
    this.jumpPressed = false;
  }

  /** Releases everything; used when the game is paused or an overlay opens. */
  release(): void {
    this.stick.set(0, 0);
    this.keys.set(0, 0);
    this.move.set(0, 0);
    this.stickPointer = null;
    this.jumpHeld = false;
    this.jumpPressed = false;
    this.nubEl?.style.setProperty('transform', 'translate(0px, 0px)');
    this.stickEl?.classList.remove('active');
  }

  setJumpAvailable(available: boolean): void {
    this.jumpEl?.classList.toggle('spent', !available);
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('deviceorientation', this.onOrientation);
  }

  /* ------------------------------------------------------------- handlers */

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;

    this.hasOrientationData = true;
    this.lastBeta = e.beta;
    this.lastGamma = e.gamma;

    if (this.betaBase === null) {
      this.betaBase = e.beta;
      this.gammaBase = e.gamma;
    }

    // Tilting the top of the phone away lowers beta, which should push the
    // marble away from the player -- hence the negation.
    const dy = -(e.beta - this.betaBase) / TILT_RANGE;
    const dx = (e.gamma - this.gammaBase) / TILT_RANGE;

    this.tilt.set(
      THREE.MathUtils.clamp(dx, -1, 1),
      THREE.MathUtils.clamp(dy, -1, 1),
    );

    // Small dead zone so a resting hand does not creep.
    if (this.tilt.lengthSq() < 0.02 * 0.02) this.tilt.set(0, 0);
  };

  private onStickDown = (e: PointerEvent): void => {
    e.preventDefault();
    const el = this.stickEl!;
    const rect = el.getBoundingClientRect();
    this.stickRadius = rect.width * 0.38;
    this.stickOrigin.set(rect.left + rect.width / 2, rect.top + rect.height / 2);
    this.stickPointer = e.pointerId;
    try {
      // Capture keeps the stick tracking when the thumb slides off the pad.
      // It throws if the pointer has already been released, which we do not
      // care about -- the move handler still works without capture.
      el.setPointerCapture(e.pointerId);
    } catch {
      /* not capturable; tracking still works */
    }
    el.classList.add('active');
    this.onStickMove(e);
  };

  private onStickMove = (e: PointerEvent): void => {
    if (this.stickPointer !== e.pointerId) return;
    e.preventDefault();

    let dx = e.clientX - this.stickOrigin.x;
    let dy = e.clientY - this.stickOrigin.y;
    const len = Math.hypot(dx, dy);
    const max = this.stickRadius;

    if (len > max) {
      dx = (dx / len) * max;
      dy = (dy / len) * max;
    }

    this.nubEl?.style.setProperty('transform', `translate(${dx}px, ${dy}px)`);
    // Screen y grows downwards; the game's y is "away from the player".
    this.stick.set(dx / max, -dy / max);
  };

  private onStickUp = (e: PointerEvent): void => {
    if (this.stickPointer !== e.pointerId) return;
    e.preventDefault();
    this.stickPointer = null;
    this.stick.set(0, 0);
    this.nubEl?.style.setProperty('transform', 'translate(0px, 0px)');
    this.stickEl?.classList.remove('active');
  };

  private onJumpDown = (e: PointerEvent): void => {
    e.preventDefault();
    this.jumpPressed = true;
    this.jumpHeld = true;
    this.jumpEl?.classList.add('active');
  };

  private onJumpUp = (e: PointerEvent): void => {
    e.preventDefault();
    this.jumpHeld = false;
    this.jumpEl?.classList.remove('active');
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': this.keys.y = 1; break;
      case 'ArrowDown': case 'KeyS': this.keys.y = -1; break;
      case 'ArrowLeft': case 'KeyA': this.keys.x = -1; break;
      case 'ArrowRight': case 'KeyD': this.keys.x = 1; break;
      case 'Space': this.jumpPressed = true; this.jumpHeld = true; e.preventDefault(); break;
      default: return;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': if (this.keys.y > 0) this.keys.y = 0; break;
      case 'ArrowDown': case 'KeyS': if (this.keys.y < 0) this.keys.y = 0; break;
      case 'ArrowLeft': case 'KeyA': if (this.keys.x < 0) this.keys.x = 0; break;
      case 'ArrowRight': case 'KeyD': if (this.keys.x > 0) this.keys.x = 0; break;
      case 'Space': this.jumpHeld = false; break;
    }
  };
}
