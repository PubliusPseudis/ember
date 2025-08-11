// FILE: engine-canvas.js
// Host-side, DOM-only renderer for LP declarative gfx specs.
// Safe: no LP code runs here. This ONLY draws based on a JSON spec in lpState.gfx.
//
// Usage:
//   import { drawGfxIntoCanvas } from "./engine-canvas.js";
//   drawGfxIntoCanvas(canvasEl, gfxSpec, { postId: "p123" });
//
// The gfx spec (lpState.gfx) is a plain object. Minimal shape:
//
// {
//   version: 1,
//   width: 320, height: 180,        // world units (logical drawing space)
//   background: "#111",              // optional
//   camera: { x: 0, y: 0, zoom: 1, rotation: 0 },  // optional
//   viewport: { fit: "contain" },    // contain | cover | stretch | none
//   clear: true,                     // default true
//   layers: [
//     { alpha: 1, blend: "source-over", children: [ /* draw commands */ ] }
//   ]
//   // You can also provide top-level draw arrays: shapes, images, sprites, text, tilemap
// }
//
// Draw command types (inside layers.children or top-level arrays):
// - { type:"rect", x,y,w,h, fill?, stroke?, lineWidth?, radius? }
// - { type:"circle", x,y,r, fill?, stroke?, lineWidth? }
// - { type:"ellipse", x,y,rx,ry, rotation?, fill?, stroke?, lineWidth? }
// - { type:"line", points:[x1,y1,x2,y2,...], stroke?, lineWidth?, cap?, join?, dash? }
// - { type:"poly", points:[...], fill?, stroke?, lineWidth?, close? }
// - { type:"image", src:{hash?|dataUri?}, x,y,w?,h?, sx?,sy?,sw?,sh?, alpha?, composite? }
// - { type:"sprite", sheet:{hash?|dataUri?}, tileW, tileH, index, x,y, scaleX?,scaleY?, rot?, flipX?,flipY?, anchorX?,anchorY?, tint? }
// - { type:"text", str, x,y, size?, font?, weight?, align?, baseline?, fill?, stroke?, lineWidth?, maxWidth?, letterSpacing? }
// - { type:"tilemap", sheet:{hash?|dataUri?}, tileW, tileH, cols, rows, data:[indexes...], x?,y?, scale? }
//
// Input (optional):
// If you pass { postId } or { onInput }, we attach pointer + keyboard handlers that
// send JSON via window.interactWithLivingPost(postId, jsonString).
// Events emitted: {action:"pointer", kind:"down|move|up|wheel", x,y, worldX,worldY, button?, dx?, dy?}
//                 {action:"key", kind:"down|up", key:"ArrowLeft"}
//

// FILE: engine-canvas-plus.js
// Drop-in enhanced 2D renderer for LP declarative gfx specs.
// Backwards-compatible with engine-canvas.js (same drawGfxIntoCanvas signature),
// plus a few new optional fields:
//
// Top-level (gfx):
//   pixelated?: boolean                  // disable image smoothing for crisp pixels
//   debug?: { grid?: { step?: number } } // unchanged
//
// Layers (and draw commands) now also accept:
//   alpha?: number (0..1)
//   blend?: string (globalCompositeOperation)
//   filter?: string (e.g. 'blur(4px) contrast(120%)')
//   shadow?: { color?: string, blur?: number, x?: number, y?: number }
//   clip?: { type:'rect'|'circle'|'ellipse'|'poly', ... }  // layer-only; clips children
//
// Tilemap command gains optional perf helpers:
//   viewCull?: boolean   // default true; only draw tiles in view
//
// Text command now supports letterSpacing (px) accurately for both fill and stroke.
//
// New input option (opts): { emitHover?: boolean }
//   - If true, pointer move events are emitted even when no button is down.
//
// Usage: import { drawGfxIntoCanvas } from './engine-canvas-plus.js'
//        (or replace your engine-canvas.js export with this file).

import { getImageStore } from './services/instances.js';

const DPR = () => (window.devicePixelRatio || 1);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function ensureCache(canvas) {
  if (!canvas.__gfxCache) {
    canvas.__gfxCache = {
      images: new Map(),      // key -> { img, offscreen?, tinted?, tintKey? }
      sheetSlices: new Map(), // sheetKey:index -> {sx,sy,sw,sh}
      lastCamera: { x:0, y:0, zoom:1, rotation:0 },
      listenersAttached: false,
    };
  }
  return canvas.__gfxCache;
}

