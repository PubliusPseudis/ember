// FILE: engine-sim-platformer.js
// Host-only mini platformer sim that renders through engine-canvas.
//
// What it does:
// - Steps a deterministic(ish) 60 FPS platformer loop (AABB + tile collisions).
// - Consumes keyboard/pointer input (WASD/Arrows, Space for jump).
// - Builds a gfx spec each frame and calls drawGfxIntoCanvas(canvas, gfx, { onInput }).
// - No LP code is executed here. Safe host adapter.
//
// Spec shape (lpState.sim):
// {
//   "type": "platformer",
//   "version": 1,
//   "background": "#0b0d12",
//   "gravity": 1500,
//   "maxSpeed": { "x": 220, "y": 1200 },
//   "moveAccel": 1200,
//   "airAccel": 800,
//   "friction": 0.85,
//   "jumpVel": 480,
//   "coyoteMs": 120,
//   "jumpBufferMs": 120,
//   "sheet": { "hash": "<hash or dataUri/url in {dataUri|url}>" },
//   "tileW": 16, "tileH": 16,
//   "tilemap": { "cols": 64, "rows": 18, "data": [ ...tile indices... ], "solid": [1,2,3,4] },
//   "spawn": { "x": 32, "y": 32 },
//   "player": {
//       "w": 12, "h": 14,
//       "sprite": {
//          "indexIdle": 0,
//          "indexRun": [1,2,3,4],
//          "indexJump": 5,
//          "indexFall": 6,
//          "scale": 2,
//          "anchorX": 0.5, "anchorY": 1
//       }
//   },
//   "camera": { "deadzone": { "w": 80, "h": 60 } },
//   "ui": { "showDebug": false, "hint": "WASD/Arrows, Space to jump" }
// }
//
// mountPlatformer(canvas, spec, opts?) returns { update(spec), dispose() }
//
// Notes:
// - We intentionally do *not* forward inputs to LP by default, since this is
//   a local sim. If you want that later, we can add an option to forward.
import { drawGfxIntoCanvas } from './engine-canvas.js';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const nowMs = () => performance.now();

// --- Core mount ---
export async function mountPlatformer(canvas, spec, opts = {}) {
  // Reuse existing instance on this canvas if present
  if (canvas.__platformer) {
    canvas.__platformer.update(spec);
    return canvas.__platformer.api;
  }

  const engine = new PlatformerEngine(canvas, spec, opts);
  canvas.__platformer = engine;
  engine.start();

  return engine.api;
}

// --- Engine class ---
class PlatformerEngine {
  constructor(canvas, spec, opts) {
    this.canvas = canvas;
    this.opts = opts || {};
    this.setSpec(spec || {});
    this.running = false;
    this.raf = 0;
    this.lastT = 0;

    // Input state
    this.keys = new Set();
    this.pointer = { down: false, x: 0, y: 0 };

    // Public API
    this.api = {
      update: (s) => this.update(s),
      dispose: () => this.dispose()
    };
  }

  setSpec(spec) {
    const s = this.spec = normalizeSpec(spec);

    // World dims (in pixels)
    this.worldPxW = s.tilemap.cols * s.tileW;
    this.worldPxH = s.tilemap.rows * s.tileH;

    // Player
    this.player = {
      x: s.spawn.x, y: s.spawn.y,
      vx: 0, vy: 0,
      w: s.player.w, h: s.player.h,
      onGround: false,
      lastGroundMs: 0,
      jumpBufferedMs: 0,
      facing: 1, // 1 right, -1 left
      runT: 0 // for run animation
    };

    // Camera
    this.camera = {
      x: 0, y: 0,
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.lastT = nowMs();
    this.loop();
  }

  update(newSpec) {
    // Soft update: preserve player position if tile sizes unchanged
    const old = this.spec;
    const oldTile = `${old.tileW}x${old.tileH}`;
    const newTile = `${newSpec.tileW}x${newSpec.tileH}`;
    const px = this.player?.x || this.spec.spawn.x;
    const py = this.player?.y || this.spec.spawn.y;

    this.setSpec(newSpec);

    if (oldTile === newTile) {
      this.player.x = px;
      this.player.y = py;
    }
  }

  dispose() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    // best-effort cleanup flag
    if (this.canvas) {
      this.canvas.__platformer = undefined;
    }
  }

