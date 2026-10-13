import * as THREE from 'three';
import { NOISE, SHADOW, SKY } from './glsl';
import type { Environment } from './Environment';
import type { ShadowPass } from './ShadowPass';

/**
 * Surface kinds. The value is baked into a per-vertex attribute so the whole
 * static level renders in a single draw call while each block still gets its
 * own look and its own physical response.
 */
export enum SurfaceType {
  Normal = 0,
  Ice = 1,
  Sticky = 2,
  Boost = 3,
  Crumble = 4,
  Goal = 5,
  Kill = 6,
  Bumper = 7,
  Wall = 8,
  Checkpoint = 9,
  Conveyor = 10,
}

/**
 * The one material every piece of level geometry shares.
 *
 * Per-block variation rides on vertex attributes:
 *   - `aType`   surface kind (see SurfaceType)
 *   - `aState`  0..1 animation channel, written at runtime (crumble decay,
 *               goal activation, bumper flash)
 *   - `aFaceUv`/`aFaceSize` position within the face and the face's world
 *               dimensions, which lets the shader inset a border by a constant
 *               world distance regardless of how big the block is
 *   - `aFlow`   which way chevrons run, in world XZ: a belt's velocity, or a
 *               boost pad's unit impulse direction. Static, so both still
 *               merge into the single level draw
 */