function resizeCanvasTo(canvas, logicalW, logicalH, fitMode, zoomOverride) {
  const cssW = canvas.clientWidth || logicalW || 300;
  const cssH = canvas.clientHeight || logicalH || 150;
  const dpr = DPR();
  const targetW = Math.max(1, Math.floor(cssW * dpr));
  const targetH = Math.max(1, Math.floor(cssH * dpr));
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }
  const worldW = logicalW || cssW;
  const worldH = logicalH || cssH;
  let scaleX = targetW / worldW;
  let scaleY = targetH / worldH;
  let scale = 1;
  const fit = (fitMode || 'contain');
  if (zoomOverride != null) {
    scale = zoomOverride;
  } else {
    if (fit === 'contain') scale = Math.min(scaleX, scaleY);
    else if (fit === 'cover') scale = Math.max(scaleX, scaleY);
    else if (fit === 'stretch') scale = 1; // scale x/y separately
    else scale = 1; // 'none'
  }
  return { dpr, targetW, targetH, scale, scaleX, scaleY, worldW, worldH };
}

function resolveImageKey(src) {
  if (!src) return null;
  if (typeof src === 'string') return src;
  if (src.hash) return `hash:${src.hash}`;
  if (src.dataUri) return `data:${src.dataUri.slice(0,32)}`;
  if (src.url) return `url:${src.url}`;
  return null;
}

function loadImage(uri) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = uri;
  });
}

async function fetchImageForKey(key, src) {
  if (src && src.hash) {
    const b64 = await getImageStore().retrieveImage(src.hash);
    if (!b64) return null;
    return await loadImage(b64);
  }
  if (src && src.dataUri) return await loadImage(src.dataUri);
  if (src && src.url) return await loadImage(src.url);
  return null;
}

function getSheetSlice(sheetImg, tileW, tileH, index, cols) {
  const x = (index % cols) * tileW;
  const y = Math.floor(index / cols) * tileH;
  return { sx: x, sy: y, sw: tileW, sh: tileH };
}

function tintImageToCanvas(img, color, cacheObj) {
  const tintKey = `${img.src}|${color}`;
  if (cacheObj.tinted && cacheObj.tintKey === tintKey) return cacheObj.tinted;
  const off = cacheObj.offscreen || (cacheObj.offscreen = document.createElement('canvas'));
  off.width = img.width; off.height = img.height;
  const octx = off.getContext('2d');
  octx.clearRect(0, 0, off.width, off.height);
  octx.drawImage(img, 0, 0);
  octx.globalCompositeOperation = 'source-atop';
  octx.fillStyle = color;
  octx.fillRect(0, 0, off.width, off.height);
  octx.globalCompositeOperation = 'source-over';
  cacheObj.tinted = off;
  cacheObj.tintKey = tintKey;
  return off;
}

function withCtx(ctx, fn) { ctx.save(); try { fn(); } finally { ctx.restore(); } }

function toWorldCoords(cache, metrics, px, py) {
  const cx = metrics.targetW * 0.5;
  const cy = metrics.targetH * 0.5;
  const cam = cache.lastCamera || { x: 0, y: 0, zoom: 1, rotation: 0 };
  let x = px - cx, y = py - cy;
  const scale = (metrics.fitMode === 'stretch') ? { x: metrics.scaleX, y: metrics.scaleY } : { x: metrics.scale, y: metrics.scale };
  x /= scale.x; y /= scale.y;
  const rot = -(cam.rotation || 0), c = Math.cos(rot), s = Math.sin(rot);
  const rx = x * c - y * s, ry = x * s + y * c;
  return { worldX: rx + cam.x, worldY: ry + cam.y };
}

