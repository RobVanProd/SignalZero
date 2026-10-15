// "Night Ink" art direction: the world is an ink drawing printed in a few flat tones; only live signal
// (link LEDs, traffic, screens, lit districts) keeps its colour and glows. See docs/ART_DIRECTION.md.
import * as THREE from 'three';

/** Print inks (sRGB hex). THREE.Color converts them to the linear working space for shaders. */
export const INK = {
  ink: 0x0a0d1f, // outlines and deepest shadow
  night: 0x18204a,
  slate: 0x34437e,
  haze: 0x8a8fb4,
  paper: 0xf0e6cf, // lit surfaces, UI text
  sodium: 0xffa53b, // streetlight amber: the city, attention
  phosphor: 0x3dffb4, // healthy signal
  fault: 0xff3d5a, // alarms, failures
  data: 0x5cc8ff, // traffic in flight
};

let gradient = null;
/** Three-band cel ramp shared by every toon material. */
export function toonGradient() {
  if (gradient) return gradient;
  const d = new Uint8Array([70, 70, 70, 255, 150, 150, 150, 255, 255, 255, 255, 255]);
  gradient = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

/** Reflected light can never be brighter than paper; only emitted light (signal) can. */
export const PAPER_MAX = 0.62;
function paperCap(mat) {
  mat.onBeforeCompile = sh => {
    sh.fragmentShader = sh.fragmentShader.replace(
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
      `vec3 litInk = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
       float litPk = max(max(litInk.r, litInk.g), litInk.b);
       litInk *= min(1.0, ${PAPER_MAX.toFixed(3)} / max(litPk, 1e-4));
       vec3 outgoingLight = litInk + totalEmissiveRadiance;`);
  };
  mat.customProgramCacheKey = () => 'paper-cap';
  return mat;
}

/** A cel-shaded material that obeys the paper cap. */
export function toonMaterial(o = {}) { return paperCap(new THREE.MeshToonMaterial({ gradientMap: toonGradient(), ...o })); }

const KEEP = ['name', 'color', 'map', 'emissive', 'emissiveMap', 'emissiveIntensity', 'transparent', 'opacity', 'side', 'depthWrite', 'depthTest', 'alphaTest', 'vertexColors', 'polygonOffset', 'polygonOffsetFactor', 'polygonOffsetUnits', 'fog', 'normalMap', 'normalScale', 'bumpMap', 'bumpScale', 'alphaMap', 'blending', 'toneMapped'];

/** Converts PBR materials to cel-shaded toon materials (cached so shared materials stay shared). */
export function toToon(mat, cache = new Map()) {
  if (!mat || !(mat.isMeshStandardMaterial || mat.isMeshPhysicalMaterial)) return mat;
  if (cache.has(mat)) return cache.get(mat);
  const o = { gradientMap: toonGradient() };
  for (const k of KEEP) if (mat[k] !== undefined && mat[k] !== null) o[k] = mat[k];
  const t = paperCap(new THREE.MeshToonMaterial(o));
  t.userData = { ...mat.userData };
  cache.set(mat, t);
  return t;
}

/** Walks a scene and swaps PBR materials for toon ones. Returns the cache so later objects can reuse it. */
export function toonify(root, cache = new Map()) {
  root.traverse(o => {
    if (!o.isMesh) return;
    o.material = Array.isArray(o.material) ? o.material.map(m => toToon(m, cache)) : toToon(o.material, cache);
  });
  return cache;
}

// Ink pass. Inputs: the HDR scene colour and its depth buffer. Outputs the illustrated frame (still linear HDR):
//  1. outlines: the screen-space Laplacian of 1/z is zero on any plane, so it fires only at silhouettes and creases;
//  2. non-signal pixels are mapped onto a 5-ink ramp with halftone dots between the bands;
//  3. pixels brighter than the signal threshold (emissives) keep their own colour, so only signal glows.
export const InkShader = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    res: { value: new THREE.Vector2(1, 1) },
    near: { value: 0.05 },
    far: { value: 3000 },
    px: { value: 1 },
    cell: { value: 4.5 },
    exposure: { value: 9.0 },
    chroma: { value: 0.32 },
    sigLo: { value: 0.75 },
    sigHi: { value: 1.25 },
    lineFar: { value: 140 },
    c0: { value: new THREE.Color(INK.ink) },
    c1: { value: new THREE.Color(INK.night) },
    c2: { value: new THREE.Color(INK.slate) },
    c3: { value: new THREE.Color(INK.haze) },
    c4: { value: new THREE.Color(INK.paper) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    #include <packing>
    uniform sampler2D tDiffuse; uniform sampler2D tDepth;
    uniform vec2 res; uniform float near; uniform float far; uniform float px; uniform float cell;
    uniform float exposure; uniform float chroma; uniform float sigLo; uniform float sigHi; uniform float lineFar;
    uniform vec3 c0; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3; uniform vec3 c4;
    varying vec2 vUv;
    float dep(vec2 uv){ return texture2D(tDepth, uv).x; }
    float iz(float d){ return -1.0 / perspectiveDepthToViewZ(d, near, far); }
    vec3 ramp(float t){
      t = clamp(t, 0.0, 1.0) * 4.0;
      if (t < 1.0) return mix(c0, c1, t);
      if (t < 2.0) return mix(c1, c2, t - 1.0);
      if (t < 3.0) return mix(c2, c3, t - 2.0);
      return mix(c3, c4, t - 3.0);
    }
    void main(){
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      vec2 o = px / res;
      float dc = dep(vUv);
      bool bg = dc >= 0.999999;
      float ic = iz(dc);
      float l = iz(dep(vUv - vec2(o.x, 0.0))), r = iz(dep(vUv + vec2(o.x, 0.0)));
      float d = iz(dep(vUv - vec2(0.0, o.y))), u = iz(dep(vUv + vec2(0.0, o.y)));
      float a = iz(dep(vUv + o)), b = iz(dep(vUv - o)), e = iz(dep(vUv + vec2(o.x, -o.y))), f = iz(dep(vUv + vec2(-o.x, o.y)));
      float lap = abs(l + r + u + d - 4.0 * ic) + 0.5 * abs(a + b + e + f - 4.0 * ic);
      float rel = lap / max(ic, 1e-6);
      float sil = max(max(abs(l - r), abs(u - d)), max(abs(a - b), abs(e - f))) / max(ic, 1e-6);
      float zv = bg ? far : 1.0 / ic;
      float fade = 1.0 - smoothstep(lineFar * 0.4, lineFar, zv);
      float edge = smoothstep(0.0025, 0.007, rel) * fade;
      edge = max(edge, smoothstep(0.06, 0.18, sil) * (1.0 - smoothstep(lineFar * 4.0, lineFar * 10.0, zv)));

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float peak = max(col.r, max(col.g, col.b));
      float sig = smoothstep(sigLo, sigHi, peak);
      float t = 1.0 - exp(-lum * exposure);
      // halftone between five bands: dot area tracks the fractional tone, screen rotated 30 degrees
      vec2 p = gl_FragCoord.xy / cell;
      p = mat2(0.866, -0.5, 0.5, 0.866) * p;
      float dist = length(fract(p) - 0.5) * 1.4142;
      float x = t * 4.0;
      float fl = floor(x);
      float fr = x - fl;
      float q = (fl + step(dist, sqrt(fr) * 0.98)) / 4.0;
      vec3 base = ramp(q);
      vec3 hue = col / max(lum, 1e-4);
      base *= mix(vec3(1.0), clamp(hue, 0.0, 2.2), chroma * smoothstep(0.02, 0.25, t));
      if (bg) base = col;
      // scratchboard rule: in shadow the line is scratched out in a light ink, in light it is drawn in dark ink
      vec3 lineCol = mix(mix(c2, c3, 0.55), c0, smoothstep(0.3, 0.55, q));
      base = mix(base, lineCol, edge * 0.9);
      vec3 outc = mix(base, col, sig);
      gl_FragColor = vec4(outc, 1.0);
    }`,
};

// Print pass (after bloom): plate misregistration, paper grain, ink vignette, alarm wash and a soft shoulder
// for HDR signal, so emissives saturate like fluorescent ink instead of clipping.
export const PrintShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    alarm: { value: 0 },
    res: { value: new THREE.Vector2(1, 1) },
    shift: { value: 1.0 },
    vig: { value: new THREE.Color(INK.ink) },
    fault: { value: new THREE.Color(INK.fault) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time; uniform float alarm; uniform vec2 res; uniform float shift;
    uniform vec3 vig; uniform vec3 fault; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 shoulder(vec3 c){ vec3 k = max(c - 0.8, 0.0); return min(c, 0.8) + 0.2 * (1.0 - exp(-k / 0.2)); }
    void main(){
      vec2 s = shift / res;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + vec2(s.x, s.y * 0.5)).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - vec2(s.x * 0.5, 0.0)).b;
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      float v = smoothstep(0.62, 0.12, r2 * 1.7);
      col = mix(vig * 0.6, col, mix(0.7, 1.0, v));
      float pulse = alarm * (0.3 + 0.3 * sin(time * 6.0)) * (1.0 - v * 0.5);
      col = mix(col, col * 0.5 + fault * 0.18, pulse);
      col = shoulder(col);
      // grain is added in display space (gamma 2.2) so it stays even in the shadows instead of exploding there
      vec3 g22 = pow(max(col, 0.0), vec3(1.0 / 2.2));
      float stepT = floor(time * 12.0);
      float g = hash(floor(vUv * res / 1.5) + stepT * 7.13) - 0.5;
      float fibre = hash(floor(vUv * res / vec2(9.0, 2.0)) + 3.1) - 0.5;
      g22 += g * 0.028 + fibre * 0.01;
      gl_FragColor = vec4(pow(max(g22, 0.0), vec3(2.2)), 1.0);
    }`,
};
