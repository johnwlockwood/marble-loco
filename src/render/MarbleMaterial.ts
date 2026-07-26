import * as THREE from 'three';
import { NOISE, SHADOW, SKY } from './glsl';
import type { Environment } from './Environment';
import type { ShadowPass } from './ShadowPass';

/**
 * The marble.
 *
 * The pattern is evaluated in *object* space, so it turns with the ball and you
 * can read its spin -- which matters a lot for a game where momentum is the
 * whole mechanic. Reflections call the same `skyColor()` the skybox uses, with
 * the reflection vector instead of the view vector, so the ball mirrors the
 * actual sky (sun, stars, nebula) with no cubemap render target anywhere.
 */
export function createMarbleMaterial(env: Environment, shadow: ShadowPass): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...env.uniforms,
      uShadowMap: { value: shadow.target.texture },
      uShadowMatrix: { value: shadow.matrix },
      uShadowTexel: { value: shadow.shadowTexel },
      uShadowBias: { value: 0.0016 },
      uColorA: { value: new THREE.Color(0xd8ecff) },
      uColorB: { value: new THREE.Color(0x2f3f8f) },
      /** 0..1 boost/impact charge -- drives the emissive veins. */
      uCharge: { value: 0 },
      /** 0..1 hurt flash. */
      uHurt: { value: 0 },
      /** Speed in units/s, used for the heat-glow at high velocity. */
      uSpeed: { value: 0 },
    },

    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vObject;

      void main(){
        vObject = normalize(position);
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,

    fragmentShader: /* glsl */ `
      precision highp float;

      #include <packing>
      ${NOISE}
      ${SKY}
      ${SHADOW}

      uniform vec3 uColorA;
      uniform vec3 uColorB;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uAmbient;
      uniform float uCharge;
      uniform float uHurt;
      uniform float uSpeed;

      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying vec3 vObject;

      /** Cosine gradient (Iñigo Quílez) -- used for the thin-film iridescence. */
      vec3 palette(float t){
        return 0.5 + 0.5 * cos(6.28318 * (vec3(1.0, 1.0, 1.0) * t + vec3(0.0, 0.33, 0.67)));
      }

      void main(){
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 L = normalize(uSunDir);
        vec3 R = reflect(-V, N);

        // ---- object-space swirl -------------------------------------------
        // Domain-warped fbm gives the marbled-glass veining; because vObject
        // rotates with the mesh, the pattern spins with the ball.
        vec3 p = vObject * 2.6;
        vec3 warp = vec3(
          fbm(p + vec3(0.0, 1.7, 3.1), 3),
          fbm(p + vec3(4.2, 0.3, 1.1), 3),
          fbm(p + vec3(2.6, 5.5, 0.7), 3)
        );
        float veins = fbm(p * 1.6 + warp * 2.4, 4);
        float bands = smoothstep(0.38, 0.62, veins);

        vec3 albedo = mix(uColorB, uColorA, bands);
        // Bright filaments where the two phases meet.
        float filament = smoothstep(0.030, 0.0, abs(veins - 0.5));
        albedo = mix(albedo, vec3(1.0), filament * 0.65);

        // Metallic flake sparkle, only visible near the specular direction.
        float flake = step(0.86, hash13(floor(vObject * 90.0)));

        // ---- reflection ----------------------------------------------------
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.2);
        float reflectivity = mix(0.16, 1.0, fres);

        vec3 env = skyColor(R);
        // Below the horizon the reflection ray hits the level, not the sky --
        // approximate that with a darkened ground tint so the ball is not lit
        // from underneath by a sky that is not there.
        env = mix(env * 0.35 + uFogColor * 0.4, env, smoothstep(-0.25, 0.15, R.y));

        // Thin-film iridescence across the grazing angles.
        vec3 iri = palette(fres * 1.6 + veins * 0.5 + uTime * 0.02);
        env *= mix(vec3(1.0), iri, 0.35);

        // ---- lighting -------------------------------------------------------
        float shadow = shadowLookup(vWorld, N, L, 3.2);
        float ndl = max(dot(N, L), 0.0);
        vec3 direct = uSunColor * ndl * shadow * 1.5;
        vec3 ambient = skyAmbient(N) * uAmbient * 0.9;

        vec3 H = normalize(L + V);
        float ndh = max(dot(N, H), 0.0);
        float spec = pow(ndh, 220.0) * 3.2 * shadow;
        spec += pow(ndh, 900.0) * flake * 8.0 * shadow;

        vec3 color = albedo * (direct * 0.6 + ambient * 0.85);
        color += env * reflectivity * 1.15;
        color += uSunColor * spec;

        // ---- state effects ---------------------------------------------------
        // Charge runs hot light through the veins.
        color += vec3(0.3, 1.0, 0.8) * filament * uCharge * 3.0;
        color += vec3(0.2, 0.8, 1.0) * fres * uCharge * 1.5;

        // Friction heat at speed.
        float heat = smoothstep(12.0, 30.0, uSpeed);
        color += vec3(1.0, 0.45, 0.12) * heat * (0.35 + filament * 1.4);

        // Damage flash.
        color = mix(color, vec3(1.0, 0.12, 0.2) * (1.0 + fres * 2.0), uHurt);

        // ---- fog --------------------------------------------------------------
        float dist = length(cameraPosition - vWorld);
        float fogAmount = 1.0 - exp(-pow(dist * uFogDensity, 2.0));
        color = mix(color, uFogColor, clamp(fogAmount, 0.0, 1.0) * 0.85);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
}

/**
 * A soft blob shadow drawn directly under the ball.
 *
 * The shadow map alone is not enough at this scale: on a phone screen the ball
 * is small and the contact point is what tells you where it actually is. This
 * adds a tight, distance-scaled ellipse that reads instantly.
 */
export function createContactShadow(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uOpacity: { value: 1 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      precision mediump float;
      uniform float uOpacity;
      varying vec2 vUv;
      void main(){
        float d = length(vUv - 0.5) * 2.0;
        // Hard-ish core with a soft falloff -- contact hardening by hand.
        float a = smoothstep(1.0, 0.15, d) * 0.55 + smoothstep(0.55, 0.0, d) * 0.45;
        gl_FragColor = vec4(0.0, 0.0, 0.02, a * uOpacity);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = 5;
  mesh.frustumCulled = false;
  return mesh;
}