// --- Paint/effects helpers ---
function applyEffects(ctx, spec) {
  if (!spec) return;
  if (spec.filter) ctx.filter = spec.filter; // e.g., 'blur(4px)'
  if (spec.shadow) {
    ctx.shadowColor = spec.shadow.color || 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = spec.shadow.blur || 0;
    ctx.shadowOffsetX = spec.shadow.x || 0;
    ctx.shadowOffsetY = spec.shadow.y || 0;
  }
  if (spec.composite && !spec.blend) {
      ctx.globalCompositeOperation = spec.composite;
    }
  if (spec.alpha != null) ctx.globalAlpha = clamp(spec.alpha, 0, 1);
  if (spec.blend) ctx.globalCompositeOperation = spec.blend;
}
function resetEffects(ctx) {
  ctx.filter = 'none';
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function resolveFill(ctx, fill, geom) {
  if (!fill) return null;
  if (typeof fill === 'string') return fill;
  // Gradient support: { type:'linear'|'radial', ...stops }
  if (fill.type === 'linear') {
    const g = ctx.createLinearGradient(fill.x0 ?? geom.x, fill.y0 ?? geom.y, fill.x1 ?? (geom.x + geom.w), fill.y1 ?? geom.y);
    (fill.stops || []).forEach(s => g.addColorStop(s.offset ?? 0, s.color || '#fff'));
    return g;
  }
  if (fill.type === 'radial') {
    const g = ctx.createRadialGradient(
      fill.x0 ?? (geom.x + geom.w*0.5), fill.y0 ?? (geom.y + geom.h*0.5), fill.r0 ?? 0,
      fill.x1 ?? (geom.x + geom.w*0.5), fill.y1 ?? (geom.y + geom.h*0.5), fill.r1 ?? Math.max(geom.w, geom.h)*0.5
    );
    (fill.stops || []).forEach(s => g.addColorStop(s.offset ?? 0, s.color || '#fff'));
    return g;
  }
  return null;
}

function beginClipPath(ctx, clip) {
  if (!clip) return false;
  ctx.beginPath();
  if (clip.type === 'rect') {
    ctx.rect(clip.x||0, clip.y||0, clip.w||0, clip.h||0);
  } else if (clip.type === 'circle') {
    ctx.arc(clip.x||0, clip.y||0, clip.r||0, 0, Math.PI*2);
  } else if (clip.type === 'ellipse') {
    ctx.ellipse(clip.x||0, clip.y||0, clip.rx||0, clip.ry||0, clip.rotation||0, 0, Math.PI*2);
  } else if (clip.type === 'poly' && Array.isArray(clip.points) && clip.points.length >= 4) {
    ctx.moveTo(clip.points[0], clip.points[1]);
    for (let i=2;i<clip.points.length;i+=2) ctx.lineTo(clip.points[i], clip.points[i+1]);
    ctx.closePath();
  } else {
    return false;
  }
  ctx.clip();
  return true;
}

// --- Main renderer ---
export async function drawGfxIntoCanvas(canvas, gfx, opts = {}) {
  if (!(canvas && canvas.getContext) || !gfx || typeof gfx !== 'object') return;

  // Optional 3D passthrough
  const mode = (canvas.dataset.lpCanvas || '').toLowerCase();
  if (mode === '3d' || mode === 'three') {
    try {
      const mod = await import('./engine-three.js');
      if (mod && typeof mod.mountThreeOnCanvas === 'function') return mod.mountThreeOnCanvas(canvas, gfx, opts);
    } catch (e) { console.warn('[engine-canvas+ ] 3D requested but engine-three unavailable:', e); }
  }

  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  const cache = ensureCache(canvas);

  // Pixel art toggle
  const pixelated = !!gfx.pixelated;
  ctx.imageSmoothingEnabled = !pixelated;
  // Quality hint has broad support; harmless if ignored
  ctx.imageSmoothingQuality = pixelated ? 'low' : 'high';

  const worldW = gfx.width || 320;
  const worldH = gfx.height || 180;
  const fitMode = (gfx.viewport && gfx.viewport.fit) || 'contain';
  const metrics = resizeCanvasTo(canvas, worldW, worldH, fitMode, null);
  metrics.fitMode = fitMode;

  // Clear/background
  if (gfx.clear !== false) ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (gfx.background) { withCtx(ctx, () => { ctx.fillStyle = gfx.background; ctx.fillRect(0,0,canvas.width,canvas.height); }); }

  // Viewport transform
  const cx = canvas.width * 0.5, cy = canvas.height * 0.5;
  ctx.save();
  ctx.translate(cx, cy);
  if (fitMode === 'stretch') ctx.scale(metrics.scaleX, metrics.scaleY); else ctx.scale(metrics.scale, metrics.scale);

  // Camera
  const cam = gfx.camera || { x:0, y:0, zoom:1, rotation:0 };
  cache.lastCamera = cam;
  if (cam.rotation) ctx.rotate(cam.rotation);
  ctx.translate(-cam.x, -cam.y);

  // Precompute view rect (world units) for culling
  const viewHalfW = worldW * 0.5, viewHalfH = worldH * 0.5;
  const viewRect = { x0: cam.x - viewHalfW, y0: cam.y - viewHalfH, x1: cam.x + viewHalfW, y1: cam.y + viewHalfH };

  // ---- Draw helpers ----
  async function drawCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;

    // Per-command effects
    ctx.save();
    applyEffects(ctx, cmd);

    switch (cmd.type) {
      case 'rect': {
        const g = { x: cmd.x, y: cmd.y, w: cmd.w, h: cmd.h };
        if (cmd.fill) { ctx.fillStyle = resolveFill(ctx, cmd.fill, g) || cmd.fill; }
        if (cmd.stroke) { ctx.strokeStyle = cmd.stroke; if (cmd.lineWidth != null) ctx.lineWidth = cmd.lineWidth; }
        const r = +cmd.radius || 0;
        if (r > 0) {
          const rr = Math.min(r, g.w * 0.5, g.h * 0.5);
          ctx.beginPath();
          ctx.moveTo(g.x + rr, g.y);
          ctx.arcTo(g.x + g.w, g.y, g.x + g.w, g.y + g.h, rr);
          ctx.arcTo(g.x + g.w, g.y + g.h, g.x, g.y + g.h, rr);
          ctx.arcTo(g.x, g.y + g.h, g.x, g.y, rr);
          ctx.arcTo(g.x, g.y, g.x + g.w, g.y, rr);
          ctx.closePath();
          if (cmd.fill) ctx.fill();
          if (cmd.stroke) ctx.stroke();
        } else {
          if (cmd.fill) ctx.fillRect(g.x, g.y, g.w, g.h);
          if (cmd.stroke) ctx.strokeRect(g.x, g.y, g.w, g.h);
        }
        break;
      }

      case 'circle': {
        const g = { x: cmd.x - cmd.r, y: cmd.y - cmd.r, w: cmd.r*2, h: cmd.r*2 };
        if (cmd.fill) ctx.fillStyle = resolveFill(ctx, cmd.fill, g) || cmd.fill;
        if (cmd.stroke) { ctx.strokeStyle = cmd.stroke; if (cmd.lineWidth != null) ctx.lineWidth = cmd.lineWidth; }
        ctx.beginPath(); ctx.arc(cmd.x, cmd.y, cmd.r, 0, Math.PI*2);
        if (cmd.fill) ctx.fill(); if (cmd.stroke) ctx.stroke();
        break;
      }

      case 'ellipse': {
        const g = { x: cmd.x - cmd.rx, y: cmd.y - cmd.ry, w: cmd.rx*2, h: cmd.ry*2 };
        if (cmd.fill) ctx.fillStyle = resolveFill(ctx, cmd.fill, g) || cmd.fill;
        if (cmd.stroke) { ctx.strokeStyle = cmd.stroke; if (cmd.lineWidth != null) ctx.lineWidth = cmd.lineWidth; }
        ctx.beginPath();
        ctx.ellipse(cmd.x, cmd.y, cmd.rx, cmd.ry, cmd.rotation || 0, 0, Math.PI*2);
        if (cmd.fill) ctx.fill(); if (cmd.stroke) ctx.stroke();
        break;
      }

      case 'line': {
        if (!Array.isArray(cmd.points) || cmd.points.length < 4) break;
        if (cmd.stroke) ctx.strokeStyle = cmd.stroke;
        if (cmd.lineWidth != null) ctx.lineWidth = cmd.lineWidth;
        if (cmd.cap) ctx.lineCap = cmd.cap;
        if (cmd.join) ctx.lineJoin = cmd.join;
        if (cmd.miterLimit != null) ctx.miterLimit = cmd.miterLimit;
        if (cmd.dash && ctx.setLineDash) ctx.setLineDash(cmd.dash);
        ctx.beginPath(); ctx.moveTo(cmd.points[0], cmd.points[1]);
        for (let i=2;i<cmd.points.length;i+=2) ctx.lineTo(cmd.points[i], cmd.points[i+1]);
        ctx.stroke(); if (ctx.setLineDash) ctx.setLineDash([]);
        break;
      }

      case 'poly': {
        if (!Array.isArray(cmd.points) || cmd.points.length < 4) break;
        const bounds = (()=>{ let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity; for(let i=0;i<cmd.points.length;i+=2){const x=cmd.points[i],y=cmd.points[i+1]; if(x<minX)minX=x; if(y<minY)minY=y; if(x>maxX)maxX=x; if(y>maxY)maxY=y;} return {x:minX,y:minY,w:maxX-minX,h:maxY-minY};})();
        if (cmd.fill) ctx.fillStyle = resolveFill(ctx, cmd.fill, bounds) || cmd.fill;
        if (cmd.stroke) { ctx.strokeStyle = cmd.stroke; if (cmd.lineWidth != null) ctx.lineWidth = cmd.lineWidth; }
        ctx.beginPath(); ctx.moveTo(cmd.points[0], cmd.points[1]);
        for (let i=2;i<cmd.points.length;i+=2) ctx.lineTo(cmd.points[i], cmd.points[i+1]);
        if (cmd.close !== false) ctx.closePath();
        if (cmd.fill) ctx.fill(); if (cmd.stroke) ctx.stroke();
        break;
      }

      case 'image': {
        const key = resolveImageKey(cmd.src);
        let imgRec = key && cache.images.get(key);
        if (!imgRec) {
          try { const img = await fetchImageForKey(key, cmd.src); imgRec = { img, offscreen: null, tinted: null, tintKey: null }; cache.images.set(key, imgRec); }
          catch (e) { console.warn('[engine-canvas+ ] image load failed', e); break; }
        }
        if (!imgRec || !imgRec.img) break;
        const img = imgRec.img;
        // Per-command pixelation override
        if (cmd.pixelated != null) ctx.imageSmoothingEnabled = !cmd.pixelated;
        const dw = cmd.w || img.width, dh = cmd.h || img.height;
        if (cmd.sx != null) ctx.drawImage(img, cmd.sx, cmd.sy, cmd.sw, cmd.sh, cmd.x, cmd.y, dw, dh); else ctx.drawImage(img, cmd.x, cmd.y, dw, dh);
        break;
      }

      case 'sprite': {
        const key = resolveImageKey(cmd.sheet);
        let imgRec = key && cache.images.get(key);
        if (!imgRec) {
          try { const img = await fetchImageForKey(key, cmd.sheet); imgRec = { img, offscreen:null, tinted:null, tintKey:null }; cache.images.set(key, imgRec); }
          catch (e) { console.warn('[engine-canvas+ ] sprite sheet load failed', e); break; }
        }
        if (!imgRec || !imgRec.img) break;
        const img = imgRec.img;
        const tileW = cmd.tileW, tileH = cmd.tileH;
        const cols = Math.floor(img.width / tileW);
        const sliceKey = `${key}:${cmd.index}`;
        let slice = cache.sheetSlices.get(sliceKey);
        if (!slice) { slice = getSheetSlice(img, tileW, tileH, cmd.index, cols); cache.sheetSlices.set(sliceKey, slice); }
        const scaleX = cmd.scaleX != null ? cmd.scaleX : 1;
        const scaleY = cmd.scaleY != null ? cmd.scaleY : 1;
        const dx = cmd.x || 0, dy = cmd.y || 0, rot = cmd.rot || 0;
        const anchorX = cmd.anchorX != null ? cmd.anchorX : 0.5;
        const anchorY = cmd.anchorY != null ? cmd.anchorY : 0.5;
        const flipX = !!cmd.flipX, flipY = !!cmd.flipY;
        withCtx(ctx, () => {
          ctx.translate(dx, dy);
          if (rot) ctx.rotate(rot);
          ctx.scale(flipX ? -scaleX : scaleX, flipY ? -scaleY : scaleY);
          const ox = -tileW * anchorX, oy = -tileH * anchorY;
          let source = img;
          if (cmd.tint) source = tintImageToCanvas(img, cmd.tint, imgRec);
          ctx.drawImage(source, slice.sx, slice.sy, slice.sw, slice.sh, ox, oy, tileW, tileH);
        });
        break;
      }

    case 'text': {
      const size = cmd.size || 14;
      const family = cmd.font || 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      const weight = cmd.weight || '';
      const align = cmd.align || 'left';
      const baseline = cmd.baseline || 'alphabetic';
      const text = String(cmd.str ?? '');
      const letter = +cmd.letterSpacing || 0;

      ctx.font = `${weight ? weight + ' ' : ''}${size}px ${family}`;
      ctx.textAlign = align;
      ctx.textBaseline = baseline;

      // Map start/end to left/right for manual spacing math
      const alignKey = align === 'end' ? 'right' : (align === 'start' ? 'left' : align);

      const drawRun = (stroke) => {
        // Fast path: no letterSpacing -> let canvas handle alignment and optional maxWidth
        if (!letter) {
          if (stroke) {
            ctx.lineWidth = cmd.lineWidth || 1;
            ctx.strokeStyle = cmd.stroke;
            return cmd.maxWidth ? ctx.strokeText(text, cmd.x, cmd.y, cmd.maxWidth) : ctx.strokeText(text, cmd.x, cmd.y);
          } else {
            ctx.fillStyle = cmd.fill;
            return cmd.maxWidth ? ctx.fillText(text, cmd.x, cmd.y, cmd.maxWidth) : ctx.fillText(text, cmd.x, cmd.y);
          }
        }

        // Manual spacing path: precompute total width and shift start based on alignment
        const chars = [...text];
        const widths = chars.map(ch => ctx.measureText(ch).width);
        const total = widths.reduce((a,b)=>a+b, 0) + Math.max(0, chars.length - 1) * letter;

        let x0 = cmd.x;
        if (alignKey === 'center') x0 -= total / 2;
        else if (alignKey === 'right') x0 -= total;

        const prevAlign = ctx.textAlign;
        ctx.textAlign = 'left';

        if (stroke) {
          ctx.lineWidth = cmd.lineWidth || 1;
          ctx.strokeStyle = cmd.stroke;
          for (let i = 0; i < chars.length; i++) {
            ctx.strokeText(chars[i], x0, cmd.y);
            x0 += widths[i] + letter;
          }
        } else {
          ctx.fillStyle = cmd.fill;
          for (let i = 0; i < chars.length; i++) {
            ctx.fillText(chars[i], x0, cmd.y);
            x0 += widths[i] + letter;
          }
        }
        //restore:
        ctx.textAlign = prevAlign;
      };

      if (cmd.fill) drawRun(false);
      if (cmd.stroke) drawRun(true);
      break;
    }


      case 'tilemap': {
        const key = resolveImageKey(cmd.sheet);
        let imgRec = key && cache.images.get(key);
        if (!imgRec) {
          try { const img = await fetchImageForKey(key, cmd.sheet); imgRec = { img }; cache.images.set(key, imgRec); }
          catch (e) { console.warn('[engine-canvas+ ] tilemap sheet load failed', e); break; }
        }
        if (!imgRec || !imgRec.img) break;
        const img = imgRec.img;
        const tileW = cmd.tileW, tileH = cmd.tileH;
        const cols = Math.floor(img.width / tileW);
        const mapCols = cmd.cols, mapRows = cmd.rows;
        const data = cmd.data || [];
        const originX = cmd.x || 0, originY = cmd.y || 0;
        const scale = cmd.scale || 1;
        const viewCull = cmd.viewCull !== false; // default on
        let minMX = 0, maxMX = mapCols - 1, minMY = 0, maxMY = mapRows - 1;
        if (viewCull) {
          const vx0 = Math.floor((viewRect.x0 - originX) / (tileW * scale));
          const vy0 = Math.floor((viewRect.y0 - originY) / (tileH * scale));
          const vx1 = Math.floor((viewRect.x1 - originX) / (tileW * scale));
          const vy1 = Math.floor((viewRect.y1 - originY) / (tileH * scale));
          minMX = clamp(vx0 - 1, 0, mapCols - 1);
          maxMX = clamp(vx1 + 1, 0, mapCols - 1);
          minMY = clamp(vy0 - 1, 0, mapRows - 1);
          maxMY = clamp(vy1 + 1, 0, mapRows - 1);
        }
        for (let my = minMY; my <= maxMY; my++) {
          for (let mx = minMX; mx <= maxMX; mx++) {
            const idx = data[my * mapCols + mx];
            if (idx == null || idx < 0) continue;
            const sx = (idx % cols) * tileW;
            const sy = Math.floor(idx / cols) * tileH;
            ctx.drawImage(
              img, sx, sy, tileW, tileH,
              originX + mx * tileW * scale,
              originY + my * tileH * scale,
              tileW * scale, tileH * scale
            );
          }
        }
        break;
      }

      default: break;
    }

    ctx.restore(); // restore per-command effects
  }

  async function drawArray(arr) { for (let i=0;i<arr.length;i++) await drawCommand(arr[i]); }

  async function drawLayer(layer) {
    if (!layer) return;
    ctx.save();
    // Layer-wide effects (filter/shadow/alpha/blend)
    applyEffects(ctx, layer);
    // Optional clipping region for this layer
    if (layer.clip) beginClipPath(ctx, layer.clip);

    if (Array.isArray(layer.children)) {
      for (let i = 0; i < layer.children.length; i++) {
        const c = layer.children[i];
        if (c && c.type === 'layer') await drawLayer(c); else await drawCommand(c);
      }
    }
    ctx.restore();
  }

  // Render order
  if (Array.isArray(gfx.layers)) {
    for (let i = 0; i < gfx.layers.length; i++) await drawLayer(gfx.layers[i]);
  } else {
    if (Array.isArray(gfx.shapes)) await drawArray(gfx.shapes);
    if (Array.isArray(gfx.images)) await drawArray(gfx.images);
    if (Array.isArray(gfx.sprites)) await drawArray(gfx.sprites);
    if (Array.isArray(gfx.text)) await drawArray(gfx.text);
    if (gfx.tilemap) await drawCommand(gfx.tilemap);
  }

  ctx.restore();

  // Debug grid (screen-space consistent density)
  if (gfx.debug && gfx.debug.grid) {
    withCtx(ctx, () => {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 1;
      const step = gfx.debug.grid.step || 16;
      for (let x = 0; x < canvas.width; x += step * metrics.scale) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
      for (let y = 0; y < canvas.height; y += step * metrics.scale) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
    });
  }

  // Input wiring (once per canvas)
  if ((opts.postId || typeof opts.onInput === 'function') && !cache.listenersAttached) {
    attachInputHandlers(canvas, cache, metrics, opts);
    cache.listenersAttached = true;
  }
}

