// Renderer, environment lighting and post-processing with quality tiers.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';

export const QUALITY = {
  low: { name: 'low', pixelRatio: 1, composer: false, bloom: false, shadows: false, msaa: 0, fxaa: false, particles: 400, city: 0.55, grade: false },
  medium: { name: 'medium', pixelRatio: 1.25, composer: true, bloom: true, shadows: false, msaa: 0, fxaa: true, particles: 900, city: 0.8, grade: true },
  high: { name: 'high', pixelRatio: 2, composer: true, bloom: true, shadows: true, msaa: 4, fxaa: false, particles: 1500, city: 1, grade: true },
};

export function detectQuality() {
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  if (coarse || small) return 'low';
  return 'high';
}

// Film grade: vignette, gentle chromatic aberration, grain and a cool lift. Runs before OutputPass (linear).
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, time: { value: 0 }, alarm: { value: 0 }, res: { value: new THREE.Vector2(1, 1) } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float time; uniform float alarm; uniform vec2 res; varying vec2 vUv;
    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898,78.233))) * 43758.5453); }
    void main(){
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      vec2 off = c * r2 * 0.012;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;
      float vig = smoothstep(0.85, 0.18, r2 * 1.9);
      col *= mix(0.58, 1.0, vig);
      col += vec3(0.004, 0.008, 0.012);
      col = mix(col, col * vec3(1.25, 0.82, 0.86), alarm * (0.25 + 0.25 * sin(time * 6.0)) * (1.0 - vig * 0.6));
      float g = hash(vUv * res + fract(time) * 100.0) - 0.5;
      col += g * 0.018;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createRenderer(container, qName) {
  const q = QUALITY[qName] || QUALITY.high;
  const renderer = new THREE.WebGLRenderer({ antialias: !q.composer, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  const ctx = { renderer, q, composer: null, grade: null, bloom: null };
  return ctx;
}

/** Custom environment map: a dark room with cool ceiling strips and a blue window band. */
export function environment(renderer) {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x020406);
  const box = new THREE.Mesh(new THREE.BoxGeometry(24, 6, 18), new THREE.MeshBasicMaterial({ color: 0x05090d, side: THREE.BackSide }));
  box.position.y = 3;
  s.add(box);
  const strip = (w, h, x, y, z, color, rx = 0, ry = 0, k = 1) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), side: THREE.DoubleSide }));
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, 0);
    s.add(m);
  };
  for (let x = -9; x <= 9; x += 3.6) for (let z = -6; z <= 6; z += 3.4) strip(1.6, 0.3, x, 5.9, z, 0xdff4ff, Math.PI / 2, 0, 3.5);
  strip(24, 3.2, 0, 2.2, -8.9, 0x1d4d6b, 0, 0, 1.4);
  strip(24, 0.06, 0, 0.1, 8.9, 0x45e6ff, 0, 0, 6);
  strip(2.5, 1.4, 11.9, 2.4, 0, 0x2b8bb0, 0, -Math.PI / 2, 2.5);
  strip(1.2, 1.2, -11.9, 2.0, -4, 0x0e3a3a, 0, Math.PI / 2, 2);
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(s, 0.035);
  pm.dispose();
  return rt.texture;
}

export function setupPost(ctx, scene, camera) {
  const { renderer, q } = ctx;
  if (!q.composer) return;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: q.msaa });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  if (q.bloom) {
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.42, 0.45, 1.05);
    composer.addPass(bloom);
    ctx.bloom = bloom;
  }
  if (q.grade) {
    const grade = new ShaderPass(GradeShader);
    grade.uniforms.res.value.set(size.x, size.y);
    composer.addPass(grade);
    ctx.grade = grade;
  }
  composer.addPass(new OutputPass());
  if (q.fxaa) {
    const fx = new ShaderPass(FXAAShader);
    fx.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
    composer.addPass(fx);
    ctx.fxaa = fx;
  }
  ctx.composer = composer;
}

export function resize(ctx, camera) {
  const { renderer } = ctx;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (ctx.composer) {
    ctx.composer.setSize(window.innerWidth, window.innerHeight);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    if (ctx.grade) ctx.grade.uniforms.res.value.set(size.x, size.y);
    if (ctx.fxaa) ctx.fxaa.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
  }
}

export function render(ctx, scene, camera, t, alarm) {
  if (ctx.grade) {
    ctx.grade.uniforms.time.value = t;
    ctx.grade.uniforms.alarm.value = alarm;
  }
  if (ctx.composer) ctx.composer.render();
  else ctx.renderer.render(scene, camera);
}
