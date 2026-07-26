import * as THREE from 'three';
import { Collider } from '../physics/Physics';
import { SurfaceType } from '../render/SurfaceMaterial';
import { SHADOW_LAYER } from '../render/ShadowPass';
import type { LevelDef, BlockDef } from './levels';

/** Seconds a crumbling tile survives after first contact. */
const CRUMBLE_DELAY = 0.85;
/** Seconds before a fallen crumble tile comes back. */
const CRUMBLE_RESPAWN = 3.2;

/** Local-space box faces: outward normal plus the two in-plane axes. */
const FACES = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
] as const;

const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
] as const;

interface Buffers {
  position: number[];
  normal: number[];
  aColor: number[];
  aType: number[];
  aState: number[];
  aFaceUv: number[];
  aFaceSize: number[];
  index: number[];
}

function emptyBuffers(): Buffers {
  return { position: [], normal: [], aColor: [], aType: [], aState: [], aFaceUv: [], aFaceSize: [], index: [] };
}

const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _color = new THREE.Color();

/**
 * Appends one box to `buf`.
 *
 * `origin` lets dynamic blocks be built around their own centre so the mesh can
 * simply be repositioned each frame, while static blocks bake world position
 * straight into the vertices for a single merged draw call.
 */
function pushBox(buf: Buffers, def: BlockDef, origin: THREE.Vector3 | null): void {
  const [sx, sy, sz] = def.s;
  const type = def.type ?? SurfaceType.Normal;
  _color.setHex(def.color ?? defaultColor(type));

  if (def.rot) {
    // YXZ: ramps are authored as a yaw plus a pitch, and that order applies
    // the pitch in the already-yawed frame, which is what `ramp()` solves for.
    _q.setFromEuler(_e.set(
      THREE.MathUtils.degToRad(def.rot[0]),
      THREE.MathUtils.degToRad(def.rot[1]),
      THREE.MathUtils.degToRad(def.rot[2]),
      'YXZ',
    ));
  } else {
    _q.identity();
  }

  const ox = origin ? def.p[0] - origin.x : def.p[0];
  const oy = origin ? def.p[1] - origin.y : def.p[1];
  const oz = origin ? def.p[2] - origin.z : def.p[2];

  for (const face of FACES) {
    const base = buf.position.length / 3;

    const uSize = Math.abs(face.u[0] * sx) + Math.abs(face.u[1] * sy) + Math.abs(face.u[2] * sz);
    const vSize = Math.abs(face.v[0] * sx) + Math.abs(face.v[1] * sy) + Math.abs(face.v[2] * sz);

    _n.set(face.n[0], face.n[1], face.n[2]).applyQuaternion(_q);

    for (const [cu, cv] of CORNERS) {
      _v.set(
        (face.n[0] * 0.5 + face.u[0] * (cu - 0.5) + face.v[0] * (cv - 0.5)) * sx,
        (face.n[1] * 0.5 + face.u[1] * (cu - 0.5) + face.v[1] * (cv - 0.5)) * sy,
        (face.n[2] * 0.5 + face.u[2] * (cu - 0.5) + face.v[2] * (cv - 0.5)) * sz,
      );
      _v.applyQuaternion(_q);

      buf.position.push(_v.x + ox, _v.y + oy, _v.z + oz);
      buf.normal.push(_n.x, _n.y, _n.z);
      buf.aColor.push(_color.r, _color.g, _color.b);
      buf.aType.push(type);
      buf.aState.push(0);
      buf.aFaceUv.push(cu, cv);
      buf.aFaceSize.push(uSize, vSize);
    }

    buf.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
}

function toGeometry(buf: Buffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.position, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.normal, 3));
  g.setAttribute('aColor', new THREE.Float32BufferAttribute(buf.aColor, 3));
  g.setAttribute('aType', new THREE.Float32BufferAttribute(buf.aType, 1));
  g.setAttribute('aState', new THREE.Float32BufferAttribute(buf.aState, 1));
  g.setAttribute('aFaceUv', new THREE.Float32BufferAttribute(buf.aFaceUv, 2));
  g.setAttribute('aFaceSize', new THREE.Float32BufferAttribute(buf.aFaceSize, 2));
  g.setIndex(buf.index);
  g.computeBoundingSphere();
  return g;
}

