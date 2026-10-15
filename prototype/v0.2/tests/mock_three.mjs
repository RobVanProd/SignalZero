// Mock used only for headless UI/simulation tests when the container cannot fetch the Three.js CDN.
export const SRGBColorSpace='srgb';export const ACESFilmicToneMapping='aces';
class Vector3 {constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}set(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z;return this}}
export class Color{constructor(hex){this.hex=hex}setHex(hex){this.hex=hex}}
class Node {constructor(){this.position=new Vector3();this.rotation={x:0,y:0,z:0,order:'XYZ'};this.children=[];this.userData={};this.material={};this.color=new Color();this.intensity=0;}add(c){this.children.push(c)} }
export class Scene extends Node {} export class FogExp2{constructor(color,density){}}
export class PerspectiveCamera extends Node{constructor(){super()}updateProjectionMatrix(){}}
export class Mesh extends Node{constructor(geom,mat){super();this.geometry=geom;this.material=mat;this.position=new Vector3()}}
export class Points extends Mesh{}export class Line extends Mesh{}export class AmbientLight extends Node{}export class HemisphereLight extends Node{}export class PointLight extends Node{constructor(color,intensity){super();this.color=new Color(color);this.intensity=intensity}}
export class GridHelper extends Node{constructor(){super();this.material={opacity:1}}}
export class MeshStandardMaterial{constructor(options={}){Object.assign(this,options);this.emissiveIntensity=options.emissiveIntensity||0}}
export class MeshBasicMaterial{constructor(options){Object.assign(this,options||{})}}
export class LineBasicMaterial{constructor(options){Object.assign(this,options||{})}}
export class PointsMaterial{constructor(options){Object.assign(this,options||{})}}
export class BoxGeometry{constructor(){} } export class CylinderGeometry{constructor(){}}export class SphereGeometry{constructor(){}}export class PlaneGeometry{constructor(){}}export class TorusGeometry{constructor(){}}
export class BufferAttribute{constructor(array,sz){}}
export class BufferGeometry{setAttribute(){return this}setFromPoints(){return this}}
export class CanvasTexture{constructor(canvas){this.canvas=canvas}dispose(){}}
export class Clock{constructor(){this.elapsedTime=0}getDelta(){this.elapsedTime+=.016;return .016}}
export class WebGLRenderer{
 constructor(){this.domElement=document.createElement('canvas');this.domElement.style.cssText='background:radial-gradient(ellipse at center,#123343,#020a16)'}
 setSize(w,h){this.domElement.width=w;this.domElement.height=h}
 setPixelRatio(){}render(){}
 setAnimationLoop(fn){const loop=()=>{fn();requestAnimationFrame(loop)};requestAnimationFrame(loop)}
}
export const DoubleSide=2;
