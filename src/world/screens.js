// Live canvas screens: workstation monitors, video wall, CCTV wall, kiosk, phone display.
import * as THREE from 'three';

const MONO = '"Cascadia Mono", "JetBrains Mono", Consolas, "Liberation Mono", monospace';
const SANS = '"Segoe UI", "Inter", system-ui, sans-serif';

export class Screen {
  constructor(w = 512, h = 320, { brightness = 0.9 } = {}) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, color: new THREE.Color(brightness, brightness, brightness) });
    this.key = '';
  }

  /** Redraw only when the content key changes. */
  draw(key, fn) {
    if (key === this.key) return;
    this.key = key;
    fn(this.ctx, this.canvas.width, this.canvas.height);
    this.texture.needsUpdate = true;
  }
}

function bg(x, w, h, top = '#04121a', bottom = '#02070b') {
  const g = x.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  x.fillStyle = g;
  x.fillRect(0, 0, w, h);
}

function scan(x, w, h) {
  x.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < h; y += 3) x.fillRect(0, y, w, 1);
}

export function drawTerminal(scr, title, lines, { accent = '#5ef1ff', status = null, statusColor = '#37f59a', os = 'ios' } = {}) {
  const key = `${title}|${status}|${lines.slice(-14).join('\n')}`;
  scr.draw(key, (x, w, h) => {
    bg(x, w, h, os === 'windows' ? '#0b1016' : '#031015', '#020609');
    x.fillStyle = 'rgba(94,241,255,0.08)';
    x.fillRect(0, 0, w, 30);
    x.fillStyle = accent;
    x.font = `bold 15px ${MONO}`;
    x.fillText(title, 12, 20);
    if (status) {
      x.fillStyle = statusColor;
      x.beginPath(); x.arc(w - 18, 15, 6, 0, Math.PI * 2); x.fill();
      x.font = `bold 12px ${SANS}`;
      x.textAlign = 'right';
      x.fillText(status, w - 30, 20);
      x.textAlign = 'left';
    }
    x.font = `13px ${MONO}`;
    const shown = lines.slice(-Math.floor((h - 44) / 17));
    shown.forEach((l, i) => {
      x.fillStyle = /fail|error|down|unreach|timed out|denied|%|refused/i.test(l) ? '#ff8a9c' : /up|ok|reply|success|200|active \(running\)|connected/i.test(l) ? '#9dffcf' : '#bfe6ee';
      x.fillText(l.slice(0, 62), 12, 50 + i * 17);
    });
    scan(x, w, h);
  });
}

export function drawDashboard(scr, title, rows, footer = '') {
  const key = `${title}|${footer}|${rows.map(r => `${r.label}${r.ok}${r.degraded}${r.detail}`).join(';')}`;
  scr.draw(key, (x, w, h) => {
    bg(x, w, h, '#071722', '#03080d');
    x.fillStyle = '#5ef1ff';
    x.font = `600 22px ${SANS}`;
    x.fillText(title, 22, 38);
    x.fillStyle = 'rgba(94,241,255,0.25)';
    x.fillRect(22, 50, w - 44, 2);
    const rh = Math.min(46, (h - 110) / Math.max(1, rows.length));
    rows.forEach((r, i) => {
      const y = 70 + i * rh;
      const col = r.ok ? (r.degraded ? '#ffb547' : '#37f59a') : '#ff3d5e';
      x.fillStyle = 'rgba(255,255,255,0.04)';
      x.fillRect(22, y, w - 44, rh - 6);
      x.fillStyle = col;
      x.fillRect(22, y, 6, rh - 6);
      x.font = `600 ${Math.round(rh * 0.38)}px ${SANS}`;
      x.fillStyle = '#e6f6fb';
      x.fillText(r.label, 40, y + rh * 0.55);
      x.textAlign = 'right';
      x.fillStyle = col;
      x.font = `bold ${Math.round(rh * 0.34)}px ${MONO}`;
      x.fillText(r.ok ? (r.degraded ? 'DEGRADED' : 'OK') : 'FAULT', w - 36, y + rh * 0.55);
      x.textAlign = 'left';
      x.fillStyle = '#7f9aa8';
      x.font = `${Math.round(rh * 0.26)}px ${MONO}`;
      x.fillText((r.detail || '').slice(0, 46), w * 0.45, y + rh * 0.55);
    });
    x.fillStyle = '#7f9aa8';
    x.font = `14px ${MONO}`;
    x.fillText(footer, 22, h - 18);
    scan(x, w, h);
  });
}