  // --- Main Loop ---
  loop = async () => {
    if (!this.running) return;
    const t = nowMs();
    let dt = (t - this.lastT) / 1000;
    this.lastT = t;

    // Clamp dt to avoid spirals
    dt = Math.min(dt, 0.035); // ~28 FPS min step

    // Collect inputs via engine-canvas (attached once), then step sim
    await this.renderFrame(dt);

    this.raf = requestAnimationFrame(this.loop);
  };

  // --- Input handler (wired through engine-canvas onInput) ---
  handleInput = (ev) => {
    if (!ev) return;

    if (ev.action === 'key') {
      const k = (ev.key || '').toLowerCase();
      if (ev.kind === 'down') {
        this.keys.add(k);
        if (k === ' ' || k === 'spacebar') {
          this.player.jumpBufferedMs = this.spec.jumpBufferMs;
        }
      } else if (ev.kind === 'up') {
        this.keys.delete(k);
      }
    } else if (ev.action === 'pointer') {
      if (ev.kind === 'down') {
        this.pointer.down = true;
        this.pointer.x = ev.worldX; this.pointer.y = ev.worldY;
      } else if (ev.kind === 'move') {
        this.pointer.x = ev.worldX; this.pointer.y = ev.worldY;
      } else if (ev.kind === 'up') {
        this.pointer.down = false;
      } else if (ev.kind === 'wheel') {
        // No-op; could zoom camera later.
      }
    }
  };

  // --- Physics step + Render ---
  async renderFrame(dt) {
    const s = this.spec;
    const p = this.player;

    // Input → acceleration
    const left  = this.isDown('arrowleft') || this.isDown('a');
    const right = this.isDown('arrowright') || this.isDown('d');
    const up    = this.isDown('arrowup') || this.isDown('w') || this.isDown(' ');
    const onGroundPrev = p.onGround;

    const accel = p.onGround ? s.moveAccel : s.airAccel;
    if (left === right) {
      // friction
      if (p.onGround) p.vx *= s.friction;
    } else if (left) {
      p.vx -= accel * dt;
      p.facing = -1;
    } else if (right) {
      p.vx += accel * dt;
      p.facing = 1;
    }

    p.vx = clamp(p.vx, -s.maxSpeed.x, s.maxSpeed.x);

    // Gravity
    p.vy += s.gravity * dt;
    p.vy = clamp(p.vy, -s.maxSpeed.y, s.maxSpeed.y);

    // Coyote + jump buffer
    if (p.onGround) p.lastGroundMs = s.coyoteMs;
    else p.lastGroundMs = Math.max(0, p.lastGroundMs - dt * 1000);
    p.jumpBufferedMs = Math.max(0, p.jumpBufferedMs - dt * 1000);

    if (p.jumpBufferedMs > 0 && p.lastGroundMs > 0 && up) {
      p.vy = -s.jumpVel;
      p.onGround = false;
      p.jumpBufferedMs = 0;
      p.lastGroundMs = 0;
    }

    // Integrate with tile collisions (separable axis)
    const nextX = p.x + p.vx * dt;
    const nx = this.resolveAxis(nextX, p.y, p.w, p.h, p.vx, 0);
    p.x = nx.pos;
    if (nx.hit) p.vx = 0;

    const nextY = p.y + p.vy * dt;
    const ny = this.resolveAxis(p.x, nextY, p.w, p.h, 0, p.vy);
    p.y = ny.pos;
    if (ny.hit) p.vy = 0;

    // Ground check
    const foot = this.overlapsSolid(p.x, p.y + 1, p.w, p.h);
    p.onGround = !!foot;

    // Run anim timer
    if (Math.abs(p.vx) > 5 && p.onGround) p.runT += dt * 10; else p.runT = 0;

    // Camera follow with deadzone
    this.updateCamera(dt);

    // Build gfx spec
    const gfx = buildGfx(this.spec, this.player, this.camera);

    // Render via canvas engine (and capture inputs)
    await drawGfxIntoCanvas(this.canvas, gfx, { onInput: this.handleInput });
  }

  isDown(k) { return this.keys.has(k); }

