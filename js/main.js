// main.js: the demo. Builds the village, moves what moves, flies the camera, shows the numbers.
//
// Mouse: drag turns and tilts, shift-drag or right-drag pans, wheel zooms.
// Keys: R internal resolution (360, 540, 720, native), Q quality preset (low, med, high), 4 hollow slices in strips;
//       V (or 1) voxel mode (by itself, on, off), 2 impostors, 3 skip thin layers; Z build, X dismantle, C lower walls; P perspective / parallel, H hidden-surface removal, O overdraw heat map (written, covered, off), M measure,
//       L shell stacks, T thickness fill, G edge guard,
//       S shadows, A ambient occlusion, B bloom, N time of day (drifting, afternoon, golden hour, dusk),
//       Space stops and starts the slow turn, U hides the read-out.
// The same switches work in the address, for capture: ?mode=persp&hsr=1&heat=1&res=540&q=low&shell=0&fill=1&guard=1&tod=0.6
//   &yaw=..&pitch=..&dist=..&tx=..&ty=..   ?view=street   ?tour plays the camera move   ?hud=1.6 enlarges the read-out
//   ?voxel=1 / 0 forces voxel mode on / off   ?unclamped lets flat slices go below their limits, to see them fail
//   ?nohud hides it   ?hold stops the clock (demo.seek(frame))   ?voxel=1&impostors=1&lod=1 the faster ways to draw
//   ?fx=build | dismantle | lower plays one slice effect over and over, from a camera that suits it   ?follow=3&face=0 keeps soldier 3 in view, seen from the front
(function () {
  'use strict';
  const Q = new URLSearchParams(location.search), num = function (k, d) { return Q.has(k) ? parseFloat(Q.get(k)) : d; };
  const canvas = document.getElementById('c'), hud = document.getElementById('hud'), badge = document.getElementById('badge'), statsEl = document.getElementById('stats'), keysEl = document.getElementById('keys');
  const E = Engine.create(canvas), SCALE = 0.45, STEP = 1 / 60, TOUR = 1320, LOOP = TOUR / 60, TAU = Math.PI * 2;
  const WORLD = Scene.WORLD, G = WORLD.ground;

  // ---------------------------------------------------------------- art: every stack twice, whole and as a shell
  const pal = Scene.palette(), DEFS = Scene.stacks(), SETS = [];
  [0, 3].forEach(function (shell) {                            // 0: whole stacks. 3: only the pixels within 3 of the surface
    const atlas = new Art.Atlas(2048), stacks = {}, chars = {};
    DEFS.forEach(function (d) { stacks[d.name] = Art.buildStack(d, pal, atlas, shell); });
    Object.keys(Characters).forEach(function (c) { chars[c] = {}; Characters[c].parts.forEach(function (d) { chars[c][d.name] = Art.buildStack(d, pal, atlas, shell); }); });
    SETS.push({ stacks: stacks, chars: chars, atlas: E.makeAtlas(atlas.data, atlas.size), pixels: atlas.used });
  });
  // ?rows=1: a second palette row, every colour washed most of the way to white and shining a little: the flash
  // that runs through the ?bots flocks
  if (Q.has('rows')) { const b = pal.bytes(), two = new Uint8Array(b.length * 2); two.set(b); for (let i = 0; i < 256; i++) { const o = b.length + i * 4; for (let c = 0; c < 3; c++) two[o + c] = Math.round(b[i * 4 + c] * 0.3 + 255 * 0.7); two[o + 3] = 140; } E.setPalette(two, 2); }
  else E.setPalette(pal.bytes());
  // ?unit=0.1: the same scene in other world units (every position, size and the camera times 0.1, opt.unit 0.1):
  // a test that the light pass is free of art-pixel numbers. It should look the same.
  const UNIT = Q.has('unit') ? parseFloat(Q.get('unit')) || 1 : 1;
  // ?night=1: the village by a low moon, through the night light model, with the film post (tone curve, grade,
  // tilt-shift depth of field, grain)
  const NIGHT = Q.has('night'), mEl = 0.42, mAz = Math.atan2(-0.6, 0.8);
  const NIGHT_LIGHT = { model: 'night', moon: [Math.cos(mEl) * Math.cos(mAz), Math.cos(mEl) * Math.sin(mAz), Math.sin(mEl)], moonCol: [0.92, 1.12, 1.55], skyCol: [0.075, 0.115, 0.19],
    earthCol: [0.035, 0.032, 0.03], fogCol: [0.032, 0.052, 0.088], fog: [0.0025, 0.03, 0.08], emissive: 3.5, fogNear: 120, rim: 0.9, rimWarm: 0.05, floorCol: [0.07, 0.065, 0.05] };
  // the optional builds of the shaders this page will use, made now rather than on the first frame that needs each
  // (?nowarm=1 leaves them to be made when first needed, to measure the hitch that saves)
  if (!Q.has('nowarm')) E.warm({ night: NIGHT, cones: num('cones', 0) > 0, rings: num('rings', 0) > 0, rows: Q.has('rows'), groundMap: Q.has('groundmap'), lightMap: Q.has('lightmap'), hdr: Q.has('hdr') });
  // ?groundmap=1: the country round the map from a ground map (a 4-unit cell, two palette indices and a wear): the
  // road carried on past both edges as worn ruts, fields of pasture and plough, and a few old shell scorches,
  // in the village's own colours. The map itself is drawn by its tiles; the ground map shows past its edge.
  // ?lightmap=1: the street lamps on the road's poles as a light map (warm pools, one read for all of them); it
  // follows the time of day, off by day and up at dusk.
  if (Q.has('groundmap')) {
    const gw = 384, gh = 288, g = new Uint8Array(gw * gh * 4), N = pal.names, x0 = -512, y0 = -384, cs = 4;
    const crater = [[-60, 120, 11], [580, 230, 14], [200, -50, 9], [-120, 300, 12], [620, 60, 10]];
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const o = (j * gw + i) * 4, x = x0 + (i + 0.5) * cs, y = y0 + (j + 0.5) * cs;
      const fx = Math.floor((x + 40 * Art.noise(x / 160, y / 160, 5)) / 118), fy = Math.floor((y + 40 * Art.noise(x / 160, y / 160, 6)) / 118), lot = Art.hash(fx, fy, 7);
      let A = lot < 0.4 ? N.pasture : lot < 0.62 ? N.grass2 : lot < 0.8 ? N.grass : N.dirt2, B = lot < 0.62 ? N.grassDry : N.earth, wear = Art.noise(x / 37, y / 37, 8) * 120;
      const dr = Math.abs(y - Scene.roadY(x));
      if (dr < 7) { A = N.dirt; B = N.rut; wear = Math.abs(dr - 3.4) < 1 ? 230 : 60; }
      else if (dr < 9) { A = N.grassDry; B = N.dirt; wear = 120; }
      crater.forEach(function (c) { const d = Math.hypot(x - c[0], y - c[1]); if (d < c[2]) { A = N.earth; B = N.scorch; wear = 255 * (1 - d / c[2]); } else if (d < c[2] * 1.8) { B = N.scorch; wear = Math.max(wear, 140 * (1 - (d - c[2]) / (c[2] * 0.8))); } });
      g[o] = A; g[o + 1] = B; g[o + 2] = Math.max(0, Math.min(255, Math.round(wear))); g[o + 3] = 255;
    }
    E.setGroundMap(g, gw, gh, [x0 * UNIT, y0 * UNIT, gw * cs * UNIT, gh * cs * UNIT]);
  }
  if (Q.has('lightmap')) {
    const lw = 256, lh = 192, l = new Uint8Array(lw * lh * 4), poles = [];
    for (let x = 30; x < Scene.WORLD.w; x += 68) poles.push([x, Scene.roadY(x) - 13]);      // where the scene puts its poles
    for (let j = 0; j < lh; j++) for (let i = 0; i < lw; i++) {
      const o = (j * lw + i) * 4, x = (i + 0.5) * 2, y = (j + 0.5) * 2; let k = 0;
      poles.forEach(function (p) { const d = Math.hypot(x - p[0], y - p[1]) / 34; if (d < 1) k += (1 - d) * (1 - d); });
      k = Math.min(1, k); l[o] = Math.round(255 * k); l[o + 1] = Math.round(190 * k); l[o + 2] = Math.round(110 * k); l[o + 3] = 255;
    }
    E.setLightMap(l, lw, lh, [0, 0, 512 * UNIT, 384 * UNIT], 1);
  }

  const LAYOUT = Scene.layout();
  const statics = SETS.map(function (S) { return LAYOUT.map(function (l) { const it = Engine.item(S.stacks[l.n], l.x, l.y, l.z, l.rot, l.scale); it.sway = l.sway; it.sprite = false; return it; }); });
  // Stacks that stand in many places and never change (trees, tufts, graves, poles) can be drawn as impostors.
  const often = {}; LAYOUT.forEach(function (l) { often[l.n] = (often[l.n] || 0) + 1; });
  const IMPOSTORS = SETS.map(function (S) { return DEFS.filter(function (d) { return often[d.name] >= 5 && !d.ground && !d.wheat; }).map(function (d) { return S.stacks[d.name]; }); });
  statics.forEach(function (st, i) { st.forEach(function (it) { it.sprite = IMPOSTORS[i].indexOf(it.stack) >= 0; }); });
  const swayers = statics.map(function (st) { return st.filter(function (it) { return it.sway; }); });

  // The slice effects (further down) change single stacks: these are the ones they can touch.
  const DYN = [];
  ['build', 'dismantle', 'lower'].forEach(function (kind) {
    Scene.EFFECTS[kind].forEach(function (e) { let k = 0; for (let i = 0; i < LAYOUT.length; i++) if (LAYOUT[i].n === e[0] && k++ === e[1]) DYN.push({ i: i, kind: kind, arg: e[2], cols: [], layers: 999, amount: 0 }); });
  });

  // The height map for shadows and occlusion: the tallest solid thing over every ground cell. The land comes
  // straight from the scene's survey; every standing stack then stamps its own outline on it. The stacks an
  // effect can change keep their columns, so the map can follow them: a wall that comes down stops casting.
  const HM = (function () {
    const W = WORLD.w, H = WORLD.h, base = new Uint8Array(W * H), hm = new Uint8Array(W * H), land = Scene.survey().hgt;
    for (let i = 0; i < W * H; i++) base[i] = land[i] * 2;
    statics[0].forEach(function (it, index) {
      const st = it.stack, d = st.def; if (d.ground || d.noShadow) return;
      const c = Math.cos(it.rot), s = Math.sin(it.rot), dyn = DYN.filter(function (e) { return e.i === index; })[0];
      if (dyn) { dyn.x0 = W; dyn.y0 = H; dyn.x1 = 0; dyn.y1 = 0; dyn.z = it.z; dyn.scale = it.scale; dyn.st = st; }
      for (let y = 0; y < st.h; y++) for (let x = 0; x < st.w; x++) {
        const lx = x + 0.5 - st.w / 2, ly = y + 0.5 - st.h / 2;
        let z = st.n - 1; while (z >= 0 && !(st.vox[(z * st.h + y) * st.w + x] && (!d.shadowIf || d.shadowIf(lx, ly, z)))) z--;      // the top of this column
        if (z < 0) continue;
        const wx = it.x + (lx * c - ly * s) * it.scale, wy = it.y + (lx * s + ly * c) * it.scale, v = Math.min(255, Math.round((it.z + (z + 1) * it.scale) * 2));
        for (let k = 0; k < 4; k++) {                          // a turned or enlarged stack would leave holes: stamp four cells
          const cx = Math.floor(wx + (k & 1) * 0.6 - 0.3), cy = Math.floor(wy + (k >> 1) * 0.6 - 0.3);
          if (cx <= 0 || cy <= 0 || cx >= W - 1 || cy >= H - 1) continue;
          if (dyn) { dyn.cols.push(cy * W + cx, y * st.w + x, z + 1); dyn.x0 = Math.min(dyn.x0, cx); dyn.x1 = Math.max(dyn.x1, cx); dyn.y0 = Math.min(dyn.y0, cy); dyn.y1 = Math.max(dyn.y1, cy); }
          else if (v > base[cy * W + cx]) base[cy * W + cx] = v;
        }
      }
    });
    // write one changeable stack into the map, no taller than `layers`, and send that part of the map to the engine
    function stamp(d, layers, send) {
      if (!d.cols.length) return;
      for (let y = d.y0; y <= d.y1; y++) for (let x = d.x0; x <= d.x1; x++) hm[y * W + x] = base[y * W + x];
      const vox = d.st.vox, wh = d.st.w * d.st.h;
      for (let k = 0; k < d.cols.length; k += 3) {             // each column: its highest pixel under the cut (a hollow house has a floor there, not a block)
        let z = Math.min(d.cols[k + 2], layers) - 1; while (z >= 0 && !vox[z * wh + d.cols[k + 1]]) z--;
        const v = Math.min(255, Math.round((d.z + (z + 1) * d.scale) * 2)); if (z >= 0 && v > hm[d.cols[k]]) hm[d.cols[k]] = v;
      }
      d.layers = layers; if (!send) return;
      const w = d.x1 - d.x0 + 1, h = d.y1 - d.y0 + 1, part = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) part.set(hm.subarray((d.y0 + y) * W + d.x0, (d.y0 + y) * W + d.x0 + w), y * w);
      E.patchHeightMap(part, d.x0, d.y0, w, h);
    }
    hm.set(base); DYN.forEach(function (d) { stamp(d, 999, false); });
    E.setHeightMap(hm, W, H, UNIT !== 1 ? [0, 0, W * UNIT, H * UNIT] : null, UNIT !== 1 ? 0.5 * UNIT : null);
    return { stamp: stamp };
  })();

  // ---------------------------------------------------------------- routes
  // A smooth curve through a list of points (Catmull-Rom), walked at a steady pace: at(s) -> [x, y, heading].
  function route(pts, closed) {
    const P = [], n = pts.length, get = function (i) { return closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]; };
    for (let i = 0; i < (closed ? n : n - 1); i++) for (let k = 0; k < 12; k++) {
      const t = k / 12, a = get(i - 1), b = get(i), c = get(i + 1), d = get(i + 2), f = function (j) { return 0.5 * (2 * b[j] + (c[j] - a[j]) * t + (2 * a[j] - 5 * b[j] + 4 * c[j] - d[j]) * t * t + (3 * b[j] - a[j] - 3 * c[j] + d[j]) * t * t * t); };
      P.push([f(0), f(1)]);
    }
    P.push(closed ? P[0] : pts[n - 1]);
    const L = [0]; for (let i = 1; i < P.length; i++) L.push(L[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]));
    const total = L[L.length - 1];
    return { length: total, at: function (s) {
      s = closed ? ((s % total) + total) % total : Math.max(0, Math.min(total - 0.001, s));
      let lo = 0, hi = L.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (L[m] <= s) lo = m; else hi = m; }
      const t = (s - L[lo]) / (L[hi] - L[lo] || 1), a = P[lo], b = P[hi];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, Math.atan2(b[1] - a[1], b[0] - a[0])];
    } };
  }

  // ---------------------------------------------------------------- the patrols (the only things with memory: a rig per man)
  const C = Characters.soldier;
  let walkers = [], simFrame = -1;
  function resetSim() {
    walkers = [];
    Scene.PATROLS.forEach(function (p) {
      const r = route(p.pts, true);
      for (let i = 0; i < p.men; i++) { const k = { path: r, s: r.length * 0.3 - i * (p.gap || 0), rig: Rig.createWalker(C.rig), speed: C.rig.stride / 0.95 * SCALE }; const q = r.at(k.s); Rig.place(k.rig, q[0] / SCALE, q[1] / SCALE, q[2]); walkers.push(k); }
    });
    simFrame = -120;                                          // two seconds of walking before frame 0
  }
  function simTo(f) {
    if (f < simFrame || simFrame === -1) resetSim();
    for (; simFrame < f; simFrame++) walkers.forEach(function (k) { k.s += k.speed * STEP; const q = k.path.at(k.s); Rig.step(k.rig, q[0] / SCALE, q[1] / SCALE, q[2], STEP); });
  }

  // ---------------------------------------------------------------- state
  const VIEWS = {
    overview: { mode: 'ortho', tx: 256, ty: 192, yaw: 0.62, pitch: 0.72, dist: 450 },
    street: { mode: 'persp', tx: 262, ty: 194, yaw: 0.3, pitch: 0.44, dist: 158 },
    village: { mode: 'ortho', tx: 300, ty: 190, yaw: 0.62, pitch: 0.66, dist: 280 },
    bridge: { mode: 'persp', tx: 150, ty: 198, yaw: 2.6, pitch: 0.5, dist: 170 },
    top: { mode: 'ortho', tx: 256, ty: 192, yaw: Math.PI / 2, pitch: 1.5, dist: 620 },
    low: { mode: 'ortho', tx: 256, ty: 192, yaw: 0.62, pitch: 0.2, dist: 500 },
    level: { mode: 'persp', tx: 250, ty: 189, tz: 10, yaw: 0.02, pitch: 0.14, dist: 110 }      // nearly along the ground: only voxel mode holds here
  };
  VIEWS.build = { mode: 'persp', tx: 378, ty: 156, yaw: 1.9, pitch: 0.62, dist: 150 }; VIEWS.dismantle = { mode: 'persp', tx: 240, ty: 122, yaw: 0.5, pitch: 0.66, dist: 170 }; VIEWS.lower = { mode: 'persp', tx: 270, ty: 76, yaw: -2.2, pitch: 0.74, dist: 140 };
  VIEWS.far = { mode: 'ortho', tx: 256, ty: 192, yaw: 0.62, pitch: 0.72, dist: 1100 };
  const v0 = VIEWS[Q.get('view') || Q.get('fx') || 'overview'] || VIEWS.overview;
  const cam = { tz: v0.tz || 0, mode: Q.get('mode') || v0.mode, tx: num('tx', v0.tx), ty: num('ty', v0.ty), yaw: num('yaw', v0.yaw), pitch: num('pitch', v0.pitch), dist: num('dist', v0.dist), fov: 40 * Math.PI / 180 };
  const TOURING = Q.has('tour'), HELD = Q.has('hold'), FOLLOW = num('follow', -1);
  // Resolution and quality. The picture is drawn small and shown large, each internal pixel a clean square: that
  // is how pixel art is meant to be seen, and the cost of a frame goes with the number of pixels drawn.
  //   ?res=360 | 540 | 720 | native   the internal height asked for (the default is 360; R steps through them)
  //   ?q=low | med | high             a preset (Q steps through them): low is 360 in voxel mode with no bloom, a
  //                                   shorter shadow walk, fewer occlusion samples and thin layers skipped; med
  //                                   is 540 with everything on, and voxel mode whenever the camera is in
  //                                   perspective (street level, where it cuts the fill most); high is native
  //                                   with everything on. The badge shows whenever voxel mode is drawing.
  // A preset only fills in what the address does not set itself.
  const PRESETS = { low: { res: 360, bloom: 0, cheap: 1, lod: 1, voxel: 1 }, med: { res: 540, bloom: 1, cheap: 0, lod: 0, voxel: 2 }, high: { res: 0, bloom: 1, cheap: 0, lod: 0, voxel: -1 } };
  const preset = PRESETS[Q.get('q')] || { res: 360, bloom: 1, cheap: 0, lod: 0, voxel: -1 };
  const height = function (v) { return v === 'native' || v === '0' ? 0 : parseInt(v, 10) || 360; };
  // tod: the time of day, 0 afternoon to 1 dusk; -1 lets it drift by itself (the live page does; a held page stays put)
  const NIGHTQ = Q.has('night');
  const S = { q: PRESETS[Q.get('q')] ? Q.get('q') : '', cheap: num('cheap', preset.cheap) === 1, split: num('split', 0) === 1,
    hsr: num('hsr', 1) === 1, heat: num('heat', 0), res: Q.has('res') ? height(Q.get('res')) : preset.res, shell: num('shell', 1) === 1, fill: num('fill', 1) === 1, guard: num('guard', 1) === 1,
    voxel: num('voxel', preset.voxel), unclamped: Q.has('unclamped'), impostors: num('impostors', 0) === 1, lod: num('lod', preset.lod) === 1, shadows: num('shadows', 1) === 1, ao: num('ao', 1) === 1, bloom: num('bloom', preset.bloom) === 1, tod: num('tod', NIGHTQ ? 1 : HELD || TOURING ? 0.25 : -1), measure: num('measure', 0) === 1, orbit: !HELD && !TOURING && !Q.has('yaw') };
  let list = [], sprites = [], sheet = null, blobs = [], lamps = [], frame = 0, env = Scene.light(0), scale = 1;

  // ---------------------------------------------------------------- lights and hordes (off unless asked for)
  //   ?horde=N    a convoy of N vehicles (up to 9, all the road holds) along the road at a steady speed and a safe gap
  //   ?lights=N   N point lights on them, two a vehicle: a warm lamp ahead, a dim red tail light behind
  //   ?cones=N    headlamps on the first N of them (up to 16): a pool and a beam each, cut by trees and buildings
  //   ?bots=N     N birds (up to 600) in a few flocks wheeling over the fields, drawn from typed arrays (opt.horde:
  //               no object per bird); with ?rows=1 a flash runs out through each flock now and then (a palette row)
  // e.g. ?horde=9&lights=18&cones=9&tod=1 (a convoy at dusk), ?bots=400&rows=1.
  //   ?stress=1   the raw cases bench.py measures instead: ?horde in rows over the whole map (thousands, with no
  //               regard for the village), ?bots spread evenly over it, ?botsobj=1 the same through the item pool.
  //               They are for measuring, not for looking at.
  const STRESS = Q.has('stress');
  const BOTS = Math.max(0, Math.min(STRESS ? 1e5 : 600, num('bots', 0) | 0)), BOTSOBJ = num('botsobj', 0) === 1;
  const bot = { lift: true, frames: null, n: BOTS, x: new Float32Array(BOTS), y: new Float32Array(BOTS), z: new Float32Array(BOTS), rot: new Float32Array(BOTS), frame: new Uint8Array(BOTS), fade: null, row: Q.has('rows') ? new Uint8Array(BOTS) : null, scale: STRESS ? 1 : 0.8 }, flock = [bot];
  const FLOCKS = [[150, 270, 60, 26, 1], [380, 90, 55, 34, -1], [420, 280, 48, 30, 1], [90, 110, 50, 38, -1]];      // x, y, radius, height over the ground, turn
  function bots(t, set) {
    if (!bot.frames) bot.frames = ['bird0', 'bird1', 'bird2', 'bird1'].map(function (k) { return set.stacks[k]; });
    const W = Scene.WORLD.w - 40, H = Scene.WORLD.h - 40;
    for (let i = 0; i < BOTS; i++) {
      let x, y, z, rot;
      if (STRESS) {                                            // evenly over the map
        const v = 10 + (i % 7) * 1.5, dir = i & 1 ? -1 : 1; x = 20 + ((((i * 37.3 + dir * t * v) % W) + W) % W); y = 20 + (i * 0.618034 * H) % H + Math.sin(t * 1.3 + i) * 4;
        z = Scene.groundAt(x, y) + 4 + (i % 5); rot = dir > 0 ? 0 : Math.PI; bot.frame[i] = (Math.floor(t * 10 + i) & 3);
      } else {                                                 // a flock: each bird on its own circle round the flock's centre, which drifts
        const F = FLOCKS[i % FLOCKS.length], j = (i / FLOCKS.length) | 0, h1 = Art.hash(i, 1, 9), h2 = Art.hash(i, 2, 9), h3 = Art.hash(i, 3, 9);
        const cx = F[0] + 30 * Math.sin(t * 0.11 + F[1]), cy = F[1] + 24 * Math.cos(t * 0.09 + F[0]), r = F[2] * (0.35 + 0.65 * Math.sqrt(h1)), a = F[4] * t * (0.42 + 0.1 * h2) + h3 * 6.2832 + j * 0.0;
        x = cx + Math.cos(a) * r; y = cy + Math.sin(a) * r * 0.8; z = Scene.groundAt(cx, cy) + F[3] + 10 * h2 + 3 * Math.sin(t * 1.7 + i);
        rot = a + F[4] * Math.PI / 2; bot.frame[i] = Math.sin(t * 0.6 + h1 * 9) > 0.55 ? 1 : (Math.floor(t * 9 + h3 * 4) & 3);      // now and then a glide
        // the flash: a ring that runs out from the flock's centre every few seconds
        if (bot.row) { const w = ((t * 0.35 + F[0] * 0.01) % 1) * F[2] * 1.4; bot.row[i] = Math.abs(Math.hypot(x - cx, (y - cy) / 0.8) - w) < 4 ? 1 : 0; }
      }
      bot.x[i] = x; bot.y[i] = y; bot.z[i] = z; bot.rot[i] = rot;
      if (BOTSOBJ) { const it = pool.add(bot.frames[bot.frame[i]], x, y, z, rot, bot.scale); it.row = bot.row ? bot.row[i] : 0; it.lift = true; }
    }
  }
  //   ?rings=N    N pulse rings (up to 8), each growing from a point to 140 units in 2.5 s and starting again: a band
  //               of cold light on the ground that lifts the birds and vehicles it passes under
  const NRINGS = Math.max(0, Math.min(8, num('rings', 0) | 0)), rings = [];
  function pulses(t) {
    rings.length = 0;
    for (let i = 0; i < NRINGS; i++) {
      const u = ((t / 2.5 + i * 0.37) % 1), cx = 140 + (i * 97) % 260, cy = 110 + (i * 61) % 170, k = 1 - u;
      rings.push([cx, cy, Scene.groundAt(cx, cy), 4 + u * 140, 5 + u * 4, 0.6 * k * 2.2, 1.4 * k * 2.2, 2.2 * k * 2.2, 0.9 * k, 6 * k]);
    }
  }
  const HORDE = Math.max(0, Math.min(STRESS ? 1e5 : 9, num('horde', 0) | 0)), NLIGHTS = Math.max(0, num('lights', 0) | 0), NCONES = Math.max(0, num('cones', 0) | 0);
  const pool = Engine.itemPool(), cones = [];
  let blockers = null;
  function horde(t, set) {
    cones.length = 0;
    if (NCONES && !blockers && num('coneshadows', 1)) blockers = statics[0].filter(function (it) { return !it.stack.def.ground && it.stack.n > 12; }).map(function (it) { return [it.x, it.y, it.stack.radius * it.scale * 0.45, it.z + it.stack.n * it.scale]; });
    if (STRESS) {                                              // the bench's case: rows over the whole map, a light and a lamp spread through them
      const W = Scene.WORLD.w - 40, rows = Math.max(1, Math.ceil(HORDE / 60)), lstep = Math.max(1, Math.floor(HORDE / Math.max(1, NLIGHTS))), cstep = Math.max(1, Math.floor(HORDE / Math.max(1, NCONES)));
      for (let i = 0; i < HORDE; i++) {
        const r = i % rows, k = (i / rows) | 0, dir = r & 1 ? -1 : 1, y = 24 + (r + 0.5) * (Scene.WORLD.h - 48) / rows;
        const x = 20 + ((((k * W / 60 + dir * t * 9) % W) + W) % W), h = dir > 0 ? 0 : Math.PI, z = Scene.groundAt(x, y);
        const it = pool.add(set.stacks[i % 3 ? 'jeep' : 'halftrack'], x, y, z, h);
        it.fade = Math.max(0, 1 - Math.min(x - 20, W + 20 - x) / 12); it.lift = true;
        if (i % lstep === 0 && i / lstep < NLIGHTS) lamps.push([x + dir * 6, y, z + 8, 42, 1.6, 1.05, 0.55, i < 8 * lstep ? 1 : 0, 0.6]);
        if (i % cstep === 0 && i / cstep < NCONES) cones.push([x + dir * 4, y, z + 14, 150, dir, 0, -0.55, 0.42, 1.5, 1.4, 1.1, 1.2]);
      }
      return;
    }
    // THE CONVOY: nose to tail along the road (one lane: the road is one vehicle wide), a safe gap between them, at
    // a walking pace; they come in and go out past the edges of the map, fading, and follow the road's bends
    const span = Scene.WORLD.w + 120, gap = 66;
    for (let i = 0; i < HORDE; i++) {
      const x = ((((i * gap + t * 11) % span) + span) % span) - 60, y = Scene.roadY(x), ang = Math.atan2(Scene.roadY(x + 1) - y, 1), z = Scene.groundAt(x, y);
      const kind = i % 4 === 1 ? 'halftrack' : 'jeep', it = pool.add(set.stacks[kind], x, y, z, ang), e = Math.min(x, Scene.WORLD.w - x);
      it.fade = Math.max(0, Math.min(1, -e / 30)); it.lift = true;
      const c = Math.cos(ang), sn = Math.sin(ang), len = kind === 'jeep' ? 15 : 25;
      // two lights each while they last: a warm lamp ahead, a dim red tail light behind
      if (2 * i < NLIGHTS) lamps.push([x + c * (len + 4), y + sn * (len + 4), z + 5, 30, 1.25, 0.95, 0.6, i < 4 ? 1 : 0, 0.35]);
      if (2 * i + 1 < NLIGHTS) lamps.push([x - c * (len + 2), y - sn * (len + 2), z + 4, 12, 0.9, 0.12, 0.08, 0, 0.5]);
      if (i < Math.min(16, NCONES)) cones.push([x + c * len, y + sn * len, z + 6, 90, c, sn, -0.22, 0.34, 1.05, 0.98, 0.82, 0.35]);
    }
  }
  // ---------------------------------------------------------------- voxel mode: when
  // Flat slices stay solid while two things hold (both measured: see "Voxel mode" in the README).
  //  - The tilt is at least VOXEL_TILT. Below it a slice is nearly edge-on, and thin parts (a soldier's limbs, a
  //    pole, a fence rail) come apart first. In perspective the lowest ray on screen is what counts, and height
  //    order also stops being depth order once a ray no longer points down.
  //  - No layer is taller on screen than the fill will cover (48 rows): closer than that, gaps open between copies.
  // S.voxel: -1 the engine decides, 1 always, 0 never, 2 always with the perspective camera (the med preset). With voxel mode allowed the camera may go down to the horizon.
  const VOXEL_TILT = 15 * Math.PI / 180, VOXEL_MARGIN = 4 * Math.PI / 180, VOXEL_ROWS = 48;
  let voxel = false, rowsSeen = 0;
  function tiltLimit() { return cam.mode === 'persp' ? cam.fov / 2 + VOXEL_MARGIN : VOXEL_TILT; }      // perspective: the highest ray on screen must still come down, with a little to spare
  function needVoxel() { return cam.pitch < tiltLimit() || rowsSeen > VOXEL_ROWS; }
  function clampCam() {
    // without voxel mode: in perspective every view ray must still point downward (height order is depth order only then)
    const lowest = S.voxel !== 0 || S.unclamped ? 0.03 : cam.mode === 'persp' ? cam.fov / 2 + 0.06 : 0.1;
    cam.pitch = Math.max(lowest, Math.min(Math.PI / 2 - 0.001, cam.pitch)); cam.dist = Math.max(16, Math.min(1100, cam.dist));
    voxel = S.voxel === 1 || (S.voxel === 2 && cam.mode === 'persp') || ((S.voxel < 0 || S.voxel === 2) && needVoxel());
  }
  // The film: six shots with cuts between them, 22 seconds. Two in the parallel view, turning over the whole map:
  // first the picture, then the same picture as a heat map of fragments written (whole stacks, shell stacks,
  // hidden-surface removal). Then four in perspective as the afternoon turns to dusk: the bridge, the village,
  // the farm (where the slice effects play: a cottage goes up, the barn's roof is blown off, the farmhouse's
  // walls come down), and the wreck. [start, end (seconds), camera, from and to: tx, ty, yaw, pitch, dist, time of day]
  const SHOTS = [
    [0, 4, 'ortho', [256, 192, 0.62, 0.72, 470, 0.04], [262, 192, 1.32, 0.68, 400, 0.12]],
    [4, 7.5, 'ortho', [262, 192, 1.32, 0.68, 400, 0.12], [262, 192, 1.95, 0.7, 430, 0.2]],
    [7.5, 10.5, 'persp', [172, 200, 3.62, 0.55, 218, 0.3], [182, 200, 3.44, 0.52, 196, 0.42]],
    [10.5, 13.5, 'persp', [322, 208, 0.74, 0.58, 212, 0.5], [326, 212, 1.04, 0.54, 194, 0.6]],
    [13.5, 19, 'persp', [306, 112, -1.42, 0.66, 262, 0.6], [298, 106, -1.7, 0.62, 236, 0.82]],
    [19, 22, 'persp', [106, 190, 0.8, 0.53, 204, 0.92], [120, 194, 0.68, 0.49, 178, 1]]
  ];
  function tour(f) {
    const u = (f % TOUR) / 60; let k = 0; while (k < SHOTS.length - 1 && u >= SHOTS[k][1]) k++;
    const sh = SHOTS[k], t = (u - sh[0]) / (sh[1] - sh[0]), e = t * 0.6 + t * t * (3 - 2 * t) * 0.4, v = function (i) { return sh[3][i] + (sh[4][i] - sh[3][i]) * e; };      // mostly steady, a little eased
    cam.mode = sh[2]; cam.tx = v(0); cam.ty = v(1); cam.yaw = v(2); cam.pitch = v(3); cam.dist = v(4); S.tod = v(5);
    const heat = k === 1;
    S.heat = heat ? 1 : 0; S.measure = true; S.shell = !(heat && t < 0.33); S.hsr = !(heat && t < 0.66);
  }

  // ---------------------------------------------------------------- slice effects
  // What a stack of slices can do that a mesh cannot do as simply: every slice is its own thing, so an object can
  // be put together, taken apart, or cut off at any height, one slice at a time. Each effect is a small function
  // the engine calls per slice (the item's `each`): it moves the slice, or returns null to leave it out.
  //   build      slices drop in from above, the lowest first, each turning a little as it settles
  //   dismantle  slices fly off the top one after another, spin, shrink and are gone (and come back the same way)
  //   lower      every slice above a height is left out, and the height slides: walls come down, the room shows
  // FX holds where each effect is: seconds into a build (or -1), 0..1 of a dismantling, 0..1 lowered per building.
  const FX = { build: -1, dismantle: 0, lowered: {}, on: false, tb: -99, td: -99, mode: Q.get('fx') };
  const still = function (out) { out.dx = 0; out.dy = 0; out.dz = 0; out.rot = 0; out.scale = 1; return out; };
  const ease = function (x) { x = Math.max(0, Math.min(1, x)); return x * x * (3 - 2 * x); };
  DYN.forEach(function (d) {
    if (d.kind === 'build') d.each = function (z, n, out) {
      const u = (FX.build - d.arg) / 2, l = (u - z / n * 0.75) / 0.25; if (l <= 0) return null;
      const e = l >= 1 ? 0 : Math.pow(1 - l, 3); still(out); out.dz = e * 46; out.rot = e * 0.7 * (z & 1 ? 1 : -1); return out;
    };
    if (d.kind === 'dismantle') d.each = function (z, n, out) {
      still(out); if (z < d.arg) return out;
      const l = (FX.dismantle - (n - 1 - z) / (n - d.arg) * 0.6) / 0.4; if (l <= 0) return out; if (l >= 1) return null;
      const a = Art.hash(z, 3, 7) * 2.4 - 0.2, far = l * (26 + 30 * Art.hash(z, 5, 7));
      out.dx = Math.cos(a) * far; out.dy = Math.sin(a) * far; out.dz = 34 * l - 30 * l * l; out.rot = l * 3.5 * (z & 1 ? 1 : -1); out.scale = 1 - l * l * 0.9; return out;
    };
    if (d.kind === 'lower') d.each = function (z, n, out) { return z >= n - (FX.lowered[d.i] || 0) * (n - d.arg) ? null : still(out); };
  });
  function effects(t) {
    if (TOURING) {                                             // on the film's schedule
      const u = t % LOOP; FX.build = u >= 7.6 && u < 10.5 ? u - 7.6 : u >= 13.7 && u < 19 ? u - 13.7 : -1;
      FX.dismantle = u < 15.8 ? 0 : Math.min(1, (u - 15.8) / 1.8);
      DYN.forEach(function (d) { if (d.kind === 'lower') FX.lowered[d.i] = d.arg === 10 ? ease((u - 17.1) / 0.8) - ease((u - 18.5) / 0.5) : 0; });
    } else if (FX.mode) {                                      // one effect over and over, for a small film of it
      const u = t % 4; FX.build = FX.mode === 'build' ? u : -1; FX.dismantle = FX.mode === 'dismantle' ? ease(u / 1.6) - ease((u - 2.6) / 1.2) : 0;
      DYN.forEach(function (d) { if (d.kind === 'lower') FX.lowered[d.i] = FX.mode === 'lower' ? ease((u - 0.4) / 0.9) - ease((u - 2.8) / 0.9) : 0; });
    } else {                                                   // from the keys
      FX.build = t - FX.tb < 4.2 && t >= FX.tb ? t - FX.tb : -1; const a = t - FX.td; FX.dismantle = a < 0 || a > 7 ? 0 : ease(a / 2) - ease((a - 5) / 2);
      // walls come down only on the buildings near the point the camera looks at
      DYN.forEach(function (d) { if (d.kind !== 'lower') return; const L = LAYOUT[d.i], want = FX.on && Math.hypot(L.x - cam.tx, L.y - cam.ty) < 125 ? 1 : 0, now = FX.lowered[d.i] || 0; FX.lowered[d.i] = HELD ? want : now + Math.max(-0.035, Math.min(0.035, want - now)); });
    }
    // hand each stack its function while its effect runs (and the plain stack back when it does not), and let the height map follow
    DYN.forEach(function (d) {
      const st = statics[0][d.i].stack; let active, layers = 999;
      if (d.kind === 'build') { const u = (FX.build - d.arg) / 2; active = FX.build >= 0 && u < 1.02; if (active) layers = Math.max(0, Math.floor((u - 0.25) / 0.75 * st.n)); }
      else if (d.kind === 'dismantle') { active = FX.dismantle > 0; if (active) layers = Math.round(Math.min(st.n, st.n - 1 - (FX.dismantle - 0.4) / 0.6 * (st.n - d.arg))); }
      else { const k = FX.lowered[d.i] || 0; active = k > 0.001; if (active) layers = Math.round(st.n - k * (st.n - d.arg)); }
      statics[0][d.i].each = statics[1][d.i].each = active ? d.each : null;
      if (layers !== d.layers) HM.stamp(d, layers, true);
    });
  }

  // Everything that moves without memory is a function of the time alone, so any frame can be asked for by number.
  function animate(t, set) {
    const push = function (name, x, y, z, rot, scale) { list.push(Engine.item(set.stacks[name], x, y, z, rot, scale || 1)); };      // (Engine.item: one shape for every item)
    const wind = [-0.98, 0.17];
    // trees, grass and wheat lean with the wind: a slow wave that crosses the map
    const sw = swayers[S.shell ? 1 : 0];
    for (let i = 0; i < sw.length; i++) { const it = sw[i], ph = t * (it.sway > 0.1 ? 2.4 : 1.5) - it.x * 0.045 - it.y * 0.026, a = it.sway * (0.35 + Math.sin(ph) + 0.4 * Math.sin(ph * 2.3 + it.x)); it.shx = a * wind[0]; it.shy = a * wind[1]; }
    // the tank's turret traverses slowly, watching the bridge
    const T = Scene.TANK, ta = T.rot + 0.5 * Math.sin(t * TAU / LOOP) + 0.1 * Math.sin(t * TAU * 3 / LOOP + 1), tz = Scene.groundAt(T.x, T.y) + 11, txp = T.x + Math.cos(T.rot) * 1.5, typ = T.y + Math.sin(T.rot) * 1.5;
    push('tankTurret', txp, typ, tz, ta); blobs.push([txp, typ, tz + 7, 9.5, tz - 1]);
    // the jeep runs the road from one side of the map to the other, once every loop of the film, with dust behind it
    const J = Scene.JEEP, jeepAt = function (time) { const x = J.from + (((time + 17.8) % LOOP) + LOOP) % LOOP * J.speed, y = Scene.roadY(x); return x > J.to ? null : [x, y, Math.atan(9 * 0.012 * Math.cos(x * 0.012 + 1)), Scene.groundAt(x, y)]; };
    const j = jeepAt(t);
    if (j && !HORDE) {                                       // (off while the ?horde convoy has the road)
      push('jeep', j[0], j[1], j[3] + 0.3 * Math.abs(Math.sin(j[0] * 0.33)), j[2]);
      for (let k = -1; k <= 1; k += 2) blobs.push([j[0] + Math.cos(j[2]) * 6 * k, j[1] + Math.sin(j[2]) * 6 * k, j[3] + 8, 6.5, j[3] - 1]);
    }
    for (let k = 0; k < 5; k++) { const age = ((t * 0.9 + k / 5) % 1) * 1.5, d = jeepAt(t - age - 0.25); if (d && Scene.kindAt(d[0], d[1]) === Scene.KIND.road) push(age < 0.6 ? 'dust0' : 'dust1', d[0] + Math.sin(k * 5) * 2, d[1] + Math.cos(k * 3) * 3, d[3] + 1 + age * 2.5, k, 0.4 + age * 0.55); }
    // the wreck burns: three flames that flicker, and smoke that rises, spreads, thins and drifts down the wind
    const Wk = Scene.WRECK, wc = Math.cos(Wk.rot), ws = Math.sin(Wk.rot), wz = Scene.groundAt(Wk.x, Wk.y);
    [[-12, 0, 0], [-4, 2, 1], [14, -1, 2]].forEach(function (p) { const k = p[2]; push('flame' + (Math.floor(t * 9 + k * 1.7) % 3), Wk.x + p[0] * wc - p[1] * ws, Wk.y + p[0] * ws + p[1] * wc, wz + 5, t * 3 + k, (k === 2 ? 0.7 : 1) * (0.9 + 0.2 * Math.sin(t * 17 + k * 2))); });
    const N = 15, life = LOOP / 4;
    for (let k = 0; k < N; k++) {
      const age = ((t / life + k / N) % 1) * life, a2 = age * age, sx = Wk.x - 8 * wc + wind[0] * (age * 3.5 + a2 * 1.1) + Math.sin(k * 2.4 + age * 0.9) * (1.5 + age), sy = Wk.y - 8 * ws + wind[1] * (age * 3.5 + a2 * 1.1) + Math.cos(k * 1.7 + age * 0.7) * (1.5 + age);
      const sz = wz + 9 + age * 15 - a2 * 0.5, sc = 0.42 + age * 0.23;
      push(age < 1.3 ? 'smoke0' : age < 2.9 ? 'smoke1' : age < 4.6 ? 'smoke2' : 'smoke3', sx, sy, Math.min(sz, 118 - 15 * sc), k * 2.1 + age * 0.25, sc);
      if (age < 4.6 && age > 0.4) blobs.push([sx, sy, sz + 14 * sc, 7 * sc, sz]);
    }
    // birds wheel round the steeple and over the wheat, flapping, now and then gliding
    Scene.BIRDS.forEach(function (F, fi) {
      for (let i = 0; i < F[4]; i++) {
        const a = t * TAU / LOOP * (fi ? -1 : 2) + i * 0.5 + fi, r = F[2] + 9 * Math.sin(t * TAU * 2 / LOOP + i * 2.1), x = F[0] + Math.cos(a) * r, y = F[1] + Math.sin(a) * r, z = F[3] + 6 * Math.sin(t * TAU / 6 + i * 1.3);
        const glide = Math.sin(t * TAU / 4.5 + i * 2) > 0.45, w = glide ? 1 : [0, 1, 2, 1][Math.floor(t * 10 + i * 1.3) % 4];
        push('bird' + w, x, y, z, a + (fi ? -1 : 1) * Math.PI / 2 + 0.25, 1.15); if (blobs.length < 22) blobs.push([x, y, z + 2, 3.5, z - 1]);
      }
    });
    // the light of the fire (always), and the lamps as dusk falls: [x, y, z, reach, r, g, b]
    const fl = 0.8 + 0.14 * Math.sin(t * 13) + 0.1 * Math.sin(t * 31 + 2), fk = (0.55 + 1.2 * env.glow) * fl;
    lamps.push([Wk.x - 6 * wc, Wk.y - 6 * ws, wz + 11, 70, 1.5 * fk, 0.72 * fk, 0.25 * fk]);
    if (env.glow > 0.02) Scene.LAMPS.forEach(function (L, i) { const k = env.glow * 1.5 * (0.94 + 0.06 * Math.sin(t * 9 + i * 2)); lamps.push([L[0], L[1], L[2], L[3], 1.0 * k, 0.72 * k, 0.4 * k]); });
  }

  // the same frame in other units (?unit): every length times u, and opt.unit u
  function inUnits(o, u) {
    const r = Object.assign({}, o), sc = function (a, n) { return a.map(function (v, i) { return i < n ? v * u : v; }); };
    r.cam = Object.assign({}, o.cam, { tx: o.cam.tx * u, ty: o.cam.ty * u, tz: (o.cam.tz || 0) * u, dist: o.cam.dist * u });
    r.list = o.list.map(function (it) {
      const c = Object.assign({}, it, { x: it.x * u, y: it.y * u, z: it.z * u, scale: it.scale * u });
      if (it.each) c.each = function (z, n, out) { const m = it.each(z, n, out); if (!m) return null; m.dx *= u; m.dy *= u; m.dz *= u; return m; };
      if (it.reach) c.reach = it.reach * u;
      return c;
    });
    r.lamps = o.lamps.map(function (l) { return sc(l, 4); }); r.blobs = o.blobs.map(function (b) { return sc(b, 5); });
    r.cones = o.cones.map(function (c) { const k = sc(c, 4); return k; }); r.coneBlockers = o.coneBlockers && o.coneBlockers.map(function (b) { return sc(b, 4); });
    r.rings = o.rings.map(function (g) { return g.map(function (v, i) { return i < 5 || i === 9 ? v * u : v; }); });
    r.ground = (o.ground || 0) * u; r.unit = u; r.impostors = null; r.horde = null;
    return r;
  }
  function draw(f, measure) {
    frame = f; simTo(f); if (TOURING) tour(f); else if (S.orbit) cam.yaw = v0.yaw + f / 60 * 0.06;
    if (walkers[FOLLOW]) { const q = walkers[FOLLOW].path.at(walkers[FOLLOW].s); cam.tx = q[0]; cam.ty = q[1]; cam.tz = Scene.groundAt(q[0], q[1]) + 8; if (Q.has('face')) cam.yaw = q[2] + Math.PI + num('face', 0); }      // ?follow=3&face=0: keep a soldier in view, from the front
    clampCam();
    const t = f / 60, set = SETS[S.shell ? 1 : 0], st = statics[S.shell ? 1 : 0];
    env = Scene.light(S.tod < 0 ? 0.5 - 0.5 * Math.cos(t * TAU / 80) : S.tod); env.cloud = 0.5 * (1 - env.glow);
    list.length = 0; blobs = []; lamps = [];
    if (!HORDE || STRESS) walkers.forEach(function (k) {      // (the patrols keep off the road while the ?horde convoy is on it)
      const P = Rig.pose(k.rig), lift = Scene.groundAt(P.x * SCALE, P.y * SCALE); C.draw(Engine.figureWriter(list, SCALE, lift), set.chars.soldier, P);
      blobs.push([P.x * SCALE, P.y * SCALE, lift + C.height * SCALE, 3, lift - 1]);
    });
    animate(t, set); effects(t); pool.begin(list); if (HORDE) horde(t, set); if (BOTS) bots(t, set); if (NRINGS) pulses(t);
    // impostors only where they hold: the parallel camera, with the depth test on, and once they are baked for this tilt
    const baked = S.impostors && cam.mode !== 'persp' && (S.hsr || voxel) ? E.prepareImpostors(IMPOSTORS[S.shell ? 1 : 0], set.atlas, cam.pitch) : null;
    sprites.length = 0; sheet = baked;
    for (let i = 0; i < st.length; i++) if (baked && st[i].sprite && !baked.full) sprites.push(st[i]); else list.push(st[i]);
    const RO = { cam: cam, list: list, atlas: set.atlas, hsr: S.hsr, fill: S.fill, guard: S.guard, voxel: voxel, lod: S.lod, impostors: sprites, heat: S.heat, measure: measure || S.measure, scale: scale, split: S.split, cheap: S.cheap,
      shadows: S.shadows, ao: S.ao, bloom: S.bloom, light: env, lamps: lamps, blobs: blobs, water: pal.names.water2, ground: G, time: t,
      cones: cones, coneBlockers: blockers, lampCap: NLIGHTS > 16 ? 0.4 : 0, horde: BOTS && !BOTSOBJ ? flock : null, hdr: Q.has('hdr'), rings: rings, lightMapScale: env.glow };      // ?hdr=1: the half-float picture (see the README)
    if (NIGHT) {      // ?night=1: the night model and the film post (see the README); the lanterns are lit, the soldiers get contact shadows
      RO.light = NIGHT_LIGHT; RO.lampCap = 0.55; RO.post = { bloom: 0.4, vignette: 0.42, grain: 0.012, exposure: 1.8, grade: [0.26, 0.012, 1.16, 1], knee: 1.6, dof: [cam.mode === 'persp' ? cam.dist : 600, cam.mode === 'persp' ? cam.dist * 0.6 : 400, 0.5, 0.35] };
      RO.contacts = walkers.slice(0, 8).map(function (k) { const P = Rig.pose(k.rig); return [P.x * SCALE, P.y * SCALE, 4.5, 0.5]; });
    }
    E.render(UNIT !== 1 ? inUnits(RO, UNIT) : RO);
    rowsSeen = E.stats.rows;                                   // how tall the tallest layer was on screen: next frame's decision
    badge.classList.toggle('on', voxel);
  }

  // The canvas is as large as the window in device pixels. The picture is drawn at a whole fraction of that: the
  // largest whole-number scale that keeps the internal height at or above the one asked for (1080 / 360 = 3;
  // 720 does not divide 1080, so on a 1080p screen it comes out native). Native is still kept to about two and a
  // half million pixels, since the light pass is paid per pixel and a 4K screen has over eight million.
  function fit() {
    const d = window.devicePixelRatio || 1; canvas.width = Math.round(window.innerWidth * d); canvas.height = Math.round(window.innerHeight * d);
    scale = S.res ? Math.max(1, Math.floor(canvas.height / S.res)) : 1;
    while (canvas.width * canvas.height / (scale * scale) > 2.6e6) scale++;
  }
  function showHud(ms) {
    const s = E.stats, f1 = function (v) { return v === null || v === undefined ? '-' : v.toFixed(v < 10 ? 2 : 1); }, th = function (v) { return String(v).replace(/\B(?=(\d{3})+$)/g, ','); };
    const tod = env.t < 0.3 ? 'afternoon' : env.t < 0.82 ? 'golden hour' : 'dusk';
    statsEl.textContent = [
      s.iw + ' x ' + s.ih + ' internal' + (scale > 1 ? ', shown x' + scale + ' on ' + canvas.width + ' x ' + canvas.height : '') + (S.q ? '   quality ' + S.q : '') + '   R, Q change it',
      (cam.mode === 'persp' ? 'perspective' : 'parallel') + ' camera, tilt ' + Math.round(cam.pitch * 180 / Math.PI) + '°   ' + tod,
      (voxel ? 'VOXEL MODE: a box per slice, depth test' : S.hsr ? 'hidden-surface removal: top first, depth test' : 'painter order: bottom first, no depth test') + '   ' + (S.shell ? 'shell' : 'whole') + ' stacks' + (voxel ? '' : (S.fill ? '' : '   fill off') + (S.guard ? '' : '   guard off')),
      'voxel mode (each slice a box with sides) ' + (voxel ? 'on' : 'off') + (S.voxel === 1 ? (S.q === 'low' ? ' (the low preset)' : ' (forced on)') : S.voxel === 0 ? ' (forced off)' : S.voxel === 2 && cam.mode === 'persp' ? ' (the med preset, in perspective)' : voxel ? (rowsSeen > VOXEL_ROWS ? ' (a layer is ' + Math.round(rowsSeen) + ' rows tall, over ' + VOXEL_ROWS + ')' : ' (the view is under ' + Math.round(tiltLimit() * 180 / Math.PI) + '\u00b0)') : ' (flat slices hold above ' + Math.round(tiltLimit() * 180 / Math.PI) + '\u00b0)') + '   V changes it',
      th(s.slices) + ' slices, ' + th(s.instances) + (voxel ? ' boxes' : ' quads') + (sprites.length ? ' (' + sprites.length + ' of them impostors)' : ''),
      'also faster:  2 impostors ' + (!S.impostors ? 'off' : sprites.length ? 'on, ' + Math.round(sheet.bytes / 1048576) + ' MB' : cam.mode === 'persp' ? 'on (parallel camera only)' : !(S.hsr || voxel) ? 'on (need the depth test)' : 'on (baking)') + '   3 skip thin layers ' + (S.lod ? 'on' : 'off') + '   4 hollow slices in strips ' + (S.split ? 'on' : 'off') + (S.cheap ? '   cheap shadows' : ''),
      s.written ? 'fragments per pixel: ' + f1(s.written.avg) + ' written (' + Math.round(s.written.max) + ' max), ' + f1(s.covered.avg) + ' covered (' + Math.round(s.covered.max) + ' max)' : 'fragments per pixel: press M to measure',
      'slice effects:  Z build   X dismantle   C lower walls near the view ' + (FX.on ? 'on' : 'off'),
      'frame ' + f1(ms) + ' ms' + (s.gpuMs !== null ? '   gpu ' + f1(s.gpuMs) + ' ms' : '') + '   build ' + f1(s.cpuMs) + ' ms' + (S.measure || S.heat ? '   (with the count pass)' : '')
    ].concat(S.heat ? ['heat map, fragments ' + (S.heat === 1 ? 'written' : 'covered') + ':  black 0  blue 1  green 4  yellow 16  red 64  white 256'] : []).join('\n');
  }

  // ---------------------------------------------------------------- input
  let drag = null;
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('mousedown', function (e) { drag = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; if (S.orbit) { S.orbit = false; v0.yaw = cam.yaw; } });
  window.addEventListener('mouseup', function () { drag = null; });
  window.addEventListener('mousemove', function (e) {
    if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.pan) { const k = cam.dist / 500, c = Math.cos(cam.yaw), s = Math.sin(cam.yaw); cam.tx += (-dx * s - dy * c / Math.max(0.3, Math.sin(cam.pitch))) * k * -1; cam.ty += (dx * c - dy * s / Math.max(0.3, Math.sin(cam.pitch))) * k; }
    else { cam.yaw -= dx * 0.006; cam.pitch += dy * 0.005; }
  });
  canvas.addEventListener('wheel', function (e) { cam.dist *= Math.exp(e.deltaY * 0.001); e.preventDefault(); }, { passive: false });
  window.addEventListener('keydown', function (e) {
    const k = e.key.toLowerCase();
    if (k === 'p') cam.mode = cam.mode === 'persp' ? 'ortho' : 'persp'; else if (k === 'h') S.hsr = !S.hsr; else if (k === 'o') S.heat = (S.heat + 1) % 3;
    else if (k === 'r') { S.res = S.res === 360 ? 540 : S.res === 540 ? 720 : S.res === 720 ? 0 : 360; S.q = ''; fit(); }
    else if (k === 'q') quality(S.q === 'low' ? 'med' : S.q === 'med' ? 'high' : 'low');
    else if (k === '4') S.split = !S.split; else if (k === 'l') S.shell = !S.shell; else if (k === 't') S.fill = !S.fill; else if (k === 'g') S.guard = !S.guard;
    else if (k === 's') S.shadows = !S.shadows; else if (k === 'a') S.ao = !S.ao; else if (k === 'b') S.bloom = !S.bloom; else if (k === 'm') S.measure = !S.measure;
    else if (k === 'n') S.tod = S.tod < 0 ? 0 : S.tod < 0.3 ? 0.55 : S.tod < 0.8 ? 1 : -1;
    else if (k === ' ') { S.orbit = !S.orbit; v0.yaw = cam.yaw - frame / 60 * 0.06; e.preventDefault(); }
    else if (k === 'v' || k === '1') S.voxel = S.voxel < 0 ? 1 : S.voxel === 1 ? 0 : -1; else if (k === '2') S.impostors = !S.impostors; else if (k === '3') S.lod = !S.lod;
    else if (k === 'z') FX.tb = frame / 60; else if (k === 'x') FX.td = frame / 60; else if (k === 'c') FX.on = !FX.on;
    else if (k === 'u') hud.classList.toggle('off');
  });
  window.addEventListener('resize', fit);
  // If the browser takes the graphics context away (a driver reset, too many pages), say so instead of going blank.
  canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); playing = false; hud.classList.remove('off'); statsEl.textContent = 'The browser lost the WebGL context. Reload the page.'; });

  // ---------------------------------------------------------------- the clock, and what capture and measurement call
  let playing = !HELD, t0 = null, last = 0, smooth = 0;
  function quality(name) { const p = PRESETS[name]; if (!p) return; S.q = name; S.res = p.res; S.bloom = !!p.bloom; S.cheap = !!p.cheap; S.lod = !!p.lod; S.voxel = p.voxel; fit(); }
  function tick(t) {
    if (playing) {
      if (t0 === null) t0 = t; const dt = t - last; last = t; smooth += (dt - smooth) * 0.1; draw(Math.floor((t - t0) / 1000 * 60)); showHud(smooth);
    }
    requestAnimationFrame(tick);
  }
  window.demo = {
    frames: Q.has('fx') ? 240 : TOUR, fps: 60, engine: E, cam: cam, state: S, views: VIEWS, scene: Scene,
    ready: Promise.resolve({ frames: Q.has('fx') ? 240 : TOUR, fps: 60 }),
    seek: function (f) { playing = false; fit(); draw(f); draw(f); showHud(E.stats.cpuMs); return f; },      // twice: the choice of voxel mode follows the frame before
    set: function (o) { Object.keys(o).forEach(function (k) { if (k in S && k !== 'q' && k !== 'res') S[k] = o[k]; else if (k === 'view') { cam.tz = 0; Object.assign(cam, VIEWS[o[k]]); } else if (k === 'q') quality(o[k]); else if (k === 'res') { S.res = height(String(o[k])); S.q = ''; } else cam[k] = o[k]; }); },
    // one frame with the count pass: fragments per pixel, exactly
    measure: function (f) { playing = false; fit(); draw(f || 0); draw(f || 0, true); showHud(E.stats.cpuMs); const s = E.stats; return { canvas: [canvas.width, canvas.height], internal: [s.iw, s.ih], voxel: voxel, rows: s.rows, slices: s.slices, quads: s.instances, written: s.written, covered: s.covered, pixelsHit: s.pixelsHit / s.pixels, exact: s.exact, renderer: E.renderer }; },
    // How far flat slices fail in the current view: draw it as boxes (which are solid from anywhere), then as flat
    // slices, and count the pixels where the flat picture shows something more than a layer lower: a gap seen
    // through. Returns that as a share of the pixels that show an object at all. This is how VOXEL_TILT was set.
    holes: function (f) {
      const was = S.voxel, free = S.unclamped; playing = false; fit(); S.unclamped = true;
      S.voxel = 1; draw(f || 0); const a = E.heights(); S.voxel = 0; draw(f || 0); const b = E.heights(); S.voxel = was; S.unclamped = free;
      const w = E.stats.iw; let seen = 0, gaps = 0;
      for (let i = w + 1; i < a.length - w - 1; i++) if (a[i] > G + 1.5) { seen++; const low = b[i] + 1.25; if (a[i] > low && a[i - 1] > low && a[i + 1] > low && a[i - w] > low && a[i + w] > low) gaps++; }      // (not the outline: its neighbours must stand above the gap too)
      return { gaps: gaps / Math.max(1, seen), pixels: seen, rows: E.stats.rows };
    },
    // n frames one after another, each waited for: milliseconds per frame, everything included
    bench: function (n) { playing = false; fit(); for (let i = 0; i < 10; i++) { draw(i); E.finish(); } const a = performance.now(); let c = 0; for (let i = 0; i < n; i++) { draw(10 + i); c += E.stats.cpuMs; E.finish(); } window.demo.cpuMs = c / n; return (performance.now() - a) / n; }
  };
  fit(); draw(0); showHud(0);
  if (Q.has('nohud')) hud.classList.add('off');
  if (TOURING) hud.classList.add('film');                           // the film shows the numbers, not the keys
  if (Q.has('hud')) hud.style.fontSize = 12 * num('hud', 1) + 'px';      // a larger read-out, for video
  document.body.classList.add('ready');
  requestAnimationFrame(tick);
})();