export function drawCctv(scr, live, total, t) {
  const frame = Math.floor(t * 3) % 4;
  scr.draw(`${live}/${total}/${frame}`, (x, w, h) => {
    x.fillStyle = '#020305';
    x.fillRect(0, 0, w, h);
    const cols = 10;
    const rows = Math.ceil(total / cols);
    const tw = w / cols;
    const th = (h - 30) / rows;
    for (let i = 0; i < total; i++) {
      const cx = (i % cols) * tw;
      const cy = 30 + Math.floor(i / cols) * th;
      if (i < live) {
        const g = x.createLinearGradient(cx, cy, cx, cy + th);
        g.addColorStop(0, '#1d2c33');
        g.addColorStop(1, '#0b1216');
        x.fillStyle = g;
        x.fillRect(cx + 2, cy + 2, tw - 4, th - 4);
        x.fillStyle = 'rgba(160,190,200,0.25)';
        const s = (i * 37 + frame) % 7;
        x.fillRect(cx + 8 + s, cy + th * 0.45, tw * 0.3, th * 0.35);
        x.fillRect(cx + tw * 0.55, cy + th * 0.3 + (s % 3), tw * 0.25, th * 0.5);
        x.fillStyle = '#ff3d5e';
        x.fillRect(cx + tw - 12, cy + 7, 5, 5);
      } else {
        for (let k = 0; k < 60; k++) {
          const v = Math.floor(Math.random() * 90);
          x.fillStyle = `rgb(${v},${v},${v})`;
          x.fillRect(cx + 2 + Math.random() * (tw - 6), cy + 2 + Math.random() * (th - 6), 3, 2);
        }
        x.fillStyle = '#ff5a6e';
        x.font = `bold 10px ${MONO}`;
        x.fillText('NO SIGNAL', cx + 6, cy + th / 2);
      }
      x.fillStyle = '#9fb3c2';
      x.font = `9px ${MONO}`;
      x.fillText(`CAM-${String(i + 1).padStart(2, '0')}`, cx + 5, cy + 12);
    }
    x.fillStyle = live === total ? '#37f59a' : '#ffb547';
    x.font = `bold 16px ${SANS}`;
    x.fillText(`SECTOR B CCTV  ·  ${live}/${total} FEEDS RECORDING`, 10, 21);
  });
}

export function drawKiosk(scr, state) {
  scr.draw(JSON.stringify(state), (x, w, h) => {
    bg(x, w, h, '#f2f6f8', '#dfe8ee');
    x.fillStyle = '#0f3d55';
    x.fillRect(0, 0, w, 64);
    x.fillStyle = '#ffffff';
    x.font = `600 24px ${SANS}`;
    x.fillText('City Clinic · Guest Wi-Fi', 22, 40);
    x.fillStyle = state.online ? '#0e8a55' : '#c22340';
    x.font = `600 30px ${SANS}`;
    x.fillText(state.online ? 'You are online' : 'No internet', 22, 130);
    x.fillStyle = '#4b5f6b';
    x.font = `18px ${SANS}`;
    x.fillText(state.line || '', 22, 170);
    x.fillText(state.ip ? `IPv4 ${state.ip}` : 'Getting address…', 22, 205);
  });
}

export function drawPhone(scr, state) {
  scr.draw(JSON.stringify(state), (x, w, h) => {
    x.fillStyle = state.ok ? '#0b2a1d' : '#2a0b12';
    x.fillRect(0, 0, w, h);
    x.fillStyle = '#c9f7e3';
    x.font = `bold 20px ${MONO}`;
    x.fillText('WARD B DISPATCH', 10, 28);
    x.font = `16px ${MONO}`;
    x.fillText(state.text || '', 10, 60);
    x.fillText(state.text2 || '', 10, 86);
  });
}
