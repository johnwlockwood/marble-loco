import * as THREE from 'three';
import { SurfaceType } from '../render/SurfaceMaterial';

/**
 * How each surface kind behaves.
 *
 * There are two friction coefficients, and the distinction is the whole reason
 * the marble rolls rather than drags.
 *
 * A sphere that is rolling without slipping has a contact point with (almost)
 * no relative velocity, so kinetic friction does no work on it -- what slows a
 * real marble is *rolling resistance*, which is one to two orders of magnitude
 * smaller. Spin here is derived from linear velocity rather than integrated as
 * angular momentum, so the marble is rolling by construction and `rolling` is
 * what should apply at a sustained contact.
 *
 * `friction` is still correct for a genuine impact, where the ball really does
 * scrub against the surface. `step()` blends between the two by impact speed.
 */
export interface SurfaceProps {
  /** Coulomb coefficient, for real impacts. */
  friction: number;
  /** Rolling resistance, for sustained contact. Deceleration is this times g. */
  rolling: number;
  restitution: number;
  /** Multiplies the player's steering authority while in contact. */
  control: number;
}

export const SURFACE_PROPS: Record<SurfaceType, SurfaceProps> = {
  [SurfaceType.Normal]: { friction: 0.62, rolling: 0.055, restitution: 0.22, control: 1.0 },
  [SurfaceType.Ice]: { friction: 0.035, rolling: 0.010, restitution: 0.12, control: 0.30 },
  // Sticky is the brake: high enough to actually scrub off speed.
  [SurfaceType.Sticky]: { friction: 1.6, rolling: 0.55, restitution: 0.02, control: 0.85 },
  [SurfaceType.Boost]: { friction: 0.4, rolling: 0.03, restitution: 0.1, control: 1.0 },
  [SurfaceType.Crumble]: { friction: 0.7, rolling: 0.06, restitution: 0.15, control: 1.0 },
  [SurfaceType.Goal]: { friction: 0.7, rolling: 0.06, restitution: 0.1, control: 1.0 },
  [SurfaceType.Kill]: { friction: 0.6, rolling: 0.055, restitution: 0.3, control: 1.0 },
  [SurfaceType.Bumper]: { friction: 0.25, rolling: 0.04, restitution: 1.55, control: 1.0 },
  [SurfaceType.Wall]: { friction: 0.32, rolling: 0.05, restitution: 0.42, control: 1.0 },
  [SurfaceType.Checkpoint]: { friction: 0.62, rolling: 0.055, restitution: 0.2, control: 1.0 },
};

/**
 * Normal-approach speed at which a contact counts as a full impact rather than
 * resting contact. Also the speed below which bounces are suppressed.
 */
const IMPACT_SPEED = 1.6;

/**
 * Below this normal speed a contact is pure rolling.
 *
 * A ball resting on the floor still shows a small approach speed every substep,
 * because gravity accumulates g*dt = 34/120 ~ 0.28 between solves. Blending
 * straight from zero would read that as a 17% impact and quietly trebled the
 * rolling resistance -- the marble was still dragging, just less obviously.
 */
const RESTING_BAND = 0.6;

/** Scratch, shared by Collider.refresh() -- which runs for every mover, every frame. */
const _rotMatrix = new THREE.Matrix4();

/** An oriented box. Every solid thing in the game is one of these. */
export class Collider {
  readonly center = new THREE.Vector3();
  readonly half = new THREE.Vector3();
  readonly quat = new THREE.Quaternion();
  readonly invQuat = new THREE.Quaternion();
  /** Kinematic velocity, in world units/s. Non-zero for moving platforms. */
  readonly velocity = new THREE.Vector3();

  type: SurfaceType = SurfaceType.Normal;
  active = true;
  /** Back-reference to the level block that owns this collider. */
  owner: unknown = null;

  private readonly aabbMin = new THREE.Vector3();
  private readonly aabbMax = new THREE.Vector3();

  constructor(center: THREE.Vector3, half: THREE.Vector3, quat?: THREE.Quaternion) {
    this.center.copy(center);
    this.half.copy(half);
    if (quat) this.quat.copy(quat);
    this.refresh();
  }

  /** Recomputes the cached inverse rotation and world AABB. Call after moving. */
  refresh(): void {
    this.invQuat.copy(this.quat).invert();

    // World-space extent of a rotated box: project each half-axis onto x/y/z.
    const e = _rotMatrix.makeRotationFromQuaternion(this.quat).elements;
    // Matrix4 is column-major, so row 0 is elements 0, 4, 8.
    const ex = Math.abs(e[0]) * this.half.x + Math.abs(e[4]) * this.half.y + Math.abs(e[8]) * this.half.z;
    const ey = Math.abs(e[1]) * this.half.x + Math.abs(e[5]) * this.half.y + Math.abs(e[9]) * this.half.z;
    const ez = Math.abs(e[2]) * this.half.x + Math.abs(e[6]) * this.half.y + Math.abs(e[10]) * this.half.z;

    this.aabbMin.set(this.center.x - ex, this.center.y - ey, this.center.z - ez);
    this.aabbMax.set(this.center.x + ex, this.center.y + ey, this.center.z + ez);
  }

