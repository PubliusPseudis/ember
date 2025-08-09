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

import { getImageStore } from './services/instances.js';

// ---------- Small utilities ----------
const DPR = () => (window.devicePixelRatio || 1);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function ensureCache(canvas) {
  if (!canvas.__gfxCache) {
    canvas.__gfxCache = {
      images: new Map(),       // key -> HTMLImageElement or {img, tintKey, tintedCanvas}
      sheetSlices: new Map(),  // sheetKey:index -> {sx,sy,sw,sh}
      lastCamera: { x:0, y:0, zoom:1, rotation:0 },
      listenersAttached: false,
    };
  }
  return canvas.__gfxCache;
}

function resizeCanvasTo(canvas, logicalW, logicalH, fitMode, zoomOverride) {
  // If the canvas has explicit width/height attributes, prefer them.
  const cssW = canvas.clientWidth || logicalW || 300;
  const cssH = canvas.clientHeight || logicalH || 150;
  const dpr = DPR();

  let targetW = Math.max(1, Math.floor(cssW * dpr));
  let targetH = Math.max(1, Math.floor(cssH * dpr));

  // Apply size
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  // Compute viewport scale for world->screen
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
    else if (fit === 'stretch') scale = 1; // we scale x/y separately later
    else scale = 1; // 'none'
  }

  return { dpr, targetW, targetH, scale, scaleX, scaleY, worldW, worldH };
}

function applyStrokeFill(ctx, spec) {
  if (spec.fill) {
    ctx.fillStyle = spec.fill;
  }
  if (spec.stroke) {
    ctx.strokeStyle = spec.stroke;
  }
  if (spec.lineWidth != null) {
    ctx.lineWidth = spec.lineWidth;
  }
}

function applyCompositeAndAlpha(ctx, spec) {
  if (spec.alpha != null) ctx.globalAlpha = spec.alpha;
  if (spec.composite) ctx.globalCompositeOperation = spec.composite;
}

function resetCompositeAndAlpha(ctx) {
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
}

function resolveImageKey(src) {
  if (!src) return null;
  if (typeof src === 'string') return src; // data URI or something cached by caller
  if (src.hash) return `hash:${src.hash}`;
  if (src.dataUri) return `data:${src.dataUri.slice(0,32)}`; // partial key
  if (src.url) return `url:${src.url}`; // discouraged, but allow for host-provided urls
  return null;
}

