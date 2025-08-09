// engine-canvas.js
// Host-side canvas renderer for LP gfx. Safe: bounded size, commands, palette.

const MAX_W = 320;
const MAX_H = 180;
const MAX_CMDS = 2000;
const MAX_PALETTE = 32;

function hexToRGBA(hex) {
  const h = (hex || '#000000').replace('#','');
  const n = h.length === 3
    ? h.split('').map(ch => ch+ch).join('')
    : h.padStart(6,'0').slice(0,6);
  const r = parseInt(n.slice(0,2),16);
  const g = parseInt(n.slice(2,4),16);
  const b = parseInt(n.slice(4,6),16);
  return [r,g,b,255];
}

// Decode strings like: "RLE:8x1,4x0,3x2" -> [1,1,1,1,1,1,1,1,0,0,0,0,2,2,2]
function decodeRLE(spec, total) {
  const out = new Uint8Array(total);
  if (!spec || typeof spec !== 'string' || !spec.startsWith('RLE:')) return out;
  const parts = spec.slice(4).split(',');
  let p = 0;
  for (let i=0;i<parts.length && p<total;i++) {
    const m = parts[i].match(/(\d+)x(\d+)/);
    if (!m) continue;
    const n = Math.min(parseInt(m[1],10) || 0, total - p);
    const v = parseInt(m[2],10) || 0;
    for (let k=0;k<n;k++) out[p++] = v;
  }
  return out;
}

export function drawGfxIntoCanvas(canvas, gfx) {
  try {
    if (!canvas || !gfx) return;
    const w = Math.max(1, Math.min(+gfx.w || 0, MAX_W));
    const h = Math.max(1, Math.min(+gfx.h || 0, MAX_H));
    const scale = Math.max(1, Math.min(+gfx.scale || 2, 5));
    const palSrc = Array.isArray(gfx.palette) ? gfx.palette.slice(0, MAX_PALETTE) : ['#000000','#ffffff'];
    const palette = palSrc.map(hexToRGBA);

    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;

    if (gfx.pixels) {
      // Pixels path
      const idx = decodeRLE(gfx.pixels, w*h);
      const img = ctx.createImageData(w, h);
      for (let i=0, p=0; i<idx.length; i++, p+=4) {
        const c = palette[idx[i]] || palette[0];
        img.data[p]   = c[0];
        img.data[p+1] = c[1];
        img.data[p+2] = c[2];
        img.data[p+3] = 255;
      }
      // Draw with scale
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      off.getContext('2d').putImageData(img, 0, 0);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      ctx.drawImage(off, 0, 0, w*scale, h*scale);
      return;
    }

    if (Array.isArray(gfx.cmds)) {
      // Commands path
      const cmds = gfx.cmds.slice(0, MAX_CMDS);
      ctx.clearRect(0,0,canvas.width,canvas.height);
      for (let i=0;i<cmds.length;i++) {
        const op = cmds[i];
        if (!op || typeof op !== 'object') continue;
        if (op.op === 'clear') {
          const c = palette[op.c|0] || [0,0,0,255];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},1)`;
          ctx.fillRect(0,0,w*scale,h*scale);
        } else if (op.op === 'rect') {
          const c = palette[op.c|0] || palette[0];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},1)`;
          const x = Math.max(0, Math.min(w, Math.floor(op.x|0)));
          const y = Math.max(0, Math.min(h, Math.floor(op.y|0)));
          const rw = Math.max(0, Math.min(w - x, Math.floor(op.w|0)));
          const rh = Math.max(0, Math.min(h - y, Math.floor(op.h|0)));
          ctx.fillRect(x*scale, y*scale, rw*scale, rh*scale);
        } else if (op.op === 'px') {
          const c = palette[op.c|0] || palette[0];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},1)`;
          const x = Math.max(0, Math.min(w-1, Math.floor(op.x|0)));
          const y = Math.max(0, Math.min(h-1, Math.floor(op.y|0)));
          ctx.fillRect(x*scale, y*scale, scale, scale);
        } else if (op.op === 'line') {
          // Optional: simple Bresenham line
          const c = palette[op.c|0] || palette[0];
          ctx.fillStyle = `rgba(${c[0]},${c[1]},${c[2]},1)`;
          let x0 = Math.max(0, Math.min(w-1, Math.floor(op.x0|0)));
          let y0 = Math.max(0, Math.min(h-1, Math.floor(op.y0|0)));
          let x1 = Math.max(0, Math.min(w-1, Math.floor(op.x1|0)));
          let y1 = Math.max(0, Math.min(h-1, Math.floor(op.y1|0)));
          let dx=Math.abs(x1-x0), sx=x0<x1?1:-1;
          let dy=-Math.abs(y1-y0), sy=y0<y1?1:-1;
          let err=dx+dy, e2, cap=w*h;
          while (cap-- > 0) {
            ctx.fillRect(x0*scale, y0*scale, scale, scale);
            if (x0===x1 && y0===y1) break;
            e2=2*err;
            if (e2>=dy){ err+=dy; x0+=sx; }
            if (e2<=dx){ err+=dx; y0+=sy; }
          }
        }
      }
    }
  } catch (e) {
    console.warn('[LP gfx] draw failed:', e);
  }
}
