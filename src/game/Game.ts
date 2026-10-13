import * as THREE from 'three';

import { Engine } from '../core/Engine';
import { Input, type ControlMode, type TiltResult } from '../core/Input';
import { Audio } from '../core/Audio';
import { UI } from '../ui/UI';

import { Environment, THEMES } from '../render/Environment';
import { ShadowPass, SHADOW_LAYER } from '../render/ShadowPass';
import { PostFX } from '../render/Post';
import { Sparks } from '../render/Sparks';
import { createSurfaceMaterial, SurfaceType } from '../render/SurfaceMaterial';
import { createMarbleMaterial, createContactShadow } from '../render/MarbleMaterial';

import { Collider, MarbleBody, SURFACE_PROPS, step, type Contact } from '../physics/Physics';
import { Level } from './Level';
import { LEVELS } from './levels';
import { loadProgress, saveProgress, type Progress } from './Progress';

type State = 'menu' | 'levels' | 'playing' | 'paused' | 'complete' | 'failed';

const UP = new THREE.Vector3(0, 1, 0);

const GRAVITY = -34;
/**
 * Steering authority. Lower than it was: once the marble actually holds its
 * momentum, high authority lets you cancel it on a whim and the course stops
 * being about managing speed.
 */
const ACCEL = 30;
const MAX_SPEED = 30;
/**
 * Velocity-proportional damping. Not really air resistance -- it is the speed
 * limiter that keeps a nearly frictionless marble from running away, and it
 * has to stay gentle or it becomes the drag we just removed.
 */
const AIR_DRAG = 0.12;
const JUMP_SPEED = 12.5;
/** How long after leaving the ground a jump still counts. */
const COYOTE_TIME = 0.12;
const BOOST_COOLDOWN = 0.35;
const RESPAWN_DELAY = 0.9;

export class Game {
  private readonly engine: Engine;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;

  private readonly env = new Environment();
  private readonly shadow = new ShadowPass(1024, 24);
  private readonly post = new PostFX();
  private readonly sparks = new Sparks();
  /** Spray thrown off by wheelspin. Solid, so it shows up over bright ice. */
  private readonly spray = new Sparks(true, 10);

  private readonly surfaceMaterial: THREE.ShaderMaterial;
  private readonly marbleMaterial: THREE.ShaderMaterial;
  private readonly marbleMesh: THREE.Mesh;
  private readonly contactShadow: THREE.Mesh;

  private readonly input: Input;
  private readonly audio = new Audio();
  private readonly ui: UI;

  private readonly body = new MarbleBody();
  private readonly contacts: Contact[] = [];
  private level: Level | null = null;
  private levelIndex = 0;
  /** How many courses exist; read by tools/reachability-audit.js. */
  readonly levelCount = LEVELS.length;

  private state: State = 'menu';
  private progress: Progress;
  /** Explains the last tilt-enable attempt on the title screen. */
  private tiltNote = '';

  private elapsed = 0;
  private deaths = 0;
  private readonly respawnPoint = new THREE.Vector3();
  private respawnTimer = 0;
  private boostCooldown = 0;
  /** Seconds until the next puff of spray from a slipping ball. */
  private sprayTimer = 0;
  private readonly sprayDir = new THREE.Vector3();
  private jumpArmed = true;
  private charge = 0;
  private hurt = 0;
  private readonly flash = new THREE.Vector4();

  private readonly accel = new THREE.Vector3();
  /** The share of steering the ground could not take; it spins the ball. */
  private readonly wheelspin = new THREE.Vector3();
  private readonly camForward = new THREE.Vector3(0, 0, -1);
  private readonly camRight = new THREE.Vector3(1, 0, 0);
  private readonly camOffset = new THREE.Vector3();
  private readonly camTarget = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  /** Smoothed look-at point; lerping this is what keeps the camera calm. */
  private readonly camLookSmoothed = new THREE.Vector3();
  private camDistance = 14;
  private camHeight = 11.5;
  private camInitialised = false;
  /** 0..1 extra pitch applied to keep the marble in sight. */
  private cameraLift = 0;
  private readonly camProbe = new THREE.Vector3();
  private readonly occluders: Collider[] = [];