  /** Cheap broadphase reject against a sphere. */
  mayOverlapSphere(p: THREE.Vector3, r: number): boolean {
    return (
      p.x + r >= this.aabbMin.x && p.x - r <= this.aabbMax.x &&
      p.y + r >= this.aabbMin.y && p.y - r <= this.aabbMax.y &&
      p.z + r >= this.aabbMin.z && p.z - r <= this.aabbMax.z
    );
  }

  get min(): THREE.Vector3 { return this.aabbMin; }
  get max(): THREE.Vector3 { return this.aabbMax; }
}

export interface Contact {
  collider: Collider;
  /** World-space contact normal, pointing away from the surface. */
  normal: THREE.Vector3;
  /** Speed along the normal at the moment of impact (positive magnitude). */
  impactSpeed: number;
  point: THREE.Vector3;
}

/** The player's marble as a physical body. */
export class MarbleBody {
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  /** Visual spin, integrated from the rolling constraint. */
  readonly spin = new THREE.Quaternion();

  radius = 0.58;
  grounded = false;
  /** Averaged normal of all ground contacts this step. */
  readonly groundNormal = new THREE.Vector3(0, 1, 0);
  /** Velocity of the surface we are standing on (for moving platforms). */
  readonly groundVelocity = new THREE.Vector3();
  groundCollider: Collider | null = null;
  /** Seconds since we were last grounded -- drives coyote-time jumping. */
  timeSinceGrounded = 0;

  reset(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
    this.spin.identity();
    this.grounded = false;
    this.groundNormal.set(0, 1, 0);
    this.groundVelocity.set(0, 0, 0);
    this.groundCollider = null;
    this.timeSinceGrounded = 99;
  }
}

export interface StepParams {
  gravity: number;
  /** Desired world-space acceleration from player input (XZ plane). */
  accel: THREE.Vector3;
  /** Air drag coefficient. */
  drag: number;
  maxSpeed: number;
}

const _local = new THREE.Vector3();
const _closest = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _normal = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _tangent = new THREE.Vector3();
const _point = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _axis = new THREE.Vector3();
const _spinDelta = new THREE.Quaternion();

/** Allowed overlap before we bother pushing out; avoids resting-contact jitter. */
const SLOP = 0.0015;

/**
 * Advances the marble by one fixed substep and resolves every contact.
 *
 * Contacts are returned so the game layer can react to them (boost pads, kill
 * planes, crumbling tiles, impact sounds) without the physics knowing any game
 * rules.
 */