export function defaultColor(type: SurfaceType): number {
  switch (type) {
    case SurfaceType.Ice: return 0x8fd6ef;
    case SurfaceType.Sticky: return 0x4a3f34;
    case SurfaceType.Boost: return 0x14e08a;
    case SurfaceType.Crumble: return 0x8a6f52;
    case SurfaceType.Goal: return 0xffcf5c;
    case SurfaceType.Kill: return 0x7a0f22;
    case SurfaceType.Bumper: return 0xff5ec4;
    case SurfaceType.Wall: return 0x3c4675;
    case SurfaceType.Checkpoint: return 0x4fb8ff;
    default: return 0x77809e;
  }
}

/** A block that needs per-frame work: it moves, crumbles, or animates. */
interface DynamicBlock {
  def: BlockDef;
  collider: Collider;
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  /** Base position; movers oscillate around this. */
  home: THREE.Vector3;
  state: number;
  /** Crumble: seconds of life left, or -1 while untouched. */
  fuse: number;
  /** Crumble: seconds until it comes back, or -1. */
  respawn: number;
  fallVelocity: number;
}

export class Level {
  readonly group = new THREE.Group();
  readonly colliders: Collider[] = [];
  readonly spawn = new THREE.Vector3();
  readonly goalPosition = new THREE.Vector3();
  /** Falling below this y counts as a death. */
  readonly killY: number;
  readonly def: LevelDef;

  private readonly dynamics: DynamicBlock[] = [];
  private readonly byCollider = new Map<Collider, DynamicBlock>();
  /** Every collider's source definition -- the game reads boost vectors from it. */
  readonly defByCollider = new Map<Collider, BlockDef>();
  private readonly staticMesh: THREE.Mesh | null = null;
  private readonly staticGeometry: THREE.BufferGeometry | null = null;
  /** Checkpoint colliders, in the order they were defined. */
  readonly checkpoints: { collider: Collider; block: DynamicBlock | null; taken: boolean }[] = [];

  constructor(def: LevelDef, material: THREE.ShaderMaterial) {
    this.def = def;
    this.spawn.set(def.spawn[0], def.spawn[1], def.spawn[2]);

    const staticBuf = emptyBuffers();
    let lowest = Infinity;

    for (const block of def.blocks) {
      const type = block.type ?? SurfaceType.Normal;
      lowest = Math.min(lowest, block.p[1] - block.s[1] / 2);

      const center = new THREE.Vector3(block.p[0], block.p[1], block.p[2]);
      const half = new THREE.Vector3(block.s[0] / 2, block.s[1] / 2, block.s[2] / 2);
      const quat = new THREE.Quaternion();
      if (block.rot) {
        quat.setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(block.rot[0]),
          THREE.MathUtils.degToRad(block.rot[1]),
          THREE.MathUtils.degToRad(block.rot[2]),
          'YXZ',
        ));
      }

      const collider = new Collider(center, half, quat);
      collider.type = type;
      this.colliders.push(collider);
      this.defByCollider.set(collider, block);

      if (type === SurfaceType.Goal) {
        this.goalPosition.set(block.p[0], block.p[1] + block.s[1] / 2, block.p[2]);
      }

      const isDynamic =
        !!block.move ||
        type === SurfaceType.Crumble ||
        type === SurfaceType.Goal ||
        type === SurfaceType.Bumper ||
        type === SurfaceType.Checkpoint;

