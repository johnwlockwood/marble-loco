import * as THREE from 'three';

export type ControlMode = 'tilt' | 'stick';

/**
 * Why enabling tilt did or did not work. Each case needs a different thing
 * from the player, so they must not be collapsed into a boolean.
 */
export type TiltResult =
  /** Working: permission held and events are arriving. */
  | 'granted'
  /** The permission prompt was declined (or previously declined for this origin). */
  | 'denied'
  /**
   * The request lost its transient activation -- our bug, not the player's
   * choice. Kept separate because "denied" sends people into Settings looking
   * for a permission they never actually refused.
   */
  | 'no-gesture'
  /** No DeviceOrientationEvent at all -- desktop without a sensor. */
  | 'unsupported'
  /** Served over plain http. iOS refuses the sensors outside a secure context. */
  | 'insecure'
  /** Permission granted, but no readings arrived -- no sensor, or blocked. */
  | 'no-data';

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
  /** Raw reason the last tilt request failed, for on-screen diagnostics. */
  lastTiltError = '';

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
    // Deliberately optimistic. On an insecure origin the constructor is hidden,
    // so testing only for it would silently remove the tilt option from the
    // very devices that have the sensor -- leaving the player with no way to
    // find out why. Offer it on anything with a touchscreen and explain on tap.
    const hasTouch =
      navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    this.tiltAvailable =
      typeof window.DeviceOrientationEvent !== 'undefined' || hasTouch;
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
    // You hold the phone at a different attitude in landscape, so the old
    // neutral point is no longer the one you want.
    window.addEventListener('orientationchange', this.onScreenRotate);
    window.screen?.orientation?.addEventListener?.('change', this.onScreenRotate);
  }

  private onScreenRotate = (): void => {
    if (this.mode === 'tilt') this.betaBase = null;
  };

  /**
   * Asks for motion access and confirms readings actually arrive.
   *
   * Must be called synchronously from inside a user gesture -- Safari denies
   * `requestPermission` otherwise, which is why this is invoked straight from
   * the button handler rather than after any await.
   */
  async requestTilt(): Promise<TiltResult> {
    // Secure context is checked *first*: browsers do not merely deny the
    // sensors on an insecure origin, several hide DeviceOrientationEvent
    // entirely. Testing for the constructor first would report a LAN http://
    // page as "no such sensor", which sends you looking in the wrong place.
    if (!window.isSecureContext) return 'insecure';

    const ctor = window.DeviceOrientationEvent as unknown as OrientationEventCtor | undefined;
    if (!ctor) return 'unsupported';

    if (typeof ctor.requestPermission === 'function') {
      try {
        // Called before the first await, so we are still inside the gesture.
        const result = await ctor.requestPermission();
        if (result !== 'granted') {
          this.lastTiltError = `requestPermission returned "${result}"`;
          return 'denied';
        }
      } catch (err) {
        const name = (err as DOMException | undefined)?.name ?? String(err);
        this.lastTiltError = name;
        // NotAllowedError here means the call did not carry transient
        // activation, which is a completely different problem from the player
        // tapping "Don't Allow".
        return name === 'NotAllowedError' ? 'no-gesture' : 'denied';
      }
    }
    // Elsewhere there is no prompt -- but permission is not the same as data,
    // so either way we wait for a real reading before committing.

    this.mode = 'tilt';
    this.betaBase = null; // re-calibrate against the next reading

    if (!(await this.waitForReading(1500))) {
      this.mode = 'stick';
      this.tiltGranted = false;
      return 'no-data';
    }

    this.tiltGranted = true;
    return 'granted';
  }

  /** Resolves true once a deviceorientation reading lands, or false on timeout. */
  private waitForReading(timeoutMs: number): Promise<boolean> {
    if (this.hasOrientationData) return Promise.resolve(true);
    return new Promise((resolve) => {
      const started = performance.now();
      const poll = () => {
        if (this.hasOrientationData) return resolve(true);
        if (performance.now() - started > timeoutMs) return resolve(false);
        requestAnimationFrame(poll);
      };
      poll();
    });
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
    window.removeEventListener('orientationchange', this.onScreenRotate);
    window.screen?.orientation?.removeEventListener?.('change', this.onScreenRotate);
  }

  /* ------------------------------------------------------------- handlers */

  /** Screen rotation in degrees, for mapping device axes onto screen axes. */
  private screenAngle(): number {
    const angle = window.screen?.orientation?.angle;
    if (typeof angle === 'number') return angle;
    // Older iOS only has the deprecated window.orientation.
    const legacy = (window as unknown as { orientation?: number }).orientation;
    return typeof legacy === 'number' ? legacy : 0;
  }

  private onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.beta === null || e.gamma === null) return;

    this.hasOrientationData = true;
    this.lastBeta = e.beta;
    this.lastGamma = e.gamma;

    if (this.betaBase === null) {
      this.betaBase = e.beta;
      this.gammaBase = e.gamma;
    }

    // Deltas in the *device* frame: gamma is roll (long edge), beta is pitch.
    const gDelta = e.gamma - this.gammaBase;
    const bDelta = e.beta - this.betaBase;

    // Rotate them into the screen frame, so holding the phone in landscape
    // does not swap or invert the controls.
    const rad = (this.screenAngle() * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const screenX = gDelta * cos + bDelta * sin;
    const screenY = bDelta * cos - gDelta * sin;

    // Tilting the top of the phone away lowers beta, and that should push the
    // marble away from the player -- hence the negation on y.
    this.tilt.set(
      THREE.MathUtils.clamp(screenX / TILT_RANGE, -1, 1),
      THREE.MathUtils.clamp(-screenY / TILT_RANGE, -1, 1),
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