export function createSurfaceMaterial(env: Environment, shadow: ShadowPass): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...env.uniforms,
      uShadowMap: { value: shadow.target.texture },
      uShadowMatrix: { value: shadow.matrix },
      uShadowTexel: { value: shadow.shadowTexel },
      uShadowBias: { value: 0.0016 },
    },

    vertexShader: /* glsl */ `
      attribute vec3 aColor;
      attribute float aType;
      attribute float aState;
      attribute vec2 aFaceUv;
      attribute vec2 aFaceSize;
      attribute vec2 aFlow;

      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vColor;
      varying vec2 vFaceUv;
      varying vec2 vFaceSize;
      varying float vType;
      varying float vState;
      varying vec2 vFlow;

      void main(){
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vColor = aColor;
        vFaceUv = aFaceUv;
        vFaceSize = aFaceSize;
        vType = aType;
        vState = aState;
        vFlow = aFlow;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,

    fragmentShader: /* glsl */ `
      precision highp float;

      #include <packing>
      ${NOISE}
      ${SKY}
      ${SHADOW}

      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uAmbient;

      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vColor;
      varying vec2 vFaceUv;
      varying vec2 vFaceSize;
      varying float vType;
      varying float vState;
      varying vec2 vFlow;

      const float T_NORMAL = 0.0, T_ICE = 1.0, T_STICKY = 2.0, T_BOOST = 3.0;
      const float T_CRUMBLE = 4.0, T_GOAL = 5.0, T_KILL = 6.0, T_BUMPER = 7.0;
      const float T_WALL = 8.0, T_CHECKPOINT = 9.0, T_CONVEYOR = 10.0;

      bool isType(float t){ return abs(vType - t) < 0.5; }

      /** Antialiased line: 1 inside a band of half-width w around 0. */
      float band(float x, float w){
        float aa = fwidth(x) * 0.9 + 1e-5;
        return 1.0 - smoothstep(w - aa, w + aa, abs(x));
      }

      /**
       * Chevrons on a top face, pointing along flow (world XZ) and moving
       * that way at speed world units/s, one every period units.
       *
       * The across-flow offset is measured from the face centre, rebuilt from
       * the face UV (top face: u = +x, v = -z). Adding |across| to the along
       * coordinate puts each chevron's tip on the centreline, ahead of its
       * wings -- subtracting it, which looks equally plausible, draws them
       * pointing backwards.
       */
      float chevrons(vec2 flow, float period, float speed){
        float len = length(flow);
        vec2 dir = len > 1e-3 ? flow / len : vec2(0.0, -1.0);
        vec2 local = vec2((vFaceUv.x - 0.5) * vFaceSize.x, -(vFaceUv.y - 0.5) * vFaceSize.y);
        float across = dot(local, vec2(-dir.y, dir.x));
        float along = dot(vWorld.xz, dir) + abs(across) * 0.6;
        float c = fract((along - uTime * speed) / period);
        // Hard leading edge, soft tail.
        return smoothstep(0.0, 0.25, c) * smoothstep(0.5, 0.42, c);
      }

      void main(){
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSunDir);
        float top = smoothstep(0.55, 0.9, N.y);

        vec3 albedo = vColor;
        vec3 emissive = vec3(0.0);
        float gloss = 26.0;
        float specStrength = 0.28;

        // ---- world-space distance to the face border, in metres -----------
        vec2 edgeDist = min(vFaceUv, 1.0 - vFaceUv) * vFaceSize;
        float toEdge = min(edgeDist.x, edgeDist.y);

        // Inset panel outline. Constant thickness in world space, so big
        // platforms and small tiles get identical trim.
        float outline = band(toEdge - 0.16, 0.035);

        // ---- 1m world grid, only on upward faces --------------------------
        vec2 g = abs(fract(vWorld.xz) - 0.5) - 0.5;
        float grid = max(band(g.x, 0.012), band(g.y, 0.012)) * top;

        // ---- surface-kind treatments ---------------------------------------
        if (isType(T_ICE)) {
          gloss = 190.0;
          specStrength = 1.5;
          // Frozen crackle: sharp high-frequency ridges.
          float cr = fbm(vWorld * 2.2, 3);
          float veins = smoothstep(0.46, 0.5, abs(cr - 0.5));
          albedo = mix(albedo, vec3(0.62, 0.76, 0.84), 0.35 + veins * 0.5);
          emissive += vec3(0.16, 0.42, 0.55) * veins * 0.6;

        } else if (isType(T_STICKY)) {
          gloss = 5.0;
          specStrength = 0.03;
          float grit = fbm(vWorld * 9.0, 3);
          albedo *= 0.55 + grit * 0.6;

        } else if (isType(T_BOOST)) {
          // Arrows racing the way the pad actually throws you.
          float arrow = chevrons(vFlow, 1.8, 2.7) * top;
          emissive += vec3(0.25, 1.0, 0.75) * arrow * 2.4;
          albedo = mix(albedo, vec3(0.03, 0.12, 0.09), 0.5);
          gloss = 70.0;

        } else if (isType(T_CRUMBLE)) {
          // vState 0 = intact, 1 = about to fall. Cracks open and glow hot.
          float cracks = fbm(vWorld * 3.4 + 11.0, 4);
          float crack = smoothstep(0.52 - vState * 0.16, 0.5, abs(cracks - 0.5) * 2.0);
          albedo = mix(albedo, vec3(0.18, 0.13, 0.11), crack * 0.8);
          emissive += vec3(1.0, 0.33, 0.12) * crack * vState * 3.0;
          albedo = mix(albedo, albedo * vec3(1.3, 0.7, 0.6), vState);

        } else if (isType(T_GOAL)) {
          // Concentric rings racing towards the middle.
          vec2 c = (vFaceUv - 0.5) * vFaceSize;
          float r = length(c);
          float rings = band(fract(r * 1.1 - uTime * 0.85) - 0.5, 0.16);
          float core = smoothstep(1.5, 0.0, r);
          emissive += vec3(1.0, 0.82, 0.35) * (rings * 1.6 + core * 2.2) * top * (0.55 + vState);
          albedo = mix(albedo, vec3(0.35, 0.26, 0.06), 0.6);
          gloss = 90.0;

        } else if (isType(T_CHECKPOINT)) {
          vec2 c = (vFaceUv - 0.5) * vFaceSize;
          float r = length(c);
          float ring = band(r - 0.85, 0.09);
          // vState flips to 1 once collected.
          vec3 tint = mix(vec3(0.35, 0.75, 1.0), vec3(0.4, 1.0, 0.6), vState);
          emissive += tint * ring * (1.2 + vState * 2.0) * top;
          albedo = mix(albedo, tint * 0.2, 0.7);

        } else if (isType(T_KILL)) {
          // Hazard hatching that slides sideways.
          float s = (vWorld.x + vWorld.z) * 1.6 - uTime * 1.1;
          float stripe = step(0.5, fract(s));
          albedo = mix(vec3(0.06, 0.02, 0.03), vec3(0.55, 0.04, 0.12), stripe);
          emissive += vec3(1.0, 0.1, 0.25) * stripe * (0.7 + 0.5 * sin(uTime * 4.0));
          gloss = 12.0;

        } else if (isType(T_BUMPER)) {
          vec2 c = (vFaceUv - 0.5) * vFaceSize;
          float r = length(c);
          float ring = band(fract(r * 1.6 + uTime * 0.5) - 0.5, 0.2);
          emissive += vec3(1.0, 0.35, 0.9) * (ring * 0.8 + vState * 3.5);
          albedo = mix(albedo, vec3(0.4, 0.08, 0.3), 0.55);
          gloss = 120.0;

        } else if (isType(T_CONVEYOR)) {
          // Treads travel at the belt's real speed, so what you see is exactly
          // what the ball feels.
          float ridge = chevrons(vFlow, 0.8, length(vFlow));
          albedo = mix(vec3(0.07, 0.075, 0.09), albedo, 0.35 + ridge * 0.4);
          emissive += vec3(1.0, 0.62, 0.12) * ridge * 0.9 * top;
          gloss = 55.0;
          specStrength = 0.5;

        } else if (isType(T_WALL)) {
          // Walls get vertical scanlines instead of the floor grid.
          float scan = band(fract(vWorld.y * 2.0) - 0.5, 0.06);
          albedo *= 0.72 + scan * 0.5;
          emissive += vColor * scan * 0.16;
          gloss = 40.0;

        } else {
          // Plain platform: subtle mottling so large areas are not flat.
          float m = fbm(vWorld * 1.5, 3);
          albedo *= 0.86 + m * 0.3;
        }

        // Trim and grid, tinted by the block colour so they read as inlay.
        vec3 trimColor = mix(vColor, vec3(1.0), 0.55);
        emissive += trimColor * outline * (isType(T_KILL) ? 0.4 : 0.85);
        albedo = mix(albedo, albedo * 1.25, grid * 0.5);
        emissive += trimColor * grid * 0.10;

        // ---- lighting -------------------------------------------------------
        float shadow = shadowLookup(vWorld, N, L, 1.0);
        float ndl = max(dot(N, L), 0.0);

        // Wrapped diffuse keeps vertical faces from going pitch black.
        float wrapped = max((dot(N, L) + 0.35) / 1.35, 0.0);
        vec3 direct = uSunColor * mix(wrapped * 0.35, ndl, 0.75) * shadow * 1.55;

        vec3 ambient = skyAmbient(N) * uAmbient * 0.75;
        // Bounce from the ground plane, so undersides are not dead.
        ambient += uSkyGround * (0.5 - N.y * 0.5) * 0.4 * uAmbient;

        vec3 H = normalize(L + V);
        float spec = pow(max(dot(N, H), 0.0), gloss) * specStrength * shadow * ndl;

        // Fresnel rim: reads as a bright silhouette against the dark sky.
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
        vec3 rim = skyAmbient(reflect(-V, N)) * fres * 0.55;

        vec3 color = albedo * (direct + ambient) + uSunColor * spec + rim + emissive;

        // ---- fog ------------------------------------------------------------
        float dist = length(cameraPosition - vWorld);
        float fogAmount = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
        // Scatter the sun through the fog for depth.
        vec3 fogCol = mix(uFogColor, uSunColor, pow(max(dot(-V, L), 0.0), 8.0) * 0.45);
        color = mix(color, fogCol, clamp(fogAmount, 0.0, 1.0));

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}