      if (isDynamic) {
        const buf = emptyBuffers();
        pushBox(buf, block, center);
        const geometry = toGeometry(buf);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.copy(center);
        mesh.frustumCulled = false;
        mesh.layers.enable(SHADOW_LAYER);
        this.group.add(mesh);

        const dyn: DynamicBlock = {
          def: block, collider, mesh, geometry,
          home: center.clone(), state: 0, fuse: -1, respawn: -1, fallVelocity: 0,
        };
        this.dynamics.push(dyn);

        this.byCollider.set(collider, dyn);

        if (type === SurfaceType.Checkpoint) {
          this.checkpoints.push({ collider, block: dyn, taken: false });
        }
      } else {
        pushBox(staticBuf, block, null);
      }
    }

    if (staticBuf.position.length > 0) {
      this.staticGeometry = toGeometry(staticBuf);
      this.staticMesh = new THREE.Mesh(this.staticGeometry, material);
      this.staticMesh.layers.enable(SHADOW_LAYER);
      this.staticMesh.frustumCulled = false;
      this.group.add(this.staticMesh);
    }

    this.killY = lowest - 24;
  }

  /** Marks the crumble tile under the marble as triggered. */
  triggerCrumble(collider: Collider): void {
    const dyn = this.byCollider.get(collider);
    if (dyn && dyn.def.type === SurfaceType.Crumble && dyn.fuse < 0 && dyn.respawn < 0) {
      dyn.fuse = CRUMBLE_DELAY;
    }
  }

  /** Flashes a bumper that was just hit. */
  flashBumper(collider: Collider): void {
    const dyn = this.byCollider.get(collider);
    if (dyn) dyn.state = 1;
  }

  /** Returns true if this collider is a not-yet-collected checkpoint. */
  takeCheckpoint(collider: Collider): boolean {
    const cp = this.checkpoints.find((c) => c.collider === collider);
    if (!cp || cp.taken) return false;
    cp.taken = true;
    if (cp.block) cp.block.state = 1;
    return true;
  }

  update(dt: number, time: number): void {
    for (const dyn of this.dynamics) {
      const { def, collider, mesh } = dyn;

      // --- movers ------------------------------------------------------------
      if (def.move) {
        const period = def.move.period;
        const phase = def.move.phase ?? 0;
        const theta = ((time / period) + phase) * Math.PI * 2;
        // Cosine ease so platforms settle at each end instead of snapping.
        const t = 0.5 - 0.5 * Math.cos(theta);
        const dx = def.move.to[0] - def.p[0];
        const dy = def.move.to[1] - def.p[1];
        const dz = def.move.to[2] - def.p[2];

        collider.center.set(
          dyn.home.x + dx * t,
          dyn.home.y + dy * t,
          dyn.home.z + dz * t,
        );

        // Analytic derivative of the easing -- exact platform velocity, which
        // the physics needs to carry the marble smoothly.
        const dtdTheta = 0.5 * Math.sin(theta);
        const omega = (Math.PI * 2) / period;
        collider.velocity.set(dx, dy, dz).multiplyScalar(dtdTheta * omega);
        collider.refresh();
        mesh.position.copy(collider.center);
      }

      // --- crumbling ----------------------------------------------------------
      if (def.type === SurfaceType.Crumble) {
        if (dyn.fuse > 0) {
          dyn.fuse -= dt;
          dyn.state = 1 - Math.max(0, dyn.fuse) / CRUMBLE_DELAY;
          // Nervous shake as it is about to give way.
          const shake = dyn.state * 0.06;
          mesh.position.set(
            dyn.home.x + Math.sin(time * 47) * shake,
            dyn.home.y + Math.sin(time * 61) * shake,
            dyn.home.z + Math.cos(time * 53) * shake,
          );
          if (dyn.fuse <= 0) {
            collider.active = false;
            dyn.respawn = CRUMBLE_RESPAWN;
            dyn.fallVelocity = 0;
          }
        } else if (dyn.respawn > 0) {
          dyn.respawn -= dt;
          dyn.fallVelocity -= 26 * dt;
          mesh.position.y += dyn.fallVelocity * dt;
          mesh.rotation.z += dt * 1.4;
          mesh.rotation.x += dt * 0.9;
          if (dyn.respawn <= 0) {
            // Reset and re-arm.
            mesh.position.copy(dyn.home);
            mesh.rotation.set(0, 0, 0);
            dyn.state = 0;
            dyn.fuse = -1;
            dyn.respawn = -1;
            collider.active = true;
          }
        }
      }

      // --- decaying flashes ------------------------------------------------
      if (def.type === SurfaceType.Bumper && dyn.state > 0) {
        dyn.state = Math.max(0, dyn.state - dt * 3.5);
      }
      if (def.type === SurfaceType.Goal) {
        dyn.state = 0.35 + 0.35 * Math.sin(time * 2.4);
      }

      this.writeState(dyn);
    }
  }

  /** Pushes a block's animation state into its vertex attribute. */
  private writeState(dyn: DynamicBlock): void {
    const attr = dyn.geometry.getAttribute('aState') as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    if (arr[0] === dyn.state) return;
    arr.fill(dyn.state);
    attr.needsUpdate = true;
  }

  /** Rewinds every crumble tile and checkpoint flash; used on respawn. */
  resetVolatiles(): void {
    for (const dyn of this.dynamics) {
      if (dyn.def.type !== SurfaceType.Crumble) continue;
      dyn.mesh.position.copy(dyn.home);
      dyn.mesh.rotation.set(0, 0, 0);
      dyn.state = 0;
      dyn.fuse = -1;
      dyn.respawn = -1;
      dyn.collider.active = true;
      this.writeState(dyn);
    }
  }

  dispose(): void {
    this.staticGeometry?.dispose();
    for (const dyn of this.dynamics) dyn.geometry.dispose();
    this.group.clear();
  }
}
