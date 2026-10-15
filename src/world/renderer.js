// Renderer and the Night Ink post chain, with quality tiers.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { FXAAShader } from 'three/examples/jsm/shaders/FXAAShader.js';
import { InkShader, PrintShader } from './style.js';

export const QUALITY = {
  low: { name: 'low', pixelRatio: 1, bloom: false, shadows: false, fxaa: false, particles: 400, city: 0.55 },
  medium: { name: 'medium', pixelRatio: 1.25, bloom: true, shadows: false, fxaa: true, particles: 900, city: 0.8 },
  high: { name: 'high', pixelRatio: 2, bloom: true, shadows: true, fxaa: true, particles: 1500, city: 1 },
};

export function detectQuality() {
  const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  if (coarse || small) return 'low';
  return 'high';
}

export function createRenderer(container, qName) {
  const q = QUALITY[qName] || QUALITY.high;
  const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone is set by the ink and print passes; OutputPass only converts to sRGB.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.shadowMap.enabled = q.shadows;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);
  const ctx = { renderer, q, composer: null, grade: null, bloom: null };
  return ctx;
}

// Every tier draws the same style: scene (with depth) -> ink -> [bloom] -> print -> sRGB -> [FXAA].
export function setupPost(ctx, scene, camera) {
  const { renderer, q } = ctx;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
  target.depthTexture = new THREE.DepthTexture(size.x, size.y, THREE.FloatType);
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  const ink = new ShaderPass(InkShader);
  const inkRender = ink.render.bind(ink);
  ink.render = (r, write, read, dt, mask) => { ink.uniforms.tDepth.value = read.depthTexture; inkRender(r, write, read, dt, mask); };
  ink.uniforms.near.value = camera.near;
  ink.uniforms.far.value = camera.far;
  composer.addPass(ink);
  ctx.ink = ink;
  if (q.bloom) {
    const bloom = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.55, 0.5, 0.85);
    composer.addPass(bloom);
    ctx.bloom = bloom;
  }
  const grade = new ShaderPass(PrintShader);
  composer.addPass(grade);
  ctx.grade = grade;
  composer.addPass(new OutputPass());
  if (q.fxaa) {
    const fx = new ShaderPass(FXAAShader);
    composer.addPass(fx);
    ctx.fxaa = fx;
  }
  ctx.composer = composer;
  sizeUniforms(ctx);
}

function sizeUniforms(ctx) {
  const size = ctx.renderer.getDrawingBufferSize(new THREE.Vector2());
  const dpr = ctx.renderer.getPixelRatio();
  ctx.ink.uniforms.res.value.set(size.x, size.y);
  ctx.ink.uniforms.px.value = Math.max(1, dpr);
  ctx.ink.uniforms.cell.value = 5.5 * dpr;
  ctx.grade.uniforms.res.value.set(size.x, size.y);
  ctx.grade.uniforms.shift.value = 0.9 * dpr;
  if (ctx.fxaa) ctx.fxaa.uniforms.resolution.value.set(1 / size.x, 1 / size.y);
}

export function resize(ctx, camera) {
  const { renderer } = ctx;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  if (ctx.composer) {
    ctx.composer.setSize(window.innerWidth, window.innerHeight);
    sizeUniforms(ctx);
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