  // --- Collision helpers ---
  tileAt(tx, ty) {
    const tm = this.spec.tilemap;
    if (tx < 0 || ty < 0 || tx >= tm.cols || ty >= tm.rows) return -1;
    return tm.data[ty * tm.cols + tx] ?? -1;
  }

  isSolidIdx(idx) {
    return this.spec.tilemap.solidSet.has(idx);
  }

  rectOverlapsTile(px, py, pw, ph, tx, ty) {
    const s = this.spec;
    const rx = tx * s.tileW;
    const ry = ty * s.tileH;
    const rw = s.tileW, rh = s.tileH;
    return !(px + pw <= rx || px >= rx + rw || py + ph <= ry || py >= ry + rh);
  }

  overlapsSolid(px, py, pw, ph) {
    const s = this.spec;
    const minTx = Math.floor(px / s.tileW);
    const maxTx = Math.floor((px + pw - 1) / s.tileW);
    const minTy = Math.floor(py / s.tileH);
    const maxTy = Math.floor((py + ph - 1) / s.tileH);

    for (let ty = minTy; ty <= maxTy; ty++) {
      for (let tx = minTx; tx <= maxTx; tx++) {
        const idx = this.tileAt(tx, ty);
        if (idx >= 0 && this.isSolidIdx(idx)) {
          if (this.rectOverlapsTile(px, py, pw, ph, tx, ty)) return { tx, ty, idx };
        }
      }
    }
    return null;
  }

  resolveAxis(px, py, pw, ph, vx, vy) {
    // Move along one axis and resolve collisions on that axis.
    const s = this.spec;
    let pos = (vy === 0) ? px : py;
    let hit = false;

    const steps = 1; // can increase if tunneling
    for (let i = 0; i < steps; i++) {
      const testX = (vy === 0) ? pos : px;
      const testY = (vy === 0) ? py : pos;
      const hitInfo = this.overlapsSolid(testX, testY, pw, ph);

      if (!hitInfo) break;

      hit = true;
      // Push out minimally
      const tileX = hitInfo.tx * s.tileW;
      const tileY = hitInfo.ty * s.tileH;
      if (vy === 0) {
        if (vx > 0) pos = tileX - pw - 0.01;
        else if (vx < 0) pos = tileX + s.tileW + 0.01;
        else break;
      } else {
        if (vy > 0) pos = tileY - ph - 0.01;     // landing on floor
        else if (vy < 0) pos = tileY + s.tileH + 0.01; // hitting ceiling
        else break;
      }
    }
    return { pos, hit };
  }

  // --- Camera follow ---
  updateCamera(dt) {
    const s = this.spec;
    const p = this.player;

    const dzW = (s.camera?.deadzone?.w ?? 80);
    const dzH = (s.camera?.deadzone?.h ?? 60);

    let cx = this.camera.x;
    let cy = this.camera.y;

    const left  = cx - dzW * 0.5;
    const right = cx + dzW * 0.5;
    const top   = cy - dzH * 0.5;
    const bot   = cy + dzH * 0.5;

    const px = p.x + p.w * 0.5;
    const py = p.y + p.h * 0.5;

    if (px < left)  cx = px + dzW * 0.5;
    if (px > right) cx = px - dzW * 0.5;
    if (py < top)   cy = py + dzH * 0.5;
    if (py > bot)   cy = py - dzH * 0.5;

    // Clamp to world bounds
    const halfW = 80; // logical half extents for camera (tuned with gfx width/height)
    const halfH = 60;
    cx = clamp(cx, halfW, Math.max(halfW, this.worldPxW - halfW));
    cy = clamp(cy, halfH, Math.max(halfH, this.worldPxH - halfH));

    this.camera.x = cx;
    this.camera.y = cy;
  }
}

