import * as THREE from 'three';

const MAX_PARTICLES = 512;
const LIFE = 0.9;

/**
 * Additive spark system.
 *
 * `solid` swaps glowing additive points for opaque flakes with a dark rim.
 * Additive light cannot show up on anything already bright -- white spray
 * on pale ice simply vanished -- whereas a rimmed flake reads on any ground.
 *
 * Every particle is simulated entirely in the vertex shader from its spawn
 * state (position, velocity, birth time), so emitting costs one buffer write
 * and the CPU never touches a particle again.
 */
export class Sparks {
  readonly points: THREE.Points;

  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly position: Float32Array;
  private readonly velocity: Float32Array;
  private readonly start: Float32Array;
  private readonly color: Float32Array;
  private readonly scale: Float32Array;
  private cursor = 0;
  private dirty = false;

  /**
   * @param solid      opaque rimmed flakes instead of additive glow
   * @param sizeScale  multiplies point size. Glowing sparks get away with a
   *                   pixel or two because bloom spreads them; flakes do not.
   */
  constructor(solid = false, private readonly sizeScale = 1) {
    this.position = new Float32Array(MAX_PARTICLES * 3);
    this.velocity = new Float32Array(MAX_PARTICLES * 3);
    this.start = new Float32Array(MAX_PARTICLES).fill(-1000);
    this.color = new Float32Array(MAX_PARTICLES * 3);
    this.scale = new Float32Array(MAX_PARTICLES);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.position, 3));
    this.geometry.setAttribute('aVelocity', new THREE.BufferAttribute(this.velocity, 3));
    this.geometry.setAttribute('aStart', new THREE.BufferAttribute(this.start, 1));
    this.geometry.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.geometry.setAttribute('aScale', new THREE.BufferAttribute(this.scale, 1));
    this.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uLife: { value: LIFE },
        uGravity: { value: 22 },
        /** Drawing-buffer height; converts world size to point size. */
        uViewportHeight: { value: 800 },
      },
      vertexShader: /* glsl */ `
        attribute vec3 aVelocity;
        attribute float aStart;
        attribute vec3 aColor;
        attribute float aScale;

        uniform float uTime;
        uniform float uLife;
        uniform float uGravity;
        uniform float uViewportHeight;

        varying vec3 vColor;
        varying float vFade;

        void main(){
          float age = uTime - aStart;
          if (age < 0.0 || age > uLife){
            // Park dead particles outside the frustum; cheaper than re-packing
            // the buffer on the CPU.
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            gl_PointSize = 0.0;
            vFade = 0.0;
            return;
          }

          float t = age / uLife;
          // Ballistic path with a little drag baked into the velocity term.
          vec3 p = position
                 + aVelocity * age * (1.0 - t * 0.45)
                 - vec3(0.0, 0.5 * uGravity * age * age, 0.0);

          vec4 mv = modelViewMatrix * vec4(p, 1.0);
          gl_Position = projectionMatrix * mv;

          vFade = 1.0 - t;
          // Perspective-correct size, shrinking as the spark dies.
          gl_PointSize = max(1.0, aScale * vFade * uViewportHeight * 0.0018 / max(-mv.z, 0.5));
          vColor = aColor;
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        varying vec3 vColor;
        varying float vFade;
        void main(){
          if (vFade <= 0.0) discard;
          vec2 c = gl_PointCoord - 0.5;
          float d = dot(c, c) * 4.0;
          ${solid ? `
          // Hard-edged flake: a light core inside a dark rim.
          float alpha = 1.0 - smoothstep(0.7, 1.0, d);
          if (alpha <= 0.0) discard;
          vec3 col = mix(vColor * 0.18, vColor, 1.0 - smoothstep(0.25, 0.5, d));
          gl_FragColor = vec4(col, alpha * min(1.0, vFade * 2.0));
          ` : `
          // Soft core with a hot centre -- reads well once bloom picks it up.
          float a = exp(-d * 3.2);
          gl_FragColor = vec4(vColor * (a * 2.2 + pow(a, 6.0) * 3.0) * vFade, a * vFade);
          `}
        }
      `,
      transparent: true,
      depthWrite: false,
      blending: solid ? THREE.NormalBlending : THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 20;
  }

  /** Emits `count` sparks at `origin`, spraying around `normal`. */
  burst(
    origin: THREE.Vector3,
    normal: THREE.Vector3,
    count: number,
    speed: number,
    color: THREE.Color,
    time: number,
    spread = 1,
  ): void {
    for (let i = 0; i < count; i++) {
      const idx = this.cursor;
      this.cursor = (this.cursor + 1) % MAX_PARTICLES;

      // Random direction biased along the surface normal.
      const theta = Math.random() * Math.PI * 2;
      const z = Math.random() * 2 - 1;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      const rx = Math.cos(theta) * r;
      const ry = z;
      const rz = Math.sin(theta) * r;

      const v = speed * (0.35 + Math.random() * 0.85);
      const b = 1 - spread;

      this.position[idx * 3] = origin.x;
      this.position[idx * 3 + 1] = origin.y;
      this.position[idx * 3 + 2] = origin.z;

      this.velocity[idx * 3] = (rx * spread + normal.x * b * 2) * v;
      this.velocity[idx * 3 + 1] = (ry * spread + normal.y * b * 2) * v + speed * 0.35;
      this.velocity[idx * 3 + 2] = (rz * spread + normal.z * b * 2) * v;

      this.color[idx * 3] = color.r;
      this.color[idx * 3 + 1] = color.g;
      this.color[idx * 3 + 2] = color.b;

      this.scale[idx] = (5 + Math.random() * 7) * this.sizeScale;
      this.start[idx] = time;
    }
    this.dirty = true;
  }

  update(time: number, viewportHeight: number): void {
    this.material.uniforms.uTime.value = time;
    this.material.uniforms.uViewportHeight.value = viewportHeight;

    if (this.dirty) {
      for (const name of ['position', 'aVelocity', 'aStart', 'aColor', 'aScale']) {
        this.geometry.getAttribute(name).needsUpdate = true;
      }
      this.dirty = false;
    }
  }

  /** Kills everything on screen; used when a level restarts. */
  clear(): void {
    this.start.fill(-1000);
    this.dirty = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
