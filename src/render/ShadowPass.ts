import * as THREE from 'three';

/** Objects on this layer are rendered into the shadow map. */
export const SHADOW_LAYER = 1;

/**
 * A self-contained directional shadow map.
 *
 * We deliberately do not use three's built-in shadow system: every surface in
 * the game runs a hand-written ShaderMaterial, and hooking those into the stock
 * lighting uniforms couples us to three's internal chunk API. Rendering depth
 * ourselves is ~60 lines and gives full control over bias, softness and the
 * moving focus region.
 *
 * Depth is packed into RGBA8 (via three's `packDepthToRGBA`) so it works
 * everywhere, including iOS devices without float render target filtering.
 */
export class ShadowPass {
  readonly target: THREE.WebGLRenderTarget;
  readonly camera: THREE.OrthographicCamera;
  readonly matrix = new THREE.Matrix4();
  readonly lightDir = new THREE.Vector3(0.55, 0.78, 0.32).normalize();

  private readonly depthMaterial: THREE.ShaderMaterial;
  private readonly size: number;
  /** Half-width of the area the shadow camera covers, in world units. */
  private readonly extent: number;
  private readonly texel = new THREE.Vector2();

  private static readonly NDC_TO_UV = new THREE.Matrix4().set(
    0.5, 0.0, 0.0, 0.5,
    0.0, 0.5, 0.0, 0.5,
    0.0, 0.0, 0.5, 0.5,
    0.0, 0.0, 0.0, 1.0,
  );

  constructor(size = 1024, extent = 26) {
    this.size = size;
    this.extent = extent;

    this.target = new THREE.WebGLRenderTarget(size, size, {
      // Packed depth must never be filtered -- interpolating the bytes of two
      // packed values produces a meaningless depth.
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    this.target.texture.name = 'shadowMap';

    this.texel.set(1 / size, 1 / size);

    this.camera = new THREE.OrthographicCamera(-extent, extent, extent, -extent, 0.5, 160);
    this.camera.layers.set(SHADOW_LAYER);

    this.depthMaterial = new THREE.ShaderMaterial({
      vertexShader: /* glsl */ `
        void main(){
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        #include <packing>
        void main(){
          gl_FragColor = packDepthToRGBA(gl_FragCoord.z);
        }
      `,
      side: THREE.FrontSide,
    });
  }

  get shadowTexel(): THREE.Vector2 {
    return this.texel;
  }

  /**
   * Re-aims the light at `focus` and re-renders depth.
   *
   * The camera is snapped to whole texels; without this the shadow edges
   * shimmer as the marble moves, which is very visible on a small screen.
   */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, focus: THREE.Vector3): void {
    const cam = this.camera;
    const worldPerTexel = (this.extent * 2) / this.size;

    cam.position.copy(this.lightDir).multiplyScalar(72).add(focus);
    cam.lookAt(focus);
    cam.updateMatrixWorld(true);

    // Snap in the light's own view space so the texel grid stays stable.
    const viewFocus = focus.clone().applyMatrix4(cam.matrixWorldInverse);
    const dx = viewFocus.x - Math.round(viewFocus.x / worldPerTexel) * worldPerTexel;
    const dy = viewFocus.y - Math.round(viewFocus.y / worldPerTexel) * worldPerTexel;
    cam.position.add(
      new THREE.Vector3()
        .setFromMatrixColumn(cam.matrixWorld, 0)
        .multiplyScalar(dx)
        .add(new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).multiplyScalar(dy)),
    );
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();

    this.matrix
      .copy(ShadowPass.NDC_TO_UV)
      .multiply(cam.projectionMatrix)
      .multiply(cam.matrixWorldInverse);

    const prevTarget = renderer.getRenderTarget();
    const prevOverride = scene.overrideMaterial;

    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0xffffff, 1); // 1.0 depth == nothing occluding
    renderer.clear(true, true, false);
    renderer.render(scene, cam);

    scene.overrideMaterial = prevOverride;
    renderer.setRenderTarget(prevTarget);
  }

  dispose(): void {
    this.target.dispose();
    this.depthMaterial.dispose();
  }
}
