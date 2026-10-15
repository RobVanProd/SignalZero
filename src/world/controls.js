// First-person movement: pointer-lock mouse look + WASD on desktop, virtual stick + drag-look on touch.
import * as THREE from 'three';

export class Controls {
  constructor(camera, dom) {
    this.camera = camera;
    this.dom = dom;
    this.pos = new THREE.Vector3(0, 0, 6.5);
    this.vel = new THREE.Vector2();
    this.yaw = 0;
    this.pitch = -0.06;
    this.keys = {};
    this.enabled = false;
    this.stick = { x: 0, y: 0 };
    this.colliders = [];
    this.dynamic = [];
    this.bob = 0;
    this.height = 1.68;
    this.sensitivity = 1;
    this.invertY = false;
    this.fly = null;
    addEventListener('keydown', e => { this.keys[e.code] = true; });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = {}; });
    document.addEventListener('mousemove', e => {
      if (document.pointerLockElement === this.dom && this.enabled) this.look(e.movementX, e.movementY);
    });
  }

  look(dx, dy) {
    this.yaw -= dx * 0.0022 * this.sensitivity;
    this.pitch -= dy * 0.0021 * this.sensitivity * (this.invertY ? -1 : 1);
    this.pitch = Math.max(-1.25, Math.min(1.2, this.pitch));
  }

  teleport(x, z, yaw = this.yaw, pitch = -0.05) {
    this.pos.set(x, 0, z);
    this.yaw = yaw;
    this.pitch = pitch;
    this.vel.set(0, 0);
    this.fly = null;
  }

  flyTo(x, z, yaw, pitch = -0.08) {
    let dy = yaw - this.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    this.fly = { from: this.pos.clone(), to: new THREE.Vector3(x, 0, z), yaw0: this.yaw, yaw1: this.yaw + dy, p0: this.pitch, p1: pitch, t: 0, dur: Math.min(1.6, 0.5 + this.pos.distanceTo(new THREE.Vector3(x, 0, z)) / 14) };
  }

  collide(nx, nz) {
    const r = 0.3;
    for (const c of [...this.colliders, ...this.dynamic.filter(d => d.active)]) {
      if (c.circle) {
        const dx = nx - c.x;
        const dz = nz - c.z;
        const d = Math.hypot(dx, dz);
        if (d < c.r + r) { const k = (c.r + r) / Math.max(d, 1e-4); nx = c.x + dx * k; nz = c.z + dz * k; }
        continue;
      }
      if (nx + r > c.x0 && nx - r < c.x1 && nz + r > c.z0 && nz - r < c.z1) {
        const pushL = nx + r - c.x0;
        const pushR = c.x1 - (nx - r);
        const pushU = nz + r - c.z0;
        const pushD = c.z1 - (nz - r);
        const m = Math.min(pushL, pushR, pushU, pushD);
        if (m === pushL) nx = c.x0 - r;
        else if (m === pushR) nx = c.x1 + r;
        else if (m === pushU) nz = c.z0 - r;
        else nz = c.z1 + r;
      }
    }
    return [nx, nz];
  }

  update(dt) {
    if (this.fly) {
      const f = this.fly;
      f.t += dt / f.dur;
      const k = f.t >= 1 ? 1 : 1 - Math.pow(1 - f.t, 3);
      this.pos.lerpVectors(f.from, f.to, k);
      this.yaw = f.yaw0 + (f.yaw1 - f.yaw0) * k;
      this.pitch = f.p0 + (f.p1 - f.p0) * k;
      if (f.t >= 1) this.fly = null;
    } else if (this.enabled) {
      const k = this.keys;
      let f = (k.KeyW || k.ArrowUp ? 1 : 0) - (k.KeyS || k.ArrowDown ? 1 : 0) - this.stick.y;
      let s = (k.KeyD || k.ArrowRight ? 1 : 0) - (k.KeyA || k.ArrowLeft ? 1 : 0) + this.stick.x;
      const len = Math.hypot(f, s);
      if (len > 1) { f /= len; s /= len; }
      const speed = (k.ShiftLeft || k.ShiftRight ? 5.2 : 3.2);
      const tx = (s * Math.cos(this.yaw) - f * Math.sin(this.yaw)) * speed;
      const tz = (-s * Math.sin(this.yaw) - f * Math.cos(this.yaw)) * speed;
      const a = Math.min(1, dt * 10);
      this.vel.x += (tx - this.vel.x) * a;
      this.vel.y += (tz - this.vel.y) * a;
      const [nx, nz] = this.collide(this.pos.x + this.vel.x * dt, this.pos.z + this.vel.y * dt);
      this.pos.x = nx;
      this.pos.z = nz;
      const sp = Math.hypot(this.vel.x, this.vel.y);
      this.bob += dt * sp * 2.6;
      this.moving = sp > 0.3;
    }
    const bobY = Math.sin(this.bob) * 0.022 * Math.min(1, Math.hypot(this.vel.x, this.vel.y) / 3);
    this.camera.position.set(this.pos.x, this.height + bobY, this.pos.z);
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    this.camera.rotation.z = Math.sin(this.bob * 0.5) * 0.002;
  }
}
