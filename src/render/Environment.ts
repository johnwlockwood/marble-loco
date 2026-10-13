import * as THREE from 'three';
import { NOISE, SKY } from './glsl';

export interface Theme {
  skyTop: number;
  skyHorizon: number;
  skyGround: number;
  sun: number;
  /** Sun direction (points *towards* the sun). */
  sunDir: [number, number, number];
  fog: number;
  fogDensity: number;
  /** Multiplier on ambient bounce light. */
  ambient: number;
}

export const THEMES: Record<string, Theme> = {
  dawn: {
    skyTop: 0x0a1436, skyHorizon: 0x2f5fa8, skyGround: 0x060812,
    sun: 0xffd9a0, sunDir: [0.55, 0.62, 0.42], fog: 0x14264d, fogDensity: 0.0125, ambient: 1.0,
  },
  void: {
    skyTop: 0x04030f, skyHorizon: 0x2a1152, skyGround: 0x02020a,
    sun: 0xc9a6ff, sunDir: [-0.4, 0.7, 0.5], fog: 0x100a26, fogDensity: 0.016, ambient: 0.85,
  },
  ice: {
    skyTop: 0x08243f, skyHorizon: 0x5cc4e2, skyGround: 0x061a2c,
    sun: 0xe8fbff, sunDir: [0.3, 0.75, -0.55], fog: 0x1e5a7a, fogDensity: 0.013, ambient: 0.9,
  },
  ember: {
    skyTop: 0x1a0510, skyHorizon: 0xb03e14, skyGround: 0x0d0206,
    sun: 0xffb057, sunDir: [0.62, 0.5, 0.6], fog: 0x3d1408, fogDensity: 0.014, ambient: 0.7,
  },
  neon: {
    skyTop: 0x050318, skyHorizon: 0xd8207a, skyGround: 0x020109,
    sun: 0x7df9ff, sunDir: [-0.5, 0.66, -0.45], fog: 0x180a33, fogDensity: 0.015, ambient: 0.55,
  },
  // Sodium-lit factory haze for the belt courses.
  foundry: {
    skyTop: 0x120c06, skyHorizon: 0x8a5a1c, skyGround: 0x080503,
    sun: 0xffc46b, sunDir: [-0.45, 0.58, 0.55], fog: 0x2e1f0e, fogDensity: 0.015, ambient: 0.8,
  },
  aurora: {
    skyTop: 0x020c18, skyHorizon: 0x1f9a7a, skyGround: 0x01060c,
    sun: 0xa6ffd8, sunDir: [0.35, 0.72, -0.6], fog: 0x0a2a33, fogDensity: 0.014, ambient: 0.85,
  },
  // Low, hard, almost white sun -- long shadows for the finale.
  solar: {
    skyTop: 0x1b0d2e, skyHorizon: 0xff8a3d, skyGround: 0x0b0610,
    sun: 0xfff3d6, sunDir: [0.7, 0.32, 0.5], fog: 0x4a2238, fogDensity: 0.012, ambient: 0.75,
  },
};

/**
 * Owns the sky and the uniform block that every other material samples.
 *
 * The uniform *objects* are shared by reference across materials, so setting a
 * theme here instantly re-lights the marble, the level surfaces and the fog.
 */
export class Environment {
  readonly uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.55, 0.62, 0.42).normalize() },
    uSkyTop: { value: new THREE.Color(0x0a1436) },
    uSkyHorizon: { value: new THREE.Color(0x2f5fa8) },
    uSkyGround: { value: new THREE.Color(0x060812) },
    uSunColor: { value: new THREE.Color(0xffd9a0) },
    uFogColor: { value: new THREE.Color(0x14264d) },
    uFogDensity: { value: 0.0125 },
    uAmbient: { value: 1.0 },
  };

  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uInvProjection: { value: new THREE.Matrix4() },
        uCameraWorld: { value: new THREE.Matrix4() },
      },
      // A single clip-space triangle-pair; the ray is reconstructed per pixel so
      // there is no skybox geometry to seam or clip.
      vertexShader: /* glsl */ `
        uniform mat4 uInvProjection;
        uniform mat4 uCameraWorld;
        varying vec3 vRay;
        void main(){
          vec4 p = uInvProjection * vec4(position.xy, 1.0, 1.0);
          vRay = mat3(uCameraWorld) * (p.xyz / p.w);
          gl_Position = vec4(position.xy, 1.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${NOISE}
        ${SKY}
        varying vec3 vRay;
        void main(){
          gl_FragColor = vec4(skyColor(normalize(vRay)), 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.name = 'sky';
  }

  applyTheme(theme: Theme): void {
    const u = this.uniforms;
    u.uSkyTop.value.setHex(theme.skyTop);
    u.uSkyHorizon.value.setHex(theme.skyHorizon);
    u.uSkyGround.value.setHex(theme.skyGround);
    u.uSunColor.value.setHex(theme.sun);
    u.uFogColor.value.setHex(theme.fog);
    u.uFogDensity.value = theme.fogDensity;
    u.uAmbient.value = theme.ambient;
    u.uSunDir.value.set(...theme.sunDir).normalize();
  }

  update(time: number, camera: THREE.PerspectiveCamera): void {
    this.uniforms.uTime.value = time;
    this.material.uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
    this.material.uniforms.uCameraWorld.value.copy(camera.matrixWorld);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