  private readonly tmp = new THREE.Vector3();
  private readonly sparkColor = new THREE.Color();

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.engine = new Engine(canvas);
    this.ui = new UI(uiRoot);
    this.input = new Input();
    this.progress = loadProgress();

    this.camera = new THREE.PerspectiveCamera(52, 1, 0.4, 320);

    this.surfaceMaterial = createSurfaceMaterial(this.env, this.shadow);
    this.marbleMaterial = createMarbleMaterial(this.env, this.shadow);

    this.marbleMesh = new THREE.Mesh(
      new THREE.IcosahedronGeometry(this.body.radius, 5),
      this.marbleMaterial,
    );
    this.marbleMesh.layers.enable(SHADOW_LAYER);
    this.marbleMesh.frustumCulled = false;

    this.contactShadow = createContactShadow();

    this.scene.add(this.env.mesh, this.marbleMesh, this.contactShadow, this.sparks.points, this.spray.points);

    this.input.attach(this.ui.stick, this.ui.nub, this.ui.jump);
    this.ui.onPause(() => this.togglePause());

    // Backgrounding the tab stops the render loop, which means setRolling()
    // stops being called and the rolling noise would hang at its last value.
    document.addEventListener('visibilitychange', this.onVisibility);

    this.engine.setHooks({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      update: (dt) => this.update(dt),
      render: () => this.render(),
      resize: (w, h) => this.resize(w, h),
    });

