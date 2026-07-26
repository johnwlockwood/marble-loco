/**
 * Shared GLSL chunks.
 *
 * Everything the game draws is a hand-written shader, so these building blocks
 * are pulled into several materials: the procedural sky doubles as the marble's
 * environment map (no cubemap render target needed), and the shadow lookup is
 * our own PCF against a depth buffer we render ourselves rather than three's
 * lighting system.
 */

/** Hash / value-noise / fbm. Cheap enough to run per-pixel on an A-series GPU. */
export const NOISE = /* glsl */ `
float hash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }

float hash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 hash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float vnoise(vec3 p){
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i + vec3(0,0,0)), hash13(i + vec3(1,0,0)), f.x),
        mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x),
        mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y),
    f.z);
}

float fbm(vec3 p, int octaves){
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= octaves) break;
    s += a * vnoise(p);
    p *= 2.02;
    a *= 0.5;
  }
  return s;
}
`;

/**
 * Procedural sky. Evaluated for a view ray by the skybox, and for a *reflection*
 * ray by the marble -- which is what gives the ball a believable chrome look
 * without ever building a cubemap.
 */
export const SKY = /* glsl */ `
uniform vec3 uSunDir;
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyGround;
uniform vec3 uSunColor;
uniform float uTime;

vec3 skyColor(vec3 dir){
  float h = dir.y;

  // Vertical gradient: ground haze -> horizon glow -> deep zenith.
  vec3 col = mix(uSkyHorizon, uSkyTop, pow(clamp(h, 0.0, 1.0), 0.62));
  col = mix(col, uSkyGround, pow(clamp(-h, 0.0, 1.0), 0.42));

  // Horizon band, tightened so it reads as a hard arcade horizon line.
  col += uSkyHorizon * 0.55 * pow(1.0 - abs(h), 12.0);

  float sd = max(dot(dir, uSunDir), 0.0);

  // Sun disc + broad atmospheric bloom around it.
  col += uSunColor * pow(sd, 900.0) * 6.0;
  col += uSunColor * pow(sd, 12.0) * 0.28;
  col += uSunColor * pow(sd, 3.0) * 0.05;

  // Star field, faded out near the horizon and behind the sun.
  if (h > 0.0){
    vec3 sp = dir * 42.0;
    vec3 id = floor(sp);
    vec3 gv = fract(sp) - 0.5;
    vec3 rnd = hash33(id);
    if (rnd.z > 0.955){
      float d = length(gv - (rnd.xy - 0.5).xyy * 0.5);
      float tw = 0.65 + 0.35 * sin(uTime * 2.0 + rnd.x * 40.0);
      col += vec3(0.7, 0.85, 1.0) * smoothstep(0.16, 0.0, d) * tw * smoothstep(0.0, 0.45, h);
    }
  }

  // Slow nebula wash so the backdrop is not a flat gradient.
  float neb = fbm(dir * 2.4 + vec3(0.0, 0.0, uTime * 0.012), 4);
  col += vec3(0.16, 0.06, 0.30) * smoothstep(0.45, 0.95, neb) * smoothstep(-0.1, 0.5, h) * 0.6;

  return col;
}

/**
 * Cheap irradiance approximation -- the gradient of skyColor() without the
 * noise, sun disc or stars. Surfaces use this for ambient bounce; only the
 * marble can afford the full skyColor() per pixel.
 */
vec3 skyAmbient(vec3 n){
  // Irradiance is dominated by the bright horizon band, not by the narrow patch
  // of zenith directly overhead -- sampling uSkyTop straight would leave every
  // floor in these dark-zenith skies almost black.
  vec3 upper = mix(uSkyHorizon, uSkyTop, 0.45);
  vec3 c = mix(uSkyGround, uSkyHorizon, smoothstep(-0.7, 0.1, n.y));
  c = mix(c, upper, smoothstep(0.0, 0.9, n.y));

  // Partially desaturate. A strongly tinted horizon -- the neon course is hot
  // pink -- should light the level without painting every surface its colour.
  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, vec3(lum), 0.3);
}
`;

/**
 * PCF lookup against our own shadow map (RGBA-packed depth, rendered from an
 * orthographic camera that tracks the marble).
 */
export const SHADOW = /* glsl */ `
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec2 uShadowTexel;
uniform float uShadowBias;

/**
 * offsetScale widens the normal offset for thick curved casters. Flat level
 * surfaces use 1.0; the marble uses a larger value because it appears in the
 * shadow map itself and would otherwise shadow-acne across its own terminator.
 */
float shadowLookup(vec3 worldPos, vec3 normal, vec3 lightDir, float offsetScale){
  // Normal-offset bias: push the sample point off the surface along its normal
  // proportionally to the light's grazing angle. Kills nearly all acne.
  float ndl = clamp(dot(normal, lightDir), 0.0, 1.0);
  float slope = clamp(1.0 - ndl, 0.0, 1.0);
  vec3 offsetPos = worldPos + normal * (0.035 + 0.28 * slope) * offsetScale;

  vec4 sc = uShadowMatrix * vec4(offsetPos, 1.0);
  vec3 c = sc.xyz / sc.w;

  // Outside the shadow camera's frustum -> fully lit.
  if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0 || c.z > 1.0) return 1.0;

  float bias = uShadowBias * (1.0 + 2.4 * slope);
  float ref = c.z - bias;

  float sum = 0.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 uv = c.xy + vec2(float(x), float(y)) * uShadowTexel * 1.35;
      float d = unpackRGBAToDepth(texture2D(uShadowMap, uv));
      sum += step(ref, d);
    }
  }
  float s = sum / 9.0;

  // Fade the shadow out at the edge of the map so the boundary never pops.
  vec2 fade = smoothstep(0.0, 0.09, c.xy) * smoothstep(1.0, 0.91, c.xy);
  return mix(1.0, s, fade.x * fade.y);
}
`;

/** Filmic tonemap + sRGB, applied once at the end of the post chain. */
export const TONEMAP = /* glsl */ `
vec3 acesFilm(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 toSRGB(vec3 c){
  return mix(c * 12.92, 1.055 * pow(max(c, 1e-5), vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
`;

/** Vertex shader shared by every fullscreen post pass. */
export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