export function step(
  body: MarbleBody,
  colliders: readonly Collider[],
  dt: number,
  params: StepParams,
  out: Contact[],
): void {
  out.length = 0;

  const wasGrounded = body.grounded;

  // --- integrate forces ------------------------------------------------------
  body.velocity.y += params.gravity * dt;

  if (wasGrounded) {
    // Project the steering acceleration onto the ground plane so you can
    // actually drive up ramps instead of pushing into them.
    _tmp.copy(params.accel);
    const n = body.groundNormal;
    _tmp.addScaledVector(n, -_tmp.dot(n));
    body.velocity.addScaledVector(_tmp, dt);
  } else {
    // Reduced authority in mid-air -- enough to correct a jump, not to fly.
    body.velocity.addScaledVector(params.accel, dt * 0.32);
  }

  // Air drag (quadratic-ish, cheap linear approximation).
  const dragFactor = Math.max(0, 1 - params.drag * dt);
  body.velocity.multiplyScalar(dragFactor);

  const speed = body.velocity.length();
  if (speed > params.maxSpeed) {
    body.velocity.multiplyScalar(params.maxSpeed / speed);
  }

  body.position.addScaledVector(body.velocity, dt);

  // --- collision -------------------------------------------------------------
  body.grounded = false;
  body.groundCollider = null;
  body.groundVelocity.set(0, 0, 0);

  const groundAccum = _axis.set(0, 0, 0);
  let groundCount = 0;
  let bestGroundY = -Infinity;

  const r = body.radius;

  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (!c.active) continue;
    if (!c.mayOverlapSphere(body.position, r)) continue;

    // Sphere centre in the box's local frame.
    _local.copy(body.position).sub(c.center).applyQuaternion(c.invQuat);

    _closest.set(
      Math.max(-c.half.x, Math.min(c.half.x, _local.x)),
      Math.max(-c.half.y, Math.min(c.half.y, _local.y)),
      Math.max(-c.half.z, Math.min(c.half.z, _local.z)),
    );

    _delta.copy(_local).sub(_closest);
    let dist = _delta.length();
    let depth: number;

    if (dist > 1e-6) {
      if (dist >= r) continue;
      _normal.copy(_delta).divideScalar(dist);
      depth = r - dist;
    } else {
      // Centre is inside the box: escape along the axis of least penetration.
      const px = c.half.x - Math.abs(_local.x);
      const py = c.half.y - Math.abs(_local.y);
      const pz = c.half.z - Math.abs(_local.z);
      if (px <= py && px <= pz) {
        _normal.set(Math.sign(_local.x) || 1, 0, 0);
        depth = px + r;
      } else if (py <= pz) {
        _normal.set(0, Math.sign(_local.y) || 1, 0);
        depth = py + r;
      } else {
        _normal.set(0, 0, Math.sign(_local.z) || 1);
        depth = pz + r;
      }
    }

    _point.copy(_closest).applyQuaternion(c.quat).add(c.center);
    _normal.applyQuaternion(c.quat).normalize();

    const props = SURFACE_PROPS[c.type] ?? SURFACE_PROPS[SurfaceType.Normal];

    // Positional correction.
    if (depth > SLOP) {
      body.position.addScaledVector(_normal, depth - SLOP);
    }

    // Solve in the surface's frame so moving platforms carry the ball.
    _rel.copy(body.velocity).sub(c.velocity);
    const vn = _rel.dot(_normal);

    let impactSpeed = 0;

    if (vn < 0) {
      impactSpeed = -vn;

      // Do not bounce off tiny residual velocities -- that is what makes a ball
      // buzz forever on a flat floor.
      const restitution = impactSpeed < IMPACT_SPEED ? 0 : props.restitution;
      const j = -(1 + restitution) * vn;
      _rel.addScaledVector(_normal, j);

      // Blend rolling resistance into Coulomb friction by how hard the contact
      // is. A ball sitting on the floor only accumulates a gravity-sized normal
      // impulse per substep, so it lands at the rolling end and coasts; a real
      // collision lands at the Coulomb end and scrubs.
      //
      // Using props.friction here for everything is what made the marble
      // decelerate at mu*g -- about 21 u/s^2, a sliding block rather than a
      // rolling ball, killing every bit of momentum the game is built on.
      const t = (impactSpeed - RESTING_BAND) / (IMPACT_SPEED - RESTING_BAND);
      const clamped = Math.min(Math.max(t, 0), 1);
      const hardness = clamped * clamped * (3 - 2 * clamped); // smoothstep
      const mu = props.rolling + (props.friction - props.rolling) * hardness;

      _tangent.copy(_rel).addScaledVector(_normal, -_rel.dot(_normal));
      const tLen = _tangent.length();
      if (tLen > 1e-5) {
        // Clamped so friction can never reverse the motion, which is also what
        // lets the ball actually come to rest instead of jittering.
        const applied = Math.min(tLen, mu * j);
        _rel.addScaledVector(_tangent, -applied / tLen);
      }

      body.velocity.copy(_rel).add(c.velocity);
    }

    if (_normal.y > 0.45) {
      body.grounded = true;
      groundAccum.add(_normal);
      groundCount++;
      // Prefer the highest contact as "the" ground -- matters when straddling
      // two platforms at different heights.
      if (_point.y > bestGroundY) {
        bestGroundY = _point.y;
        body.groundCollider = c;
        body.groundVelocity.copy(c.velocity);
      }
    }

    out.push({
      collider: c,
      normal: _normal.clone(),
      impactSpeed,
      point: _point.clone(),
    });
  }

  if (groundCount > 0) {
    body.groundNormal.copy(groundAccum).normalize();
    body.timeSinceGrounded = 0;
  } else {
    body.groundNormal.set(0, 1, 0);
    body.timeSinceGrounded += dt;
  }

  // --- rolling spin (visual only) --------------------------------------------
  // Rolling without slipping: the contact point must be stationary, so
  // v + omega x (-n r) = 0, which solves to omega = (n x v) / r.
  //
  // The angle here is positive. Negating it -- which is easy to do by analogy
  // with screen-space rotations -- spins the ball backwards against its own
  // travel, and it reads as obviously wrong the moment you watch it move.
  const surfaceVel = _tmp.copy(body.velocity).sub(body.groundVelocity);
  const n = body.grounded ? body.groundNormal : _rel.set(0, 1, 0);
  _tangent.crossVectors(n, surfaceVel);
  const omega = _tangent.length() / body.radius;
  if (omega > 1e-4) {
    _tangent.divideScalar(omega * body.radius);
    _spinDelta.setFromAxisAngle(_tangent, omega * dt);
    body.spin.premultiply(_spinDelta).normalize();
  }
}