async function fetchImageForKey(key, src) {
  // Try ImageStore for hashes
  if (src && src.hash) {
    const b64 = await getImageStore().retrieveImage(src.hash);
    if (!b64) return null;
    return await loadImage(b64);
  }
  // dataUri direct
  if (src && src.dataUri) {
    return await loadImage(src.dataUri);
  }
  // url (host-controlled only)
  if (src && src.url) {
    return await loadImage(src.url);
  }
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

function getSheetSlice(sheetImg, tileW, tileH, index, cols) {
  const x = (index % cols) * tileW;
  const y = Math.floor(index / cols) * tileH;
  return { sx: x, sy: y, sw: tileW, sh: tileH };
}

function tintImageToCanvas(img, color, cacheObj) {
  // Simple tint: draw img -> offscreen, fill with color using source-atop.
  // Cache by "imgSrc|tint"
  const tintKey = `${img.src}|${color}`;
  if (cacheObj.tinted && cacheObj.tintKey === tintKey) {
    return cacheObj.tinted;
  }
  const off = cacheObj.offscreen || (cacheObj.offscreen = document.createElement('canvas'));
  off.width = img.width;
  off.height = img.height;
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

function withTransform(ctx, fn) {
  ctx.save();
  try { fn(); } finally { ctx.restore(); }
}

// Convert canvas px to world coords (roughly, using lastCamera + viewport scale).
function toWorldCoords(cache, metrics, px, py) {
  // Undo viewport scaling & centering
  const cx = metrics.targetW * 0.5;
  const cy = metrics.targetH * 0.5;

  const cam = cache.lastCamera || { x: 0, y: 0, zoom: 1, rotation: 0 };

  // Shift to center, unscale, then un-rotate, then add camera
  // NOTE: This is approximate; fine for inputs.
  let x = px - cx;
  let y = py - cy;

  const scale = (metrics.fitMode === 'stretch')
    ? { x: metrics.scaleX, y: metrics.scaleY }
    : { x: metrics.scale, y: metrics.scale };

  x /= scale.x;
  y /= scale.y;

  const rot = -(cam.rotation || 0);
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);

  const rx = x * cos - y * sin;
  const ry = x * sin + y * cos;

  const worldX = rx + cam.x;
  const worldY = ry + cam.y;
  return { worldX, worldY };
}

// ---------- Renderer ----------
export async function drawGfxIntoCanvas(canvas, gfx, opts = {}) {
  if (!(canvas && canvas.getContext)) return;
  if (!gfx || typeof gfx !== 'object') return;

  // 3D adapter: if the canvas asks for it, try engine-three.
  const mode = (canvas.dataset.lpCanvas || '').toLowerCase();
  if (mode === '3d' || mode === 'three') {
    try {
      const mod = await import('./engine-three.js');
      if (mod && typeof mod.mountThreeOnCanvas === 'function') {
        return mod.mountThreeOnCanvas(canvas, gfx, opts);
      }
    } catch (e) {
      console.warn('[engine-canvas] 3D requested but engine-three unavailable:', e);
      // fall through to 2D so at least nothing crashes
    }
  }

  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true, willReadFrequently: false });
  const cache = ensureCache(canvas);

  const worldW = gfx.width || 320;
  const worldH = gfx.height || 180;
  const fitMode = (gfx.viewport && gfx.viewport.fit) || 'contain';

  const metrics = resizeCanvasTo(canvas, worldW, worldH, fitMode, null);
  metrics.fitMode = fitMode;

  // Background / clear
  if (gfx.clear !== false) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  if (gfx.background) {
    ctx.save();
    ctx.fillStyle = gfx.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  // Set up viewport transform: center and scale logical world -> pixels
  const cx = canvas.width * 0.5;
  const cy = canvas.height * 0.5;

  ctx.save();
  if (fitMode === 'stretch') {
    ctx.translate(cx, cy);
    ctx.scale(metrics.scaleX, metrics.scaleY);
  } else {
    ctx.translate(cx, cy);
    ctx.scale(metrics.scale, metrics.scale);
  }

  // Camera
  const cam = gfx.camera || { x: 0, y: 0, zoom: 1, rotation: 0 };
  cache.lastCamera = cam;
  if (cam.rotation) ctx.rotate(cam.rotation);
  ctx.translate(-cam.x, -cam.y);

  // Render content
  async function drawCommand(cmd) {
    if (!cmd || typeof cmd !== 'object') return;

    switch (cmd.type) {
      case 'rect': {
        applyStrokeFill(ctx, cmd);
        const r = +cmd.radius || 0;
        if (r > 0) {
          // round rect
          const x = cmd.x, y = cmd.y, w = cmd.w, h = cmd.h;
          ctx.beginPath();
          const rr = Math.min(r, w * 0.5, h * 0.5);
          ctx.moveTo(x + rr, y);
          ctx.arcTo(x + w, y, x + w, y + h, rr);
          ctx.arcTo(x + w, y + h, x, y + h, rr);
          ctx.arcTo(x, y + h, x, y, rr);
          ctx.arcTo(x, y, x + w, y, rr);
          ctx.closePath();
          if (cmd.fill) ctx.fill();
          if (cmd.stroke) ctx.stroke();
        } else {
          if (cmd.fill) ctx.fillRect(cmd.x, cmd.y, cmd.w, cmd.h);
          if (cmd.stroke) ctx.strokeRect(cmd.x, cmd.y, cmd.w, cmd.h);
        }
        break;
      }

      case 'circle': {
        applyStrokeFill(ctx, cmd);
        ctx.beginPath();
        ctx.arc(cmd.x, cmd.y, cmd.r, 0, Math.PI * 2);
        if (cmd.fill) ctx.fill();
        if (cmd.stroke) ctx.stroke();
        break;
      }

      case 'ellipse': {
        applyStrokeFill(ctx, cmd);
        ctx.beginPath();
        ctx.ellipse(cmd.x, cmd.y, cmd.rx, cmd.ry, cmd.rotation || 0, 0, Math.PI * 2);
        if (cmd.fill) ctx.fill();
        if (cmd.stroke) ctx.stroke();
        break;
      }

      case 'line': {
        if (!Array.isArray(cmd.points) || cmd.points.length < 4) break;
        applyStrokeFill(ctx, cmd);
        if (cmd.cap) ctx.lineCap = cmd.cap;
        if (cmd.join) ctx.lineJoin = cmd.join;
        if (cmd.dash && ctx.setLineDash) ctx.setLineDash(cmd.dash);
        ctx.beginPath();
        ctx.moveTo(cmd.points[0], cmd.points[1]);
        for (let i = 2; i < cmd.points.length; i += 2) {
          ctx.lineTo(cmd.points[i], cmd.points[i + 1]);
        }
        ctx.stroke();
        if (ctx.setLineDash) ctx.setLineDash([]);
        break;
      }

      case 'poly': {
        if (!Array.isArray(cmd.points) || cmd.points.length < 4) break;
        applyStrokeFill(ctx, cmd);
        ctx.beginPath();
        ctx.moveTo(cmd.points[0], cmd.points[1]);
        for (let i = 2; i < cmd.points.length; i += 2) {
          ctx.lineTo(cmd.points[i], cmd.points[i + 1]);
        }
        if (cmd.close !== false) ctx.closePath();
        if (cmd.fill) ctx.fill();
        if (cmd.stroke) ctx.stroke();
        break;
      }

      case 'image': {
        applyCompositeAndAlpha(ctx, cmd);
        const key = resolveImageKey(cmd.src);
        let imgRec = key && cache.images.get(key);
        if (!imgRec) {
          try {
            const img = await fetchImageForKey(key, cmd.src);
            imgRec = { img };
            cache.images.set(key, imgRec);
          } catch (e) {
            console.warn('[engine-canvas] image load failed', e);
            resetCompositeAndAlpha(ctx);
            break;
          }
        }
        if (!imgRec || !imgRec.img) { resetCompositeAndAlpha(ctx); break; }

        const img = imgRec.img;
        const dw = cmd.w || img.width;
        const dh = cmd.h || img.height;

        if (cmd.sx != null) {
          ctx.drawImage(img, cmd.sx, cmd.sy, cmd.sw, cmd.sh, cmd.x, cmd.y, dw, dh);
        } else {
          ctx.drawImage(img, cmd.x, cmd.y, dw, dh);
        }
        resetCompositeAndAlpha(ctx);
        break;
      }

      case 'sprite': {
        // Sheet load
        const key = resolveImageKey(cmd.sheet);
        let imgRec = key && cache.images.get(key);
        if (!imgRec) {
          try {
            const img = await fetchImageForKey(key, cmd.sheet);
            imgRec = { img, offscreen: null, tinted: null, tintKey: null };
            cache.images.set(key, imgRec);
          } catch (e) {
            console.warn('[engine-canvas] sprite sheet load failed', e);
            break;
          }
        }
        if (!imgRec || !imgRec.img) break;

        const img = imgRec.img;
        const tileW = cmd.tileW;
        const tileH = cmd.tileH;
        const cols = Math.floor(img.width / tileW);
        const sliceKey = `${key}:${cmd.index}`;
        let slice = cache.sheetSlices.get(sliceKey);
        if (!slice) {
          slice = getSheetSlice(img, tileW, tileH, cmd.index, cols);
          cache.sheetSlices.set(sliceKey, slice);
        }

        const scaleX = cmd.scaleX != null ? cmd.scaleX : 1;
        const scaleY = cmd.scaleY != null ? cmd.scaleY : 1;
        const dx = cmd.x || 0;
        const dy = cmd.y || 0;
        const rot = cmd.rot || 0;
        const anchorX = cmd.anchorX != null ? cmd.anchorX : 0.5;
        const anchorY = cmd.anchorY != null ? cmd.anchorY : 0.5;
        const flipX = !!cmd.flipX;
        const flipY = !!cmd.flipY;

        withTransform(ctx, () => {
          ctx.translate(dx, dy);
          if (rot) ctx.rotate(rot);
          ctx.scale(flipX ? -scaleX : scaleX, flipY ? -scaleY : scaleY);

          const ox = -tileW * anchorX;
          const oy = -tileH * anchorY;

          let source = img;
          if (cmd.tint) {
            source = tintImageToCanvas(img, cmd.tint, imgRec);
          }

          ctx.drawImage(
            source,
            slice.sx, slice.sy, slice.sw, slice.sh,
            ox, oy, tileW, tileH
          );
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

        ctx.font = `${weight ? weight + ' ' : ''}${size}px ${family}`;
        ctx.textAlign = align;
        ctx.textBaseline = baseline;
        if (cmd.fill) {
          ctx.fillStyle = cmd.fill;
          if (cmd.maxWidth) ctx.fillText(text, cmd.x, cmd.y, cmd.maxWidth);
          else ctx.fillText(text, cmd.x, cmd.y);
        }
        if (cmd.stroke) {
          ctx.lineWidth = cmd.lineWidth || 1;
          ctx.strokeStyle = cmd.stroke;
          if (cmd.maxWidth) ctx.strokeText(text, cmd.x, cmd.y, cmd.maxWidth);
          else ctx.strokeText(text, cmd.x, cmd.y);
        }
        break;
      }

      case 'tilemap': {
        // Fast fixed-grid renderer
        const key = resolveImageKey(cmd.sheet);
        let imgRec = key && cache.images.get(key);
        if (!imgRec) {
          try {
            const img = await fetchImageForKey(key, cmd.sheet);
            imgRec = { img };
            cache.images.set(key, imgRec);
          } catch (e) {
            console.warn('[engine-canvas] tilemap sheet load failed', e);
            break;
          }
        }
        if (!imgRec || !imgRec.img) break;
        const img = imgRec.img;

        const tileW = cmd.tileW, tileH = cmd.tileH;
        const cols = Math.floor(img.width / tileW);
        const rows = Math.floor(img.height / tileH);

        const mapCols = cmd.cols, mapRows = cmd.rows;
        const data = cmd.data || [];
        const originX = cmd.x || 0, originY = cmd.y || 0;
        const scale = cmd.scale || 1;

        for (let my = 0; my < mapRows; my++) {
          for (let mx = 0; mx < mapCols; mx++) {
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

      default:
        // Unknown type; ignore
        break;
    }
  }

  // Layers
  async function drawArray(arr) {
    for (let i = 0; i < arr.length; i++) {
      await drawCommand(arr[i]);
    }
  }

  async function drawLayer(layer) {
    if (!layer) return;
    ctx.save();
    if (layer.alpha != null) ctx.globalAlpha = clamp(layer.alpha, 0, 1);
    if (layer.blend) ctx.globalCompositeOperation = layer.blend;
    if (Array.isArray(layer.children)) {
      for (let i = 0; i < layer.children.length; i++) {
        const c = layer.children[i];
        if (c && c.type === 'layer') await drawLayer(c);
        else await drawCommand(c);
      }
    }
    ctx.restore();
  }

  // Render order: layers if present else per-bucket
  if (Array.isArray(gfx.layers)) {
    for (let i = 0; i < gfx.layers.length; i++) {
      await drawLayer(gfx.layers[i]);
    }
  } else {
    if (Array.isArray(gfx.shapes)) await drawArray(gfx.shapes);
    if (Array.isArray(gfx.images)) await drawArray(gfx.images);
    if (Array.isArray(gfx.sprites)) await drawArray(gfx.sprites);
    if (Array.isArray(gfx.text)) await drawArray(gfx.text);
    if (gfx.tilemap) await drawCommand(gfx.tilemap);
  }

  ctx.restore();

  // Optionally draw debug grid
  if (gfx.debug && gfx.debug.grid) {
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    const step = gfx.debug.grid.step || 16;
    for (let x = 0; x < canvas.width; x += step * metrics.scale) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += step * metrics.scale) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    ctx.restore();
  }

  // Attach input (once)
  if ((opts.postId || typeof opts.onInput === 'function') && !cache.listenersAttached) {
    attachInputHandlers(canvas, cache, metrics, opts);
    cache.listenersAttached = true;
  }
}

// ---------- Input wiring ----------
function emitInput(opts, payload) {
  try {
    if (typeof opts.onInput === 'function') {
      opts.onInput(payload);
      return;
    }
    if (opts.postId && typeof window.interactWithLivingPost === 'function') {
      // Must be a JSON string; the host accepts raw JSON string or object.
      window.interactWithLivingPost(opts.postId, JSON.stringify(payload));
    }
  } catch (e) {
    console.warn('[engine-canvas] input emit failed', e);
  }
}

function attachInputHandlers(canvas, cache, metrics, opts) {
  // Make canvas focusable for keyboard
  if (!canvas.hasAttribute('tabindex')) canvas.setAttribute('tabindex', '0');

  function localPos(evt) {
    const rect = canvas.getBoundingClientRect();
    const px = (evt.clientX - rect.left) * (canvas.width / rect.width);
    const py = (evt.clientY - rect.top) * (canvas.height / rect.height);
    const w = toWorldCoords(cache, metrics, px, py);
    return { px, py, ...w };
    }

  let isDown = false;
  let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.focus();
    isDown = true;
    const p = localPos(e);
    last = p;
    emitInput(opts, { action: 'pointer', kind: 'down', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, button: e.button || 0 });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!isDown) return;
    const p = localPos(e);
    emitInput(opts, {
      action: 'pointer', kind: 'move',
      x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY,
      dx: last ? (p.px - last.px) : 0, dy: last ? (p.py - last.py) : 0
    });
    last = p;
  });
  window.addEventListener('pointerup', (e) => {
    if (!isDown) return;
    isDown = false;
    const p = localPos(e);
    emitInput(opts, { action: 'pointer', kind: 'up', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, button: e.button || 0 });
  }, { passive: true });

  canvas.addEventListener('wheel', (e) => {
    const p = localPos(e);
    emitInput(opts, { action: 'pointer', kind: 'wheel', x: p.px, y: p.py, worldX: p.worldX, worldY: p.worldY, dx: e.deltaX, dy: e.deltaY });
  }, { passive: true });

  canvas.addEventListener('keydown', (e) => {
    // Allow arrows, WASD, space, enter, digits, letters
    emitInput(opts, { action: 'key', kind: 'down', key: e.key });
    // Prevent page scrolling with arrows/space
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
      e.preventDefault();
    }
  });
  canvas.addEventListener('keyup', (e) => {
    emitInput(opts, { action: 'key', kind: 'up', key: e.key });
  });
}

// Optional helper for external callers
export function clearCanvas(canvas) {
  if (canvas && canvas.getContext) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}