function emitInput(opts, payload) {
  try {
    if (typeof opts.onInput === 'function') { opts.onInput(payload); return; }
    if (opts.postId && typeof window.interactWithLivingPost === 'function') {
      window.interactWithLivingPost(opts.postId, JSON.stringify(payload));
    }
  } catch (e) { console.warn('[engine-canvas+ ] input emit failed', e); }
}

function attachInputHandlers(canvas, cache, metrics, opts) {
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

  function localPos(evt) {
    const rect = canvas.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (canvas.width / rect.width);
    const py = (evt.clientY - rect.top) * (canvas.height / rect.height);
    const w = toWorldCoords(cache, metrics, px, py);
    return { px, py, ...w };
  }

  let isDown = false; let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus(); isDown = true; const p = localPos(e); last = p;
    emitInput(opts, { action: 'pointer', kind: 'down', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, button: e.button || 0 });
  });

  canvas.addEventListener('pointermove', (e) => {
    const p = localPos(e);
    if (isDown) {
      emitInput(opts, { action: 'pointer', kind: 'move', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, dx: last ? (p.px - last.px) : 0, dy: last ? (p.py - last.py) : 0 });
      last = p;
    } else if (opts.emitHover || canvas.dataset.lpHover === '1') {
      emitInput(opts, { action: 'pointer', kind: 'hover', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY });
    }
  }, { passive: true });

  window.addEventListener('pointerup', (e) => {
    if (!isDown) return; isDown = false; const p = localPos(e);
    emitInput(opts, { action: 'pointer', kind: 'up', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, button: e.button || 0 });
  }, { passive: true });

  canvas.addEventListener('wheel', (e) => {
    const p = localPos(e);
    emitInput(opts, { action: 'pointer', kind: 'wheel', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, dx: e.deltaX, dy: e.deltaY });
  }, { passive: true });

  canvas.addEventListener('keydown', (e) => {
    emitInput(opts, { action: 'key', kind: 'down', key: e.key });
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) e.preventDefault();
  });
  canvas.addEventListener('keyup', (e) => { emitInput(opts, { action: 'key', kind: 'up', key: e.key }); });
}

export function clearCanvas(canvas) {
  if (canvas && canvas.getContext) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); }
}