// --- Helpers: normalize spec & gfx builder ---
function normalizeSpec(s) {
  const solidSet = new Set((s.tilemap?.solid) || [1,2,3,4,5,6,7,8,9]);
  return {
    type: 'platformer',
    version: 1,
    background: s.background || '#0b0d12',
    gravity: s.gravity ?? 1500,
    maxSpeed: { x: s.maxSpeed?.x ?? 220, y: s.maxSpeed?.y ?? 1200 },
    moveAccel: s.moveAccel ?? 1200,
    airAccel: s.airAccel ?? 800,
    friction: s.friction ?? 0.85,
    jumpVel: s.jumpVel ?? 480,
    coyoteMs: s.coyoteMs ?? 120,
    jumpBufferMs: s.jumpBufferMs ?? 120,
    sheet: s.sheet || null,
    tileW: s.tileW ?? 16,
    tileH: s.tileH ?? 16,
    tilemap: {
      cols: s.tilemap?.cols ?? 32,
      rows: s.tilemap?.rows ?? 18,
      data: s.tilemap?.data || new Array((s.tilemap?.cols ?? 32)*(s.tilemap?.rows ?? 18)).fill(0),
      solid: s.tilemap?.solid || [1,2,3,4,5,6,7,8,9],
      solidSet
    },
    spawn: { x: s.spawn?.x ?? 16, y: s.spawn?.y ?? 16 },
    player: {
      w: s.player?.w ?? 12,
      h: s.player?.h ?? 14,
      sprite: {
        indexIdle: s.player?.sprite?.indexIdle ?? 0,
        indexRun: s.player?.sprite?.indexRun ?? [1,2,3,4],
        indexJump: s.player?.sprite?.indexJump ?? 5,
        indexFall: s.player?.sprite?.indexFall ?? 6,
        scale: s.player?.sprite?.scale ?? 2,
        anchorX: s.player?.sprite?.anchorX ?? 0.5,
        anchorY: s.player?.sprite?.anchorY ?? 1
      }
    },
    camera: s.camera || { deadzone: { w: 80, h: 60 } },
    ui: {
      showDebug: !!(s.ui && s.ui.showDebug),
      hint: (s.ui && s.ui.hint) || 'WASD/Arrows, Space to jump'
    }
  };
}

function pickPlayerFrame(spec, player) {
  if (!player.onGround) return (player.vy < 0) ? spec.player.sprite.indexJump : spec.player.sprite.indexFall;
  const speed = Math.abs(player.vx);
  if (speed < 5) return spec.player.sprite.indexIdle;
  const run = spec.player.sprite.indexRun;
  const idx = Math.floor(player.runT) % run.length;
  return run[idx];
}

function buildGfx(spec, player, camera) {
  const cam = { x: camera.x, y: camera.y, zoom: 1, rotation: 0 };

  const width = 160;  // logical view (world units)
  const height = 120;

  const tileLayer = {
    type: 'tilemap',
    sheet: spec.sheet,
    tileW: spec.tileW,
    tileH: spec.tileH,
    cols: spec.tilemap.cols,
    rows: spec.tilemap.rows,
    data: spec.tilemap.data,
    x: 0, y: 0,
    scale: 1
  };

  const playerSprite = {
    type: 'sprite',
    sheet: spec.sheet,
    tileW: spec.tileW,
    tileH: spec.tileH,
    index: pickPlayerFrame(spec, player),
    x: Math.floor(player.x + player.w * 0.5),
    y: Math.floor(player.y + player.h),
    scaleX: spec.player.sprite.scale * (player.facing < 0 ? -1 : 1),
    scaleY: spec.player.sprite.scale,
    anchorX: spec.player.sprite.anchorX,
    anchorY: spec.player.sprite.anchorY
  };

  const hud = [
    { type: 'rect', x: -width/2, y: -height/2, w: width, h: 14, fill: 'rgba(0,0,0,0.35)' },
    { type: 'text', str: spec.ui.hint, x: -width/2 + 4, y: -height/2 + 10, size: 10, fill: '#fff', align: 'left', baseline: 'alphabetic' }
  ];

  if (spec.ui.showDebug) {
    hud.push({ type: 'text',
               str: `x:${player.x.toFixed(1)} y:${player.y.toFixed(1)} vx:${player.vx.toFixed(1)} vy:${player.vy.toFixed(1)} ground:${player.onGround}`,
               x: -width/2 + 4, y: -height/2 + 24, size: 9, fill: '#9cf', align: 'left', baseline: 'alphabetic' });
  }

  return {
    version: 1,
    width, height,
    background: spec.background,
    camera: cam,
    viewport: { fit: 'contain' },
    clear: true,
    layers: [
      { alpha: 1, children: [ tileLayer ] },
      { alpha: 1, children: [ playerSprite ] },
      { alpha: 1, children: hud }
    ],
    debug: { grid: { step: 16 } }
  };
}
