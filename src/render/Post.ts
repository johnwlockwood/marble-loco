import * as THREE from 'three';
import { FULLSCREEN_VERT, TONEMAP } from './glsl';

const HDR_OPTS: THREE.RenderTargetOptions = {
  minFilter: THREE.LinearFilter,
  magFilter: THREE.LinearFilter,
  format: THREE.RGBAFormat,
  type: THREE.HalfFloatType,
  depthBuffer: false,
  stencilBuffer: false,
  generateMipmaps: false,
};

/**
 * Hand-rolled post chain. Deliberately not EffectComposer -- we want exact
 * control over how many half-resolution passes run, because that is the whole
 * mobile GPU budget.
 *
 * scene -> HDR target
 *       -> threshold + 5-step downsample pyramid (dual filtering)
 *       -> 5-step tent upsample, accumulating
 *       -> composite: speed blur, chromatic aberration, bloom, ACES, sRGB,
 *          vignette, grain
 *       -> optional FXAA
 */
export class PostFX {
  /** Bloom intensity. */
  bloomStrength = 0.85;
  /** Luminance above which pixels bloom. */
  bloomThreshold = 0.85;
  /** 0..1, radial blur towards the screen edges. */
  speedBlur = 0;
  /** Runs FXAA when the device pixel ratio is too low to hide aliasing. */
  fxaa = true;

  readonly sceneTarget: THREE.WebGLRenderTarget;

  private readonly mips: THREE.WebGLRenderTarget[] = [];
  private readonly ldrTarget: THREE.WebGLRenderTarget;
  private readonly quad: THREE.Mesh;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new THREE.Scene();

  private readonly thresholdMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;
  private readonly fxaaMat: THREE.ShaderMaterial;

  private width = 1;
  private height = 1;

  private static readonly MIP_COUNT = 5;

