// Live canvas screens: workstation monitors, video wall, CCTV wall, kiosk, phone display.
// Night Ink: screens are signal, so they are drawn as light on an ink ground (glyphs emit, ground stays dark).
import * as THREE from 'three';

export const FONT = {
  mono: '"IBM Plex Mono", "Cascadia Mono", Consolas, "Liberation Mono", monospace',
  sans: '"IBM Plex Sans Condensed", "Segoe UI", system-ui, sans-serif',
  display: '"Big Shoulders Display", "Arial Narrow", "Segoe UI", sans-serif',
};
const MONO = FONT.mono;
const SANS = FONT.sans;
const DISPLAY = FONT.display;
export const SCR = { bg: '#080b1b', bg2: '#10163a', rule: '#2a3366', paper: '#f0e6cf', dim: '#8a8fb4', sodium: '#ffa53b', phos: '#3dffb4', fault: '#ff3d5a', data: '#5cc8ff' };

export class Screen {
  constructor(w = 512, h = 320, { brightness = 1.7 } = {}) {
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

function bg(x, w, h) {
  x.fillStyle = SCR.bg;
  x.fillRect(0, 0, w, h);
}

// halftone corner and print rule: the same visual language as the 3D frame and the UI
function scan(x, w, h) {
  x.fillStyle = 'rgba(138,143,180,0.10)';
  for (let yy = h - 60; yy < h; yy += 6) for (let xx = w - 160 + ((yy / 6) % 2) * 3; xx < w; xx += 6) {
    const k = ((xx - (w - 160)) / 160) * ((yy - (h - 60)) / 60);
    x.beginPath(); x.arc(xx, yy, 0.4 + k * 1.8, 0, Math.PI * 2); x.fill();
  }
}

export function drawTerminal(scr, title, lines, { accent = SCR.sodium, status = null, statusColor = SCR.phos, os = 'ios' } = {}) {
  const key = `${title}|${status}|${lines.slice(-14).join('\n')}`;
  scr.draw(key, (x, w, h) => {
    bg(x, w, h);
    x.fillStyle = SCR.bg2;
    x.fillRect(0, 0, w, 32);
    x.fillStyle = accent;
    x.fillRect(0, 31, w, 2);
    x.font = `800 20px ${DISPLAY}`;
    x.fillText(title.toUpperCase(), 12, 23);
    if (status) {
      x.fillStyle = statusColor;
      x.fillRect(w - 22, 10, 11, 11);
      x.font = `600 13px ${SANS}`;
      x.textAlign = 'right';
      x.fillText(status, w - 30, 21);
      x.textAlign = 'left';
    }
    x.font = `13px ${MONO}`;
    const shown = lines.slice(-Math.floor((h - 44) / 17));
    shown.forEach((l, i) => {
      x.fillStyle = /fail|error|down|unreach|timed out|denied|%|refused/i.test(l) ? SCR.fault : /up|ok|reply|success|200|active \(running\)|connected/i.test(l) ? SCR.phos : os === 'windows' ? '#d8d2c2' : SCR.paper;
      x.fillText(l.slice(0, 62), 12, 52 + i * 17);
    });
    scan(x, w, h);
  });
}

export function drawDashboard(scr, title, rows, footer = '') {
  const key = `${title}|${footer}|${rows.map(r => `${r.label}${r.ok}${r.degraded}${r.detail}`).join(';')}`;
  scr.draw(key, (x, w, h) => {
    bg(x, w, h);
    x.fillStyle = SCR.paper;
    x.font = `900 30px ${DISPLAY}`;
    x.fillText(title.toUpperCase(), 22, 42);
    x.fillStyle = SCR.sodium;
    x.fillRect(22, 54, 80, 4);
    x.fillStyle = SCR.rule;
    x.fillRect(102, 55, w - 124, 2);
    const rh = Math.min(46, (h - 110) / Math.max(1, rows.length));
    rows.forEach((r, i) => {
      const y = 72 + i * rh;
      const col = r.ok ? (r.degraded ? SCR.sodium : SCR.phos) : SCR.fault;
      x.fillStyle = SCR.bg2;
      x.fillRect(22, y, w - 44, rh - 6);
      x.fillStyle = col;
      x.fillRect(22, y, 8, rh - 6);
      x.font = `600 ${Math.round(rh * 0.4)}px ${SANS}`;
      x.fillStyle = SCR.paper;
      x.fillText(r.label, 42, y + rh * 0.56);
      x.textAlign = 'right';
      x.fillStyle = col;
      x.font = `600 ${Math.round(rh * 0.34)}px ${MONO}`;
      x.fillText(r.ok ? (r.degraded ? 'DEGRADED' : 'OK') : 'FAULT', w - 36, y + rh * 0.56);
      x.textAlign = 'left';
      x.fillStyle = SCR.dim;
      x.font = `${Math.round(rh * 0.27)}px ${MONO}`;
      x.fillText((r.detail || '').slice(0, 46), w * 0.45, y + rh * 0.56);
    });
    x.fillStyle = SCR.dim;
    x.font = `14px ${MONO}`;
    x.fillText(footer, 22, h - 18);
    scan(x, w, h);
  });
}

export function drawCctv(scr, live, total, t) {
  const frame = Math.floor(t * 3) % 4;
  scr.draw(`${live}/${total}/${frame}`, (x, w, h) => {
    x.fillStyle = SCR.bg;
    x.fillRect(0, 0, w, h);
    const cols = 10;
    const rows = Math.ceil(total / cols);
    const tw = w / cols;
    const th = (h - 30) / rows;
    for (let i = 0; i < total; i++) {
      const cx = (i % cols) * tw;
      const cy = 30 + Math.floor(i / cols) * th;
      if (i < live) {
        x.fillStyle = '#123a3a';
        x.fillRect(cx + 2, cy + 2, tw - 4, th - 4);
        x.fillStyle = 'rgba(61,255,180,0.45)';
        const s = (i * 37 + frame) % 7;
        x.fillRect(cx + 8 + s, cy + th * 0.45, tw * 0.3, th * 0.35);
        x.fillRect(cx + tw * 0.55, cy + th * 0.3 + (s % 3), tw * 0.25, th * 0.5);
        x.fillStyle = SCR.fault;
        x.fillRect(cx + tw - 12, cy + 7, 5, 5);
      } else {
        x.fillStyle = '#0c0f22';
        x.fillRect(cx + 2, cy + 2, tw - 4, th - 4);
        x.strokeStyle = 'rgba(138,143,180,0.25)';
        x.beginPath(); x.moveTo(cx + 4, cy + 4); x.lineTo(cx + tw - 4, cy + th - 4); x.moveTo(cx + tw - 4, cy + 4); x.lineTo(cx + 4, cy + th - 4); x.stroke();
        x.fillStyle = SCR.fault;
        x.font = `600 10px ${MONO}`;
        x.fillText('NO SIGNAL', cx + 6, cy + th / 2);
      }
      x.fillStyle = SCR.dim;
      x.font = `9px ${MONO}`;
      x.fillText(`CAM-${String(i + 1).padStart(2, '0')}`, cx + 5, cy + 12);
    }
    x.fillStyle = live === total ? SCR.phos : SCR.sodium;
    x.font = `800 18px ${DISPLAY}`;
    x.fillText(`SECTOR B CCTV  ·  ${live}/${total} FEEDS RECORDING`, 10, 21);
  });
}

export function drawKiosk(scr, state) {
  scr.draw(JSON.stringify(state), (x, w, h) => {
    bg(x, w, h);
    x.fillStyle = SCR.sodium;
    x.fillRect(0, 0, w, 64);
    x.fillStyle = SCR.bg;
    x.font = `900 30px ${DISPLAY}`;
    x.fillText('CITY CLINIC · GUEST WI-FI', 22, 43);
    x.fillStyle = state.online ? SCR.phos : SCR.fault;
    x.font = `900 44px ${DISPLAY}`;
    x.fillText(state.online ? 'YOU ARE ONLINE' : 'NO INTERNET', 22, 140);
    x.fillStyle = SCR.paper;
    x.font = `20px ${SANS}`;
    x.fillText(state.line || '', 22, 180);
    x.fillStyle = SCR.dim;
    x.font = `18px ${MONO}`;
    x.fillText(state.ip ? `IPv4 ${state.ip}` : 'Getting address…', 22, 215);
    scan(x, w, h);
  });
}

export function drawPhone(scr, state) {
  scr.draw(JSON.stringify(state), (x, w, h) => {
    x.fillStyle = SCR.bg;
    x.fillRect(0, 0, w, h);
    x.fillStyle = state.ok ? SCR.phos : SCR.fault;
    x.fillRect(0, 0, 6, h);
    x.font = `800 22px ${DISPLAY}`;
    x.fillText('WARD B DISPATCH', 14, 28);
    x.fillStyle = SCR.paper;
    x.font = `15px ${MONO}`;
    x.fillText(state.text || '', 14, 60);
    x.fillText(state.text2 || '', 14, 86);
  });
}
