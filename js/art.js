// art.js: build slice stacks from small functions, with a normal for every visible pixel, and pack them in one atlas.
//
// A stack is described as a box of art pixels and a function fn(x, y, z) -> material name or null (x forward,
// y sideways, measured from the middle; z is the layer). Each layer becomes one slice: a small image whose pixels
// hold a palette index and the direction that point of the surface faces. Nothing is lit here; the light pass
// (engine.js) does that once per screen pixel.
//
// Two things keep the fill cost down:
//  - every slice is cropped to the pixels it really has, and empty layers are dropped;
//  - "shell" stacks keep only pixels near the surface. A pixel deep inside a solid can never be seen, because
//    the layer above always covers it, so it is left out and its fragments are never written.
//
// Optional fields of a description:
//   pad    the function is also valid this many pixels outside the box (ground tiles: the neighbour tile is there,
//          so the edge of a tile is not a surface and gets no side-facing normals)
//   bump   function (x, y, z) -> [dx, dy]: tilts the normal of that pixel (furrows, cobbles), costs nothing to draw
//   soft   0 to 1: pull every normal towards "up" (grass, wheat, smoke: a field of single stalks would sparkle)
(function (global) {
  'use strict';

  // The palette: material name -> index. Index 0 is "nothing". glow: 1 always shines (fire); between 0 and 1 the
  // material is a lamp or a lit window, dark by day and shining at dusk (see the light pass).
  function Palette() { this.names = { }; this.rgba = [[0, 0, 0, 0]]; }
  Palette.prototype.add = function (name, hex, glow) {
    if (this.rgba.length > 255) throw new Error('the palette holds 255 materials');
    this.names[name] = this.rgba.length;
    this.rgba.push([parseInt(hex.substr(1, 2), 16), parseInt(hex.substr(3, 2), 16), parseInt(hex.substr(5, 2), 16), Math.round((glow || 0) * 255)]);
  };
  Palette.prototype.bytes = function () { const b = new Uint8Array(256 * 4); this.rgba.forEach(function (c, i) { b.set(c, i * 4); }); return b; };

  // Fill the box with palette indices (once per description; both the whole and the shell build read it).
  function fill(def, pal) {
    if (def.vox) return def.vox;
    const pad = def.pad || 0, w = def.w + pad * 2, h = def.h + pad * 2, n = def.layers, vox = new Uint8Array(w * h * n);
    for (let z = 0; z < n; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const m = def.fn(x + 0.5 - w / 2, y + 0.5 - h / 2, z);
      if (m) { const id = pal.names[m]; if (!id) throw new Error(def.name + ': no material "' + m + '"'); vox[(z * h + y) * w + x] = id; }
    }
    return (def.vox = vox);
  }

  // How deep every pixel lies inside its own layer: 0 for empty, 1 on the outline, capped at 6 (two sweeps).
  function depths(vox, w, h, n) {
    const dep = new Uint8Array(w * h * n);
    for (let z = 0; z < n; z++) {
      const o = z * w * h;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = o + y * w + x; if (!vox[i]) continue;
        let d = 5; if (x === 0 || y === 0) d = 0; else d = Math.min(d, dep[i - 1], dep[i - w], dep[i - w - 1], x + 1 < w ? dep[i - w + 1] : 0);
        dep[i] = d + 1;
      }
      for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) {
        const i = o + y * w + x; if (!vox[i]) continue;
        let d = dep[i] - 1; if (x === w - 1 || y === h - 1) d = 0; else d = Math.min(d, dep[i + 1], dep[i + w], dep[i + w + 1], x > 0 ? dep[i + w - 1] : 0);
        dep[i] = d + 1;
      }
    }
    return dep;
  }

  // Give every surface pixel a normal: the sum of the directions towards the empty space within two pixels of it,
  // nearer space counting more. Two pixels (not one) rounds corners a little and turns the steps of a roof into a
  // slope. shell: how many pixels deep the kept surface is (0 keeps everything).
  function voxelise(def, pal, shell) {
    const pad = def.pad || 0, w = def.w + pad * 2, h = def.h + pad * 2, n = def.layers, wh = w * h;
    const vox = fill(def, pal), dep = depths(vox, w, h, n), soft = def.soft || 0, layers = [];
    for (let z = 0; z < n; z++) {
      let x0 = w, y0 = h, x1 = -1, y1 = -1, sides = false; const px = new Uint8Array(def.w * def.h * 4);
      for (let y = pad; y < h - pad; y++) for (let x = pad; x < w - pad; x++) {
        const i = z * wh + y * w + x, id = vox[i]; if (!id) continue;
        // depth in this layer, the one above and the one below (above the top is empty; under the ground is not)
        const d0 = dep[i], da = z + 1 < n ? dep[i + wh] : 0, db = z > 0 ? dep[i - wh] : 9;
        if (shell && d0 > shell && da > shell && db > shell) continue;      // deep inside: never visible, leave it out
        let nx = 0, ny = 0, nz = 0, open = 0;
        if (d0 <= 2 || da <= 2 || db <= 2 || z + 2 >= n || (z > 1 && dep[i - 2 * wh] <= 2) || dep[i + 2 * wh] <= 2) {
          for (let dz = -2; dz <= 2; dz++) {
            const zz = z + dz; if (zz < 0) continue;
            for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
              const xx = x + dx, yy = y + dy;
              if (zz < n && xx >= 0 && yy >= 0 && xx < w && yy < h && vox[zz * wh + yy * w + xx]) continue;
              const k = 1 / (dx * dx + dy * dy + dz * dz); nx += dx * k; ny += dy * k; nz += dz * k; open++;
            }
          }
        }
        // A pixel just under the surface has no empty space near it, but a shallow view ray still lands on it (it
        // passes over the outer pixel of the copy above). Give it the facing of the nearest side, or walls speckle.
        if (!open && d0 <= 5) for (let r = 3; r <= 5 && !open; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < w && yy < h && vox[z * wh + yy * w + xx]) continue; nx += dx; ny += dy; open++;
        }
        if (z + 1 >= n || !vox[i + wh]) nz += 1.2;                 // a top counts for more: it is the face the camera sees most
        let len = Math.hypot(nx, ny, nz); if (len < 0.01 || !open) { nx = 0; ny = 0; nz = 1; } else { nx /= len; ny /= len; nz /= len; }
        if (def.bump) { const b = def.bump(x + 0.5 - w / 2, y + 0.5 - h / 2, z); if (b) { nx += b[0]; ny += b[1]; } }
        if (soft) { nx *= 1 - soft; ny *= 1 - soft; nz = nz * (1 - soft) + soft; }
        len = Math.hypot(nx, ny, nz) || 1; nx /= len; ny /= len; nz /= len;
        if (d0 === 1) sides = true;                                // on the outline of its layer: this layer has a side to show
        const lx = x - pad, ly = y - pad, j = (ly * def.w + lx) * 4;
        px[j] = id; px[j + 1] = Math.round(nx * 127 + 128); px[j + 2] = Math.round(ny * 127 + 128); px[j + 3] = Math.round(nz * 127 + 128);
        if (lx < x0) x0 = lx; if (lx > x1) x1 = lx; if (ly < y0) y0 = ly; if (ly > y1) y1 = ly;
      }
      layers.push(x1 < 0 ? null : { px: px, x0: x0, y0: y0, w: x1 - x0 + 1, h: y1 - y0 + 1, sides: sides });
    }
    return { vox: vox, layers: layers };
  }

  // The atlas: every slice of every stack in one RGBA texture (index, normal x, normal y, normal z), packed in rows.
  // opts.self (optional): also two more textures of the same layout with each pixel's baked self-shading (see
  // bakeSelf): self0 R its own occlusion, self1 its shadow from 8 directions round it, 4 bits each. They start
  // full (255: no occlusion, no shadow), so stacks that are not baked are not darkened.
  function Atlas(size, opts) {
    this.size = size; this.data = new Uint8Array(size * size * 4); this.x = 1; this.y = 1; this.rowH = 0; this.used = 0;
    this.self0 = opts && opts.self ? new Uint8Array(size * size * 4).fill(255) : null; this.self1 = this.self0 ? new Uint8Array(size * size * 4).fill(255) : null;
    this.selfElevation = opts && opts.elevation !== undefined ? opts.elevation : 0.7; this.bakeMs = 0;
  }
  Atlas.prototype.put = function (px, srcW, x0, y0, w, h, s0, s1) {
    if (this.x + w + 1 > this.size) { this.x = 1; this.y += this.rowH + 1; this.rowH = 0; }
    if (this.y + h + 1 > this.size) throw new Error('atlas full');
    for (let y = 0; y < h; y++) this.data.set(px.subarray(((y0 + y) * srcW + x0) * 4, ((y0 + y) * srcW + x0 + w) * 4), ((this.y + y) * this.size + this.x) * 4);
    if (s0 && this.self0) for (let y = 0; y < h; y++) {
      const a = ((y0 + y) * srcW + x0) * 4, b = ((this.y + y) * this.size + this.x) * 4;
      this.self0.set(s0.subarray(a, a + w * 4), b); this.self1.set(s1.subarray(a, a + w * 4), b);
    }
    const at = [this.x, this.y]; this.x += w + 1; if (h > this.rowH) this.rowH = h; this.used += w * h; return at;
  };

  // SELF-SHADING, baked once per model from its own voxels (only when the atlas asks for it):
  //   occlusion  how much of the space round each voxel is solid, at two radii (2 and 4 voxels): a recess, the
  //              underside of an eave, the joint of a leg and a body are darker; a flat face is 1. Below the box
  //              counts as solid (the ground).
  //   shadow     for 8 directions round the model at one elevation (the scene's key light), whether a ray from
  //              the voxel towards the light meets the model's own voxels, and how near: the engine reads the two
  //              directions either side of the real light and mixes them
  // Returns, per voxel of the box, its occlusion (a byte) and its 8 shadows (4 bits each, in 4 bytes).
  function bakeSelf(def, vox, el) {
    if (def.selfBake && def.selfBake.el === el) return def.selfBake;
    const pad = def.pad || 0, w = def.w + pad * 2, h = def.h + pad * 2, n = def.layers, wh = w * h, N = wh * n;
    const solid = function (x, y, z) { return z < 0 ? 1 : x < 0 || y < 0 || z >= n || x >= w || y >= h ? 0 : vox[(z * h + y) * w + x] ? 1 : 0; };
    // box sums of the occupancy, radius r, by three passes along x, y and z (the ground below z = 0 counts)
    const box = function (r) {
      const a = new Float32Array(N), b = new Float32Array(N);
      for (let z = 0; z < n; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let c = 0; for (let d = -r; d <= r; d++) c += solid(x + d, y, z); a[(z * h + y) * w + x] = c; }
      for (let z = 0; z < n; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let c = 0; for (let d = -r; d <= r; d++) { const yy = y + d; c += yy < 0 || yy >= h ? 0 : a[(z * h + yy) * w + x]; } b[(z * h + y) * w + x] = c; }
      for (let z = 0; z < n; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let c = 0; for (let d = -r; d <= r; d++) { const zz = z + d; c += zz < 0 ? (2 * r + 1) * (2 * r + 1) : zz >= n ? 0 : b[(zz * h + y) * w + x]; } a[(z * h + y) * w + x] = c / Math.pow(2 * r + 1, 3); }
      return a;
    };
    const b2 = box(2), b4 = box(4), ao = new Uint8Array(N), sh = new Uint8Array(N * 4);
    const ce = Math.cos(el), se = Math.sin(el), DX = [], DY = [];
    for (let k = 0; k < 8; k++) { DX.push(Math.cos(k * Math.PI / 4) * ce); DY.push(Math.sin(k * Math.PI / 4) * ce); }
    const S = 40;      // the furthest a ray looks, in voxels
    for (let z = 0; z < n; z++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (z * h + y) * w + x; if (!vox[i]) continue;
      // a voxel with no empty neighbour is never seen
      if (solid(x + 1, y, z) && solid(x - 1, y, z) && solid(x, y + 1, z) && solid(x, y - 1, z) && solid(x, y, z + 1) && (z === 0 || solid(x, y, z - 1))) continue;
      const a2 = Math.max(0, Math.min(1, 1 - (b2[i] - 0.48) * 2.4)), a4 = Math.max(0, Math.min(1, 1 - (b4[i] - 0.46) * 2.0));
      ao[i] = Math.round(Math.max(0.15, a2 * 0.6 + a4 * 0.4) * 255);
      for (let k = 0; k < 8; k++) {
        // march from the voxel's centre, starting a voxel and a half out so its own neighbours do not shade it
        let lit = 15; const dx = DX[k], dy = DY[k];
        for (let t = 1.5; t < S; t += 0.75) {
          const xx = Math.floor(x + 0.5 + dx * t), yy = Math.floor(y + 0.5 + dy * t), zz = Math.floor(z + 0.5 + se * t);
          if (zz >= n || xx < 0 || yy < 0 || xx >= w || yy >= h) break;
          if (vox[(zz * h + yy) * w + xx]) { lit = Math.round(15 * 0.6 * Math.min(1, t / S)); break; }      // nearer: darker
        }
        const j = i * 4 + (k >> 1); sh[j] = k & 1 ? (sh[j] & 0xF0) | lit : (sh[j] & 0x0F) | (lit << 4);
      }
    }
    return (def.selfBake = { el: el, ao: ao, sh: sh });
  }

  // A stack ready to draw: for each kept layer its place in the atlas and its offset from the stack's axis.
  // Slices are put in the atlas tallest first within a stack only by chance; the packing is plain rows.
  // def.res / def.zres (optional, default 1): the model is sampled that many times finer than the scene's art pixel,
  // across and upward; the engine draws it that much smaller (k, kz), so a detailed close-up model fits the scene.
  function buildStack(def, pal, atlas, shell) {
    const v = voxelise(def, pal, shell), pad = def.pad || 0;
    // the baked self-shading, laid out like each layer's pixels (when the atlas asks for it, and the model allows it)
    let bake = null; const t0 = Date.now();
    if (atlas.self0 && !def.noSelf && !def.ground) bake = bakeSelf(def, v.vox, atlas.selfElevation);
    const st = { name: def.name, def: def, k: 1 / (def.res || 1), kz: (def.res || 1) / (def.zres || def.res || 1), shell: shell, w: def.w, h: def.h, n: def.layers, pad: pad, slices: [], runs: [], radius: Math.hypot(def.w, def.h) / 2, vox: v.vox, flat: def.layers === 1 };
    // two layers are the same when they are cropped alike and every pixel (material and normal) matches
    const same = function (A, B) {
      if (A.x0 !== B.x0 || A.y0 !== B.y0 || A.w !== B.w || A.h !== B.h) return false;
      for (let y = A.y0; y < A.y0 + A.h; y++) for (let i = (y * def.w + A.x0) * 4, e = i + A.w * 4; i < e; i++) if (A.px[i] !== B.px[i]) return false;
      return true;
    };
    // Hollow slices in parts. A shell slice of a house is a thin frame round a large hole, but its quad is the
    // whole rectangle, and the rasteriser walks every pixel of it. Find the largest empty rectangle inside the
    // slice (the classic histogram method); if it is a good share of the slice, the slice becomes up to four
    // strips round the hole. Same pixels drawn, far fewer covered.
    const strips = function (L, sl) {
      const w = L.w, h = L.h, up = new Int32Array(w); let best = 0, bx = 0, by = 0, bw = 0, bh = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) up[x] = L.px[((L.y0 + y) * def.w + L.x0 + x) * 4] ? 0 : up[x] + 1;      // empty pixels above and at (x, y)
        const stack = [];
        for (let x = 0; x <= w; x++) {
          const cur = x < w ? up[x] : 0; let from = x;
          while (stack.length && stack[stack.length - 1][1] >= cur) { const t = stack.pop(), area = t[1] * (x - t[0]); if (area > best) { best = area; bx = t[0]; bw = x - t[0]; bh = t[1]; by = y - t[1] + 1; } from = t[0]; }
          stack.push([from, cur]);
        }
      }
      if (w * h < 48 || best < w * h * 0.3) return [sl];
      const parts = [], add = function (x, y, pw, ph) { if (pw > 0 && ph > 0) parts.push({ u: sl.u + x, v: sl.v + y, w: pw, h: ph, ox: sl.ox - w / 2 + x + pw / 2, oy: sl.oy - h / 2 + y + ph / 2 }); };
      add(0, 0, w, by); add(0, by + bh, w, h - by - bh); add(0, by, bx, bh); add(bx + bw, by, w - bx - bw, bh);
      return parts;
    };
    let prev = null;
    for (let z = 0; z < def.layers; z++) {
      const L = v.layers[z]; if (!L) { prev = null; continue; }
      let s0 = null, s1 = null;
      if (bake) {
        s0 = new Uint8Array(def.w * def.h * 4).fill(255); s1 = new Uint8Array(def.w * def.h * 4).fill(255);
        const W = def.w + pad * 2, H = def.h + pad * 2;
        for (let y = L.y0; y < L.y0 + L.h; y++) for (let x = L.x0; x < L.x0 + L.w; x++) {
          const j = (y * def.w + x) * 4; if (!L.px[j]) continue;
          const i = (z * H + y + pad) * W + x + pad; if (!bake.ao[i]) continue;      // (0: a voxel that is never seen)
          s0[j] = bake.ao[i]; s1[j] = bake.sh[i * 4]; s1[j + 1] = bake.sh[i * 4 + 1]; s1[j + 2] = bake.sh[i * 4 + 2]; s1[j + 3] = bake.sh[i * 4 + 3];
        }
      }
      const at = atlas.put(L.px, def.w, L.x0, L.y0, L.w, L.h, s0, s1);
      // u, v, w, h in the atlas; ox, oy: the centre of the cropped slice, measured from the axis.
      // sides: false when no pixel of the layer lies on its outline. That only happens in a ground tile (the
      // neighbouring tiles continue it): such a layer has a top but no side, and the engine draws it once.
      const sl = { z: z, n: 1, u: at[0], v: at[1], w: L.w, h: L.h, ox: L.x0 + L.w / 2 - def.w / 2, oy: L.y0 + L.h / 2 - def.h / 2, sides: L.sides };
      sl.whole = [sl]; sl.parts = shell ? strips(L, sl) : sl.whole; st.slices.push(sl);
      // Runs: layers that repeat the one under them (courses of a wall, a trunk, a pole) are one slab, up to
      // three layers tall. The engine's slab drawing uses this list instead of the slices.
      const run = st.runs[st.runs.length - 1];
      if (prev && run.n < 3 && L.sides && same(L, prev)) run.n++; else { const r = { z: z, n: 1, u: sl.u, v: sl.v, w: sl.w, h: sl.h, ox: sl.ox, oy: sl.oy, sides: sl.sides, parts: sl.parts }; r.whole = [r]; st.runs.push(r); }
      prev = L;
    }
    if (bake) atlas.bakeMs += Date.now() - t0;
    return st;
  }

  // deterministic noise for speckle, stones and leaves: hash() is white noise, noise() is smooth
  function hash(x, y, z) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(z | 0, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
  function noise(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y); let fx = x - xi, fy = y - yi; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi, seed), b = hash(xi + 1, yi, seed), c = hash(xi, yi + 1, seed), d = hash(xi + 1, yi + 1, seed);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  global.Art = { Palette: Palette, Atlas: Atlas, buildStack: buildStack, bakeSelf: bakeSelf, hash: hash, noise: noise };
})(typeof window !== 'undefined' ? window : globalThis);