  constructor() {
    this.sceneTarget = new THREE.WebGLRenderTarget(1, 1, { ...HDR_OPTS, depthBuffer: true });
    this.ldrTarget = new THREE.WebGLRenderTarget(1, 1, {
      ...HDR_OPTS,
      type: THREE.UnsignedByteType,
    });

    for (let i = 0; i < PostFX.MIP_COUNT; i++) {
      this.mips.push(new THREE.WebGLRenderTarget(1, 1, HDR_OPTS));
    }

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.thresholdMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uThreshold: { value: 0.85 },
        uTexel: { value: new THREE.Vector2() },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform float uThreshold;
        varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tDiffuse, vUv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // Soft knee so the bloom ramps in instead of popping.
          float knee = uThreshold * 0.6;
          float soft = clamp(l - uThreshold + knee, 0.0, 2.0 * knee);
          soft = soft * soft / (4.0 * knee + 1e-5);
          float contrib = max(soft, l - uThreshold) / max(l, 1e-5);
          gl_FragColor = vec4(c * contrib, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    // 13-tap downsample (Jimenez / "Next Generation Post Processing"). Heavier
    // than a box filter but it is what keeps the bloom from flickering when the
    // marble's specular highlight moves.
    this.downMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        varying vec2 vUv;
        vec3 T(vec2 o){ return texture2D(tDiffuse, vUv + o * uTexel).rgb; }
        void main(){
          vec3 a = T(vec2(-2.0,  2.0)), b = T(vec2(0.0,  2.0)), c = T(vec2(2.0,  2.0));
          vec3 d = T(vec2(-2.0,  0.0)), e = T(vec2(0.0,  0.0)), f = T(vec2(2.0,  0.0));
          vec3 g = T(vec2(-2.0, -2.0)), h = T(vec2(0.0, -2.0)), i = T(vec2(2.0, -2.0));
          vec3 j = T(vec2(-1.0,  1.0)), k = T(vec2(1.0,  1.0));
          vec3 l = T(vec2(-1.0, -1.0)), m = T(vec2(1.0, -1.0));
          vec3 col = e * 0.125;
          col += (a + c + g + i) * 0.03125;
          col += (b + d + f + h) * 0.0625;
          col += (j + k + l + m) * 0.125;
          gl_FragColor = vec4(col, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    // 9-tap tent upsample, additively blended into the larger mip.
    this.upMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uRadius: { value: 1.0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        uniform float uRadius;
        varying vec2 vUv;
        vec3 T(vec2 o){ return texture2D(tDiffuse, vUv + o * uTexel * uRadius).rgb; }
        void main(){
          vec3 col = T(vec2(0.0, 0.0)) * 4.0;
          col += (T(vec2(-1.0, 0.0)) + T(vec2(1.0, 0.0)) + T(vec2(0.0, -1.0)) + T(vec2(0.0, 1.0))) * 2.0;
          col += T(vec2(-1.0, -1.0)) + T(vec2(1.0, -1.0)) + T(vec2(-1.0, 1.0)) + T(vec2(1.0, 1.0));
          gl_FragColor = vec4(col / 16.0, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.compositeMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        tBloom: { value: null },
        uBloom: { value: 0.85 },
        uTime: { value: 0 },
        uSpeedBlur: { value: 0 },
        uAberration: { value: 1.0 },
        uVignette: { value: 1.0 },
        uGrain: { value: 0.035 },
        uFlash: { value: new THREE.Vector4(0, 0, 0, 0) },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision highp float;
        ${TONEMAP}
        uniform sampler2D tDiffuse;
        uniform sampler2D tBloom;
        uniform float uBloom;
        uniform float uTime;
        uniform float uSpeedBlur;
        uniform float uAberration;
        uniform float uVignette;
        uniform float uGrain;
        uniform vec4 uFlash;
        varying vec2 vUv;

        void main(){
          vec2 uv = vUv;
          vec2 toCenter = uv - 0.5;
          float r2 = dot(toCenter, toCenter);

          // Radial blur that ramps up with speed -- 6 taps, only paid for when
          // uSpeedBlur > 0, and weighted so the screen centre stays sharp.
          vec3 base;
          if (uSpeedBlur > 0.001){
            vec3 acc = vec3(0.0);
            float amt = uSpeedBlur * 0.055 * smoothstep(0.02, 0.25, r2);
            for (int i = 0; i < 6; i++){
              float t = float(i) / 5.0;
              acc += texture2D(tDiffuse, uv - toCenter * amt * t).rgb;
            }
            base = acc / 6.0;
          } else {
            base = texture2D(tDiffuse, uv).rgb;
          }

          // Lateral chromatic aberration, zero at the centre, strongest at the
          // corners -- fakes a real lens rather than a uniform RGB split.
          float ca = uAberration * (0.0016 + uSpeedBlur * 0.004);
          if (ca > 0.0001){
            vec2 off = toCenter * ca * (0.4 + r2 * 3.0);
            base.r = texture2D(tDiffuse, uv + off).r;
            base.b = texture2D(tDiffuse, uv - off).b;
          }

          vec3 bloom = texture2D(tBloom, uv).rgb;
          vec3 color = base + bloom * uBloom;

          // Screen flash (respawn / goal / damage), added in HDR so it blooms.
          color += uFlash.rgb * uFlash.a;

          color = acesFilm(color * 1.05);
          color = toSRGB(color);

          // Vignette.
          float vig = 1.0 - uVignette * smoothstep(0.18, 0.85, r2) * 0.65;
          color *= vig;

          // Animated grain, scaled down in bright areas so it stays filmic.
          float n = fract(sin(dot(uv * vec2(1234.5, 6789.1) + uTime, vec2(12.9898, 78.233))) * 43758.5453);
          float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
          color += (n - 0.5) * uGrain * (1.0 - lum * 0.7);

          gl_FragColor = vec4(color, 1.0);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    this.fxaaMat = new THREE.ShaderMaterial({
      uniforms: { tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() } },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform vec2 uTexel;
        varying vec2 vUv;
        const vec3 LUMA = vec3(0.299, 0.587, 0.114);
        void main(){
          // Compact FXAA: edge-direction blur, no sub-pixel quality pass.
          float nw = dot(texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb, LUMA);
          float ne = dot(texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb, LUMA);
          float sw = dot(texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb, LUMA);
          float se = dot(texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb, LUMA);
          vec4 mid = texture2D(tDiffuse, vUv);
          float m = dot(mid.rgb, LUMA);

          float maxL = max(max(nw, ne), max(sw, se));
          float minL = min(min(nw, ne), min(sw, se));
          if (max(maxL, m) - min(minL, m) < max(0.05, maxL * 0.125)){
            gl_FragColor = mid;
            return;
          }

          vec2 dir = normalize(vec2(-((nw + ne) - (sw + se)), ((nw + sw) - (ne + se))) + 1e-6);
          float scale = 1.0 / min(abs(dir.x), abs(dir.y) + 1.0);
          dir = clamp(dir * scale, -8.0, 8.0) * uTexel;

          vec3 a = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb +
                          texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
          vec3 b = a * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb +
                                     texture2D(tDiffuse, vUv + dir * 0.5).rgb);
          float bl = dot(b, LUMA);
          gl_FragColor = vec4((bl < minL || bl > maxL) ? a : b, mid.a);
        }
      `,
      depthTest: false,
      depthWrite: false,
    });
  }

  setSize(width: number, height: number): void {
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));

    this.sceneTarget.setSize(this.width, this.height);
    this.ldrTarget.setSize(this.width, this.height);

    let w = this.width;
    let h = this.height;
    for (const mip of this.mips) {
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
      mip.setSize(w, h);
    }
  }

  /** Screen flash colour + intensity, consumed and decayed by the caller. */
  setFlash(r: number, g: number, b: number, a: number): void {
    (this.compositeMat.uniforms.uFlash.value as THREE.Vector4).set(r, g, b, a);
  }

  private blit(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    target: THREE.WebGLRenderTarget | null,
    clear = true,
  ): void {
    this.quad.material = material;
    renderer.setRenderTarget(target);
    if (clear) renderer.clear(true, false, false);
    renderer.render(this.scene, this.camera);
  }

  render(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    camera: THREE.Camera,
    time: number,
  ): void {
    // --- 1. main scene into HDR ---------------------------------------------
    renderer.setRenderTarget(this.sceneTarget);
    renderer.clear(true, true, false);
    renderer.render(scene, camera);

    // --- 2. bright pass into the largest mip ---------------------------------
    this.thresholdMat.uniforms.tDiffuse.value = this.sceneTarget.texture;
    this.thresholdMat.uniforms.uThreshold.value = this.bloomThreshold;
    this.blit(renderer, this.thresholdMat, this.mips[0]);

    // --- 3. downsample pyramid ------------------------------------------------
    for (let i = 1; i < this.mips.length; i++) {
      const src = this.mips[i - 1];
      this.downMat.uniforms.tDiffuse.value = src.texture;
      (this.downMat.uniforms.uTexel.value as THREE.Vector2).set(
        1 / src.width,
        1 / src.height,
      );
      this.blit(renderer, this.downMat, this.mips[i]);
    }

    // --- 4. upsample, accumulating additively --------------------------------
    for (let i = this.mips.length - 1; i > 0; i--) {
      const src = this.mips[i];
      this.upMat.uniforms.tDiffuse.value = src.texture;
      (this.upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
      // Additive blending, so do not clear the destination.
      this.blit(renderer, this.upMat, this.mips[i - 1], false);
    }

    // --- 5. composite ----------------------------------------------------------
    const c = this.compositeMat.uniforms;
    c.tDiffuse.value = this.sceneTarget.texture;
    c.tBloom.value = this.mips[0].texture;
    c.uBloom.value = this.bloomStrength;
    c.uSpeedBlur.value = this.speedBlur;
    c.uTime.value = time;

    if (this.fxaa) {
      this.blit(renderer, this.compositeMat, this.ldrTarget);
      this.fxaaMat.uniforms.tDiffuse.value = this.ldrTarget.texture;
      (this.fxaaMat.uniforms.uTexel.value as THREE.Vector2).set(
        1 / this.width,
        1 / this.height,
      );
      this.blit(renderer, this.fxaaMat, null);
    } else {
      this.blit(renderer, this.compositeMat, null);
    }

    renderer.setRenderTarget(null);
  }

  dispose(): void {
    this.sceneTarget.dispose();
    this.ldrTarget.dispose();
    this.mips.forEach((m) => m.dispose());
    this.quad.geometry.dispose();
    [this.thresholdMat, this.downMat, this.upMat, this.compositeMat, this.fxaaMat].forEach((m) =>
      m.dispose(),
    );
  }
}