    this.showMenu();
    this.engine.start();
  }

  /* --------------------------------------------------------------- screens */

  private showMenu(): void {
    this.state = 'menu';
    this.input.release();
    this.ui.showTitle(
      {
        onStart: () => void this.launch(Math.min(this.progress.unlocked, LEVELS.length - 1)),
        onLevels: () => this.showLevelSelect(),
        onToggleControls: () => void this.toggleControls(),
      },
      // The saved preference, not the live mode: tilt shows as selected before
      // it has actually been switched on, because switching it on needs a tap.
      this.progress.controls,
      this.input.tiltAvailable,
      this.tiltNote,
    );

    // Idle camera: a slow orbit over the first course so the menu is not static.
    if (!this.level) this.loadLevel(0);
    this.body.reset(...(LEVELS[0].spawn as [number, number, number]));
  }

  private showLevelSelect(): void {
    this.state = 'levels';
    this.ui.showLevelSelect(
      LEVELS.map((l) => ({ id: l.id, name: l.name })),
      // Dev builds open every course, so a level can be tested on a phone
      // without replaying everything before it. Progress itself is untouched.
      import.meta.env.DEV ? LEVELS.length - 1 : this.progress.unlocked,
      this.progress.bests,
      (index) => void this.launch(index),
      () => this.showMenu(),
    );
  }

  /**
   * Starts a course, restoring tilt first if that is what the player picked
   * last time.
   *
   * This exists because the motion permission cannot be re-granted at load:
   * it needs a user gesture. The tap that starts the run is that gesture, so
   * neither `requestTilt()` nor `audio.start()` may sit behind an await --
   * both reach their gesture-sensitive call synchronously.
   */
  private async launch(index: number): Promise<void> {
    const restoringTilt = this.progress.controls === 'tilt' && this.input.mode !== 'tilt';
    const tiltPending = restoringTilt ? this.input.requestTilt() : null;
    void this.audio.start();

    if (tiltPending) {
      this.applyTiltResult(await tiltPending);
      // A failed restore falls back to the stick; do not keep asking forever.
      if (this.input.mode !== 'tilt') this.setPreferredControls('stick');
    }

    this.beginLevel(index);
  }

  private setPreferredControls(mode: ControlMode): void {
    this.progress.controls = mode;
    saveProgress(this.progress);
  }

  /** Applies a tilt request outcome: mode, explanation, and toast. */
  private applyTiltResult(result: TiltResult): void {
    switch (result) {
      case 'granted':
        this.input.setMode('tilt');
        this.input.calibrate();
        this.tiltNote = 'Tilt on. However you are holding the phone right now is level.';
        this.ui.toast('Tilt enabled', '#58f7ff');
        return;
      case 'denied':
        // Note: there is no "Motion & Orientation Access" switch to send people
        // to any more -- Apple removed it. Safari now remembers the refusal per
        // origin, and Prevent Cross-Site Tracking can block the sensors outright.
        this.tiltNote =
          'Safari is refusing motion access for this site. Try, in order: ' +
          '1) turn OFF Settings > Apps > Safari > Prevent Cross-Site Tracking. ' +
          '2) delete this site under Settings > Apps > Safari > Advanced > Website Data ' +
          '(Safari caches the refusal and will not ask twice). Then reload and tap Tilt again.';
        break;
      case 'no-gesture':
        this.tiltNote =
          'The browser did not count that as a tap, so it never asked. Tap TILT once more.';
        break;
      case 'insecure':
        this.tiltNote =
          'Tilt needs a secure (https) connection. On the phone this means running the server with npm run dev:https.';
        break;
      case 'unsupported':
        this.tiltNote = 'This device has no orientation sensor.';
        break;
      case 'no-data':
        this.tiltNote = 'Permission granted, but no sensor readings arrived. Staying on the stick.';
        break;
    }

    this.input.setMode('stick');
    this.ui.toast('Tilt unavailable', '#ff4d8d');
    // Surface the raw reason too -- "denied" covers several distinct causes
    // and the exact one is what makes it fixable.
    if (this.input.lastTiltError) {
      this.tiltNote += `  [${result}: ${this.input.lastTiltError}]`;
    }
  }

  private async toggleControls(): Promise<void> {
    if (this.progress.controls === 'tilt') {
      this.input.setMode('stick');
      this.setPreferredControls('stick');
      this.tiltNote = '';
      if (this.state === 'menu') this.showMenu();
      return;
    }

    // requestTilt() must see the user gesture, so it is called without any
    // awaits in front of it.
    this.applyTiltResult(await this.input.requestTilt());
    this.setPreferredControls(this.input.mode);

    // Redraw the title so the selector and the note match.
    if (this.state === 'menu') this.showMenu();
  }

  /* ---------------------------------------------------------------- levels */

  private loadLevel(index: number): void {
    this.level?.dispose();
    if (this.level) this.scene.remove(this.level.group);

    const def = LEVELS[index];
    this.levelIndex = index;
    this.level = new Level(def, this.surfaceMaterial);
    this.scene.add(this.level.group);

    this.env.applyTheme(THEMES[def.theme] ?? THEMES.dawn);

    const yaw = THREE.MathUtils.degToRad(def.camYaw);
    this.camForward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.camRight.set(Math.cos(yaw), 0, -Math.sin(yaw));
    this.camOffset.set(Math.sin(yaw), 0, Math.cos(yaw));
    this.camDistance = def.camDistance ?? 14;
    this.camHeight = def.camHeight ?? 11.5;
    this.camInitialised = false;
  }

  private beginLevel(index: number): void {
    this.loadLevel(index);
    const def = LEVELS[index];

    this.state = 'playing';
    this.elapsed = 0;
    this.deaths = 0;
    this.respawnTimer = 0;
    this.boostCooldown = 0;
    this.charge = 0;
    this.hurt = 0;
    this.jumpArmed = true;
    this.sparks.clear();
    this.spray.clear();

    this.respawnPoint.set(...(def.spawn as [number, number, number]));
    this.body.reset(this.respawnPoint.x, this.respawnPoint.y, this.respawnPoint.z);

    this.ui.setLevel(`${def.id}. ${def.name}`);
    this.ui.setDeaths(0);
    this.ui.setTime(def.par, false);
    this.ui.showCountdown(def.name, def.hint);
    // After showCountdown, which resets the chrome wholesale.
    this.ui.setStickVisible(this.input.mode === 'stick');
  }

  private restartLevel(): void {
    this.beginLevel(this.levelIndex);
  }

  private completeLevel(): void {
    if (this.state !== 'playing') return;
    this.state = 'complete';
    this.input.release();
    this.audio.goal();
    this.audio.setRolling(0, false, 1);
    this.flash.set(1.0, 0.85, 0.4, 1.4);

    const def = LEVELS[this.levelIndex];
    const previous = this.progress.bests[def.id] ?? null;
    const isNewBest = previous === null || this.elapsed < previous;
    if (isNewBest) this.progress.bests[def.id] = this.elapsed;

    const isLast = this.levelIndex >= LEVELS.length - 1;
    if (!isLast) {
      this.progress.unlocked = Math.max(this.progress.unlocked, this.levelIndex + 1);
    }
    saveProgress(this.progress);

    this.sparks.burst(
      this.level!.goalPosition, new THREE.Vector3(0, 1, 0), 90, 16,
      this.sparkColor.setHex(0xffd166), this.engine.time, 0.7,
    );

    this.ui.showComplete(
      {
        levelName: def.name,
        time: this.elapsed,
        best: this.progress.bests[def.id] ?? this.elapsed,
        isNewBest,
        deaths: this.deaths,
        isLast,
      },
      () => this.beginLevel(Math.min(this.levelIndex + 1, LEVELS.length - 1)),
      () => this.restartLevel(),
      () => this.showMenu(),
    );
  }

  private failLevel(reason: string, message: string): void {
    if (this.state !== 'playing') return;
    this.state = 'failed';
    this.input.release();
    this.audio.death();
    this.audio.setRolling(0, false, 1);
    this.ui.showFailed(reason, message, () => this.restartLevel(), () => this.showMenu());
  }

  private togglePause(): void {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.input.release();
      this.audio.setRolling(0, false, 1);
      this.ui.showPaused(
        () => {
          this.state = 'playing';
          this.ui.clearOverlay();
        },
        () => this.restartLevel(),
        () => this.showMenu(),
        this.input.mode === 'tilt' ? () => {
          this.input.calibrate();
          this.ui.toast('Re-centred', '#58f7ff');
        } : null,
      );
    } else if (this.state === 'paused') {
      this.state = 'playing';
      this.ui.clearOverlay();
    }
  }

  /* ----------------------------------------------------------------- death */

  private die(cause: 'fall' | 'hazard'): void {
    if (this.respawnTimer > 0 || this.state !== 'playing') return;

    this.deaths++;
    this.respawnTimer = RESPAWN_DELAY;
    this.hurt = 1;
    this.flash.set(1.0, 0.15, 0.25, 1.1);
    this.audio.death();
    this.ui.setDeaths(this.deaths);

    if (cause === 'hazard') {
      this.sparks.burst(
        this.body.position, new THREE.Vector3(0, 1, 0), 46, 13,
        this.sparkColor.setHex(0xff3355), this.engine.time, 0.9,
      );
    }
    this.body.velocity.multiplyScalar(0.1);
  }

  private respawn(): void {
    this.body.reset(this.respawnPoint.x, this.respawnPoint.y, this.respawnPoint.z);
    this.level?.resetVolatiles();
    this.jumpArmed = true;
    this.camInitialised = false;
    this.sparks.burst(
      this.body.position, new THREE.Vector3(0, 1, 0), 26, 8,
      this.sparkColor.setHex(0x58f7ff), this.engine.time, 0.9,
    );
  }

  /* ------------------------------------------------------------ simulation */

  private fixedUpdate(dt: number): void {
    const level = this.level;
    if (!level) return;

    const simulating = this.state === 'playing';
    level.update(dt, this.engine.time);

    if (!simulating) return;

    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn();
      // Keep falling while dead, but no steering.
      this.accel.set(0, 0, 0);
      this.wheelspin.set(0, 0, 0);
    } else {
      this.input.update();
      const control = this.body.grounded && this.body.groundCollider
        ? SURFACE_PROPS[this.body.groundCollider.type].control
        : 1;

      this.accel
        .copy(this.camRight).multiplyScalar(this.input.move.x)
        .addScaledVector(this.camForward, this.input.move.y)
        .multiplyScalar(ACCEL);
      // Whatever the surface cannot transmit goes into wheelspin.
      this.wheelspin.copy(this.accel).multiplyScalar(this.body.grounded ? 1 - control : 0);
      this.accel.multiplyScalar(control);

      if (this.input.jumpPressed && this.jumpArmed &&
          (this.body.grounded || this.body.timeSinceGrounded < COYOTE_TIME)) {
        // Jump along a blend of the ground normal and world up, so a ramp
        // kicks you outward but never sideways enough to lose control.
        this.tmp.copy(this.body.groundNormal).lerp(UP, 0.55).normalize();
        this.body.velocity.addScaledVector(this.tmp, JUMP_SPEED - Math.max(0, this.body.velocity.dot(this.tmp)));
        this.jumpArmed = false;
        this.audio.jump();
        this.sparks.burst(
          this.body.position, this.body.groundNormal, 12, 5,
          this.sparkColor.setHex(0x9fd8ff), this.engine.time, 0.85,
        );
      }
    }

    step(this.body, level.colliders, dt, {
      gravity: GRAVITY,
      accel: this.accel,
      drag: AIR_DRAG,
      maxSpeed: MAX_SPEED,
      wheelspin: this.wheelspin,
    }, this.contacts);

    if (this.body.grounded) this.jumpArmed = true;

    this.boostCooldown = Math.max(0, this.boostCooldown - dt);
    this.sprayFromSlip(dt);
    this.handleContacts(level);

    if (this.body.position.y < level.killY) this.die('fall');

    this.elapsed += dt;
    if (this.elapsed >= LEVELS[this.levelIndex].par) {
      this.failLevel('Time Up', `${LEVELS[this.levelIndex].name} beat you by the clock. ${this.deaths} fall${this.deaths === 1 ? '' : 's'}.`);
    }
  }

  /**
   * A spinning, slipping ball throws a rooster tail of spray the way its
   * contact point is scraping -- behind it, up and out where it can be seen.
   * Puffed straight up from the contact point, the marble itself hid it and
   * the pale ice swallowed what was left.
   */
  private sprayFromSlip(dt: number): void {
    this.sprayTimer -= dt;
    const body = this.body;
    const slip = body.slipSpeed;
    if (slip < 3 || !body.grounded || this.sprayTimer > 0) return;
    // Faster slip, denser spray.
    this.sprayTimer = THREE.MathUtils.lerp(0.07, 0.025, Math.min(1, (slip - 3) / 12));

    const dir = this.sprayDir.copy(body.slip).divideScalar(slip)
      .addScaledVector(body.groundNormal, 0.8).normalize();
    // Out from behind the ball rather than underneath it.
    this.tmp.copy(body.position)
      .addScaledVector(body.groundNormal, -body.radius * 0.6)
      .addScaledVector(body.slip, body.radius * 0.9 / slip);
    this.spray.burst(
      this.tmp, dir, 6, 5 + slip * 0.45,
      this.sparkColor.setHex(0xf2fbff), this.engine.time, 0.35,
    );
  }

  private handleContacts(level: Level): void {
    const dying = this.respawnTimer > 0;

    for (const contact of this.contacts) {
      const { collider, normal, impactSpeed } = contact;

      // Impact feedback, regardless of surface kind.
      if (impactSpeed > 3.2) {
        this.audio.impact(impactSpeed);
        if (impactSpeed > 6) {
          this.sparks.burst(
            contact.point, normal, Math.min(14, Math.round(impactSpeed)), impactSpeed * 0.4,
            this.sparkColor.setHex(0xffd9a0), this.engine.time, 0.75,
          );
        }
      }

      if (dying) continue;

      switch (collider.type) {
        case SurfaceType.Goal:
          this.completeLevel();
          return;

        case SurfaceType.Kill:
          this.die('hazard');
          return;

        case SurfaceType.Crumble:
          if (normal.y > 0.45) level.triggerCrumble(collider);
          break;

        case SurfaceType.Bumper: {
          // Only a real hit. Resting or grazing contact reports every substep,
          // and firing on that turned the bumper into a 120Hz beeper.
          if (impactSpeed < 2) break;
          level.flashBumper(collider);
          this.audio.bumper();
          this.charge = Math.min(1, this.charge + 0.6);
          this.sparks.burst(
            contact.point, normal, 18, 11,
            this.sparkColor.setHex(0xff5ec4), this.engine.time, 0.8,
          );
          break;
        }

        case SurfaceType.Checkpoint:
          if (level.takeCheckpoint(collider)) {
            this.respawnPoint.copy(collider.center).setY(collider.max.y + this.body.radius + 0.2);
            this.audio.checkpoint();
            this.ui.toast('Checkpoint', '#58f7ff');
            this.sparks.burst(
              contact.point, UP, 22, 7,
              this.sparkColor.setHex(0x4fb8ff), this.engine.time, 0.9,
            );
          }
          break;

        case SurfaceType.Boost: {
          if (this.boostCooldown > 0) break;
          const def = level.defByCollider.get(collider);
          if (!def?.boost) break;

          this.boostCooldown = BOOST_COOLDOWN;
          this.tmp.set(def.boost.dir[0], def.boost.dir[1], def.boost.dir[2]).normalize();
          // Replace the velocity along the boost axis rather than adding to it,
          // so hitting a pad fast does not stack into something uncontrollable.
          const along = this.body.velocity.dot(this.tmp);
          this.body.velocity.addScaledVector(this.tmp, Math.max(0, def.boost.power - along));
          this.charge = 1;
          this.audio.boost();
          this.sparks.burst(
            contact.point, this.tmp, 24, 10,
            this.sparkColor.setHex(0x14e08a), this.engine.time, 0.6,
          );
          break;
        }
      }
    }
  }

  /* ----------------------------------------------------------------- visual */

  private update(dt: number): void {
    const time = this.engine.time;

    this.charge = Math.max(0, this.charge - dt * 1.8);
    this.hurt = Math.max(0, this.hurt - dt * 2.2);
    this.flash.w = Math.max(0, this.flash.w - dt * 2.6);

    // Marble transform.
    this.marbleMesh.position.copy(this.body.position);
    this.marbleMesh.quaternion.copy(this.body.spin);
    this.marbleMesh.visible = this.respawnTimer <= 0 || Math.sin(time * 40) > 0;

    const speed = this.body.velocity.length();
    this.marbleMaterial.uniforms.uCharge.value = this.charge;
    this.marbleMaterial.uniforms.uHurt.value = this.hurt;
    this.marbleMaterial.uniforms.uSpeed.value = speed;

    this.updateContactShadow();
    this.updateCamera(dt, speed);

    // Post state.
    this.post.speedBlur = THREE.MathUtils.clamp((speed - 13) / 22, 0, 1) * 0.9;
    this.post.setFlash(this.flash.x, this.flash.y, this.flash.z, this.flash.w);
    // Only worth a full-screen pass when the effective resolution is low enough
    // for aliasing to actually show -- which is also when the pass is cheapest.
    const effectiveDpr =
      Math.min(window.devicePixelRatio || 1, this.engine.maxPixelRatio) * this.engine.renderScale;
    this.post.fxaa = effectiveDpr < 1.6;

    this.env.update(time, this.camera);
    this.sparks.update(time, this.engine.drawHeight);
    this.spray.update(time, this.engine.drawHeight);

    // HUD.
    if (this.state === 'playing') {
      const remaining = Math.max(0, LEVELS[this.levelIndex].par - this.elapsed);
      this.ui.setTime(remaining, remaining < 10);
      if (remaining < 10 && Math.floor(remaining) !== Math.floor(remaining + dt)) {
        this.audio.countdown();
      }
    }

    // Audio.
    const grip = this.body.groundCollider
      ? THREE.MathUtils.clamp(SURFACE_PROPS[this.body.groundCollider.type].friction, 0, 1)
      : 1;
    this.audio.setRolling(
      speed,
      this.body.grounded && this.state === 'playing' && this.respawnTimer <= 0,
      grip,
    );

    this.input.setJumpAvailable(this.jumpArmed && this.body.timeSinceGrounded < COYOTE_TIME);
    this.input.endFrame();
  }

  /** Ray-free ground probe: find the highest surface directly below the ball. */
  private updateContactShadow(): void {
    const level = this.level;
    if (!level) {
      this.contactShadow.visible = false;
      return;
    }

    const p = this.body.position;
    let groundY = -Infinity;

    for (const c of level.colliders) {
      if (!c.active) continue;
      if (p.x < c.min.x - 0.3 || p.x > c.max.x + 0.3) continue;
      if (p.z < c.min.z - 0.3 || p.z > c.max.z + 0.3) continue;
      if (c.max.y > p.y + 0.05) continue;
      if (c.max.y > groundY) groundY = c.max.y;
    }

    const drop = p.y - groundY;
    if (!isFinite(groundY) || drop > 14) {
      this.contactShadow.visible = false;
      return;
    }

    this.contactShadow.visible = this.marbleMesh.visible;
    this.contactShadow.position.set(p.x, groundY + 0.03, p.z);
    // Bigger and fainter the further the ball is from the floor.
    const spread = 1 + drop * 0.22;
    this.contactShadow.scale.setScalar(this.body.radius * 3.6 * spread);
    (this.contactShadow.material as THREE.ShaderMaterial).uniforms.uOpacity.value =
      Math.max(0, 1 - drop / 14) * 0.85;
  }

  /**
   * Where the camera wants to sit for a given `lift`.
   *
   * lift 0 is the level's authored framing; lift 1 is steeply overhead and
   * closer in, which is how we get a clear line to the marble when a wall is
   * in the way.
   */
  private computeCamPos(out: THREE.Vector3, lift: number, speed: number): void {
    // Pull back a little as speed rises, so fast sections show more track.
    const distance = (this.camDistance + Math.min(speed * 0.14, 3.5)) * (1 - lift * 0.28);
    const height = (this.camHeight + Math.min(speed * 0.08, 2.2)) * (1 + lift * 0.95);

    out.copy(this.body.position).addScaledVector(this.camOffset, distance);
    out.y = this.body.position.y + height;
  }

  /**
   * True if level geometry sits between the marble and `camPos`.
   *
   * Every course is walled, so without this the marble regularly disappears
   * behind a rail. Sampling points along the segment against collider AABBs is
   * far cheaper than a real sweep and is accurate enough at this scale.
   */
  private sightBlocked(camPos: THREE.Vector3): boolean {
    const level = this.level;
    if (!level) return false;

    const target = this.body.position;
    const minX = Math.min(camPos.x, target.x), maxX = Math.max(camPos.x, target.x);
    const minY = Math.min(camPos.y, target.y), maxY = Math.max(camPos.y, target.y);
    const minZ = Math.min(camPos.z, target.z), maxZ = Math.max(camPos.z, target.z);

    this.occluders.length = 0;
    for (const c of level.colliders) {
      if (!c.active) continue;
      // Pads are too thin to ever hide the ball, and skipping them keeps the
      // camera from lurching when you roll over a boost strip.
      if (c.max.y - c.min.y < 0.6) continue;
      if (c.max.x < minX || c.min.x > maxX) continue;
      if (c.max.y < minY || c.min.y > maxY) continue;
      if (c.max.z < minZ || c.min.z > maxZ) continue;
      this.occluders.push(c);
    }
    if (this.occluders.length === 0) return false;

    // Sample right from the marble outwards. The blocking geometry is usually
    // the wall the marble is touching, so skipping the near samples -- which is
    // the obvious way to avoid self-hits on the floor -- misses the common case.
    // The floor is never a false positive here: the segment only ever goes up.
    const SAMPLES = 16;
    for (let i = 1; i <= SAMPLES; i++) {
      const t = i / SAMPLES;
      this.tmp.lerpVectors(target, camPos, t);
      for (const c of this.occluders) {
        if (c === this.body.groundCollider) continue;
        if (
          this.tmp.x > c.min.x && this.tmp.x < c.max.x &&
          this.tmp.y > c.min.y && this.tmp.y < c.max.y &&
          this.tmp.z > c.min.z && this.tmp.z < c.max.z
        ) return true;
      }
    }
    return false;
  }

  private updateCamera(dt: number, speed: number): void {
    // Find the least amount of lift that gives a clear view, then ease towards
    // it. Solving for a target every frame (rather than nudging a feedback
    // loop) is what keeps this from oscillating.
    let wanted = 1;
    for (let k = 0; k < 5; k++) {
      const lift = k / 4;
      this.computeCamPos(this.camProbe, lift, speed);
      if (!this.sightBlocked(this.camProbe)) { wanted = lift; break; }
    }
    // Rise quickly to uncover the ball, settle back down slowly.
    const rate = wanted > this.cameraLift ? 9 : 2.5;
    this.cameraLift += (wanted - this.cameraLift) * (1 - Math.exp(-rate * dt));

    this.computeCamPos(this.camTarget, this.cameraLift, speed);

    // Look slightly ahead of the marble along its own velocity.
    this.tmp.copy(this.body.velocity).setY(0).clampLength(0, 16).multiplyScalar(0.22);
    this.camLook.copy(this.body.position).add(this.tmp);

    if (!this.camInitialised) {
      // Snap the lift too, so a level that starts against a wall opens on a
      // clear view rather than easing into one.
      this.cameraLift = wanted;
      this.computeCamPos(this.camTarget, this.cameraLift, speed);
      this.camera.position.copy(this.camTarget);
      this.camLookSmoothed.copy(this.camLook);
      this.camera.lookAt(this.camLookSmoothed);
      this.camInitialised = true;
      return;
    }

    // Frame-rate independent exponential smoothing.
    this.camera.position.lerp(this.camTarget, 1 - Math.exp(-8 * dt));
    this.camLookSmoothed.lerp(this.camLook, 1 - Math.exp(-11 * dt));
    this.camera.lookAt(this.camLookSmoothed);
  }

  /* ------------------------------------------------------------------ frame */

  private render(): void {
    this.camera.updateMatrixWorld();
    this.shadow.render(this.engine.renderer, this.scene, this.body.position);
    this.engine.renderer.setClearColor(0x000000, 1);
    this.post.render(this.engine.renderer, this.scene, this.camera, this.engine.time);
  }

  private resize(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
    this.post.setSize(width, height);
  }

  private onVisibility = (): void => {
    this.audio.setMuted(document.hidden);
    // Coming back to a running clock is unfair, so pause instead.
    if (document.hidden && this.state === 'playing') this.togglePause();
  };

  dispose(): void {
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.engine.dispose();
    this.input.dispose();
    this.audio.dispose();
    this.post.dispose();
    this.shadow.dispose();
    this.sparks.dispose();
    this.spray.dispose();
    this.level?.dispose();
    this.env.dispose();
  }
}
