// rig.js: a walk for a stacked character. No drawing here, only numbers.
//
// Two ideas carry it:
//  1. The step clock is driven by distance, not time. Each call to step() adds (ground covered / stride length) to
//     one phase. A leg is planted for the first part of its cycle and swings for the rest; the two legs are half a
//     cycle apart. Because the clock only moves when the body does, feet cannot slide or run ahead.
//  2. A planted foot is a fixed point in the world. The body travels over it, and the knee is solved every frame
//     from where the hip and the foot are: analytic two-bone inverse kinematics (the law of cosines).
(function (global) {
  'use strict';
  const TAU = Math.PI * 2;
  function ease(t) { return t * t * (3 - 2 * t); }
  function turn(a, b, t) { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return a + d * t; }

  // Two-bone IK. root and target are [x, y, z]; a and b are the bone lengths; hint is the direction the middle
  // joint should bend towards. Returns the middle joint. The triangle root-joint-target has sides a, b and the
  // distance d between root and target, so the angle at the root follows from the law of cosines.
  function solveTwoBone(root, target, a, b, hint) {
    let dx = target[0] - root[0], dy = target[1] - root[1], dz = target[2] - root[2];
    const len = Math.hypot(dx, dy, dz) || 1e-6; dx /= len; dy /= len; dz /= len;
    const d = Math.min(Math.max(len, Math.abs(a - b) + 1e-3), a + b - 1e-3);    // out of reach: the limb is straight
    const cosA = (a * a + d * d - b * b) / (2 * a * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    // the bend direction: the hint with its part along the limb removed
    const along = hint[0] * dx + hint[1] * dy + hint[2] * dz;
    let px = hint[0] - along * dx, py = hint[1] - along * dy, pz = hint[2] - along * dz;
    const pl = Math.hypot(px, py, pz);
    if (pl < 1e-6) { px = 0; py = 0; pz = 1; } else { px /= pl; py /= pl; pz /= pl; }
    return [root[0] + dx * a * cosA + px * a * sinA, root[1] + dy * a * cosA + py * a * sinA, root[2] + dz * a * cosA + pz * a * sinA];
  }

  const DEFAULTS = {
    thigh: 7, shin: 7,        // leg bones
    ankle: 1.5,               // the ankle's height over the sole
    hipHalf: 2.4,             // half the distance between the hips
    kneeHint: 1,              // 1: knees bend forward; -1: backward
    standHip: 13.2,           // hip height when standing
    stride: 18,               // ground covered by one full cycle (two steps)
    duty: 0.6,                // the part of a cycle a foot is planted; over 0.5 is a walk, under it a run
    lift: 2.4,                // how high a swinging foot rises
    bob: 0.35,                // hips rise and fall, twice a cycle
    twist: 0.16,              // hips turn with the leading leg (radians); the shoulders turn against it
    spine: 9.5,               // from the hips up to the shoulders (or to the top of a body without arms)
    arms: true, shoulderHalf: 7.5, upperArm: 4.6, foreArm: 4.6, armSwing: 0.55,
    idleV: 0                  // below this speed (units a second) the feet settle instead of walking (0: off; see settle)
    // Also read if a character sets them (not defaulted here: a walker with more fields read slower, measured):
    //   piece   the longest move walked in one go, longer ones are cut into pieces (a sixth of a stride)
    //   jump    a move longer than this is a jump, not a walk (two strides; see step)
    //   reachK  no foot is left further from its hip on the ground than this share of thigh + shin (0.8)
  };

  function createWalker(cfg) {
    const c = Object.assign({}, DEFAULTS, cfg || {});
    const w = { c: c, x: 0, y: 0, h: 0, dx: 1, dy: 0, phase: 0, hipZ: c.standHip, steps: 0, feet: [] };
    for (let i = 0; i < 2; i++) w.feet.push({ x: 0, y: 0, z: 0, rot: 0, planted: true, fx: 0, fy: 0, frot: 0 });
    place(w, 0, 0, 0);
    return w;
  }
  function hipGround(w, i, h) { const side = i ? 1 : -1, c = w.c; return [w.x - Math.sin(h) * side * c.hipHalf, w.y + Math.cos(h) * side * c.hipHalf]; }

  // Put the walker somewhere without walking there: both feet under the hips.
  function place(w, x, y, h) {
    w.x = x; w.y = y; w.h = h; w.dx = Math.cos(h); w.dy = Math.sin(h); w.hipZ = w.c.standHip;
    for (let i = 0; i < 2; i++) { const g = hipGround(w, i, h), f = w.feet[i]; f.x = g[0]; f.y = g[1]; f.z = 0; f.rot = h; f.planted = true; }
  }

  // Move the body to (x, y) facing h. Call once per fixed time step; dt only smooths the hip height.
  // One call can cover a long move (a slow frame, a fast-forward, a hidden tab): a planted foot stays at its point
  // until the step clock lifts it, so a long move in one go would leave it metres behind with the leg drawn out to
  // it. So a move longer than c.piece is walked in pieces (the gait is the same at any frame rate); a move longer
  // than c.jump is not walked at all: the figure is stood a stride back along its way and walks that in, so it
  // arrives in step; and afterwards no foot is left further from its hip than the leg reaches (c.reachK).
  // A short move, as at a normal frame rate, takes exactly the path it always did.
  function longMove(w, x, y, h, dt, d) {
    const c = w.c, piece = c.piece > 0 ? c.piece : c.stride / 6, jump = c.jump > 0 ? c.jump : c.stride * 2; let x0 = w.x, y0 = w.y;
    if (d > jump) { const b = Math.min(d, c.stride); x0 = x - (x - x0) / d * b; y0 = y - (y - y0) / d * b; d = b; place(w, x0, y0, h); }
    const n = Math.ceil(d / piece * 1.0001);      // (each piece a hair under the limit, so step walks it)
    for (let i = 1; i <= n; i++) step(w, x0 + (x - x0) * i / n, y0 + (y - y0) * i / n, h, (dt || 1 / 60) / n);
    replant(w, h);
  }
  // Put back under its hip any foot left further from it than the leg reaches, and keep the hips low enough.
  function replant(w, h) {
    const c = w.c, flat = (c.thigh + c.shin) * (c.reachK || 0.8); let far = 0;
    for (let i = 0; i < 2; i++) {
      const f = w.feet[i], g = hipGround(w, i, h);
      if (Math.hypot(f.x - g[0], f.y - g[1]) > flat) { f.x = g[0]; f.y = g[1]; f.z = 0; f.rot = h; f.planted = true; f.st = 0; f.fx = g[0]; f.fy = g[1]; f.frot = h; }
      far = Math.max(far, Math.hypot(f.x - g[0], f.y - g[1]));
    }
    const reach = c.thigh + c.shin - 0.3, most = c.ankle + Math.sqrt(Math.max(1, reach * reach - far * far)); if (w.hipZ > most) w.hipZ = most;
  }
  function step(w, x, y, h, dt) {
    const c = w.c, mx = x - w.x, my = y - w.y, dist = Math.hypot(mx, my);
    if (dist > (c.piece > 0 ? c.piece : c.stride / 6)) { longMove(w, x, y, h, dt, dist); return; }      // (a long move: see above)
    // Standing, shuffling or turning on the spot: the distance clock would freeze with a foot in the air (a run's
    // duty is under 0.5, so both can be), and planted feet would stay put while the hips turn over them (crossed
    // legs). Below idleV the feet settle instead (off unless the character sets it).
    if (c.idleV > 0 && dist / Math.max(dt || 1 / 60, 1e-4) < c.idleV) { settle(w, x, y, h, dt || 1 / 60); return; }
    w.idle = false;
    w.x = x; w.y = y; w.h = h;
    if (dist > 1e-6) { w.dx = mx / dist; w.dy = my / dist; }
    w.phase = (w.phase + dist / c.stride) % 1;
    const stance = c.duty * c.stride;            // ground the body covers while one foot is down
    let far = 0;
    for (let i = 0; i < 2; i++) {
      const f = w.feet[i], g = hipGround(w, i, h), p = (w.phase + i * 0.5) % 1;
      if (p < c.duty) {
        if (!f.planted) {                        // touchdown: half a stance ahead of the hip, so the hip passes over it mid-stance
          const ahead = stance / 2 - p * c.stride;
          f.planted = true; f.x = g[0] + w.dx * ahead; f.y = g[1] + w.dy * ahead; f.rot = h; w.steps++;
        }
        f.z = 0;                                 // planted: x and y are not touched until the foot lifts
        far = Math.max(far, Math.hypot(f.x - g[0], f.y - g[1]));
      } else {
        if (f.planted) { f.planted = false; f.fx = f.x; f.fy = f.y; f.frot = f.rot; }
        const u = (p - c.duty) / (1 - c.duty), e = ease(u);
        const ahead = (1 - p) * c.stride + stance / 2;   // where the hip will be at touchdown, plus half a stance
        f.x = f.fx + (g[0] + w.dx * ahead - f.fx) * e; f.y = f.fy + (g[1] + w.dy * ahead - f.fy) * e;
        f.z = c.lift * Math.sin(Math.PI * u);
        f.rot = turn(f.frot, h, e);
      }
    }
    // hip height: as high as standing allows, but never so high that a planted foot is out of reach
    const reach = c.thigh + c.shin - 0.3, most = c.ankle + Math.sqrt(Math.max(1, reach * reach - far * far));
    const want = Math.min(c.standHip, most);
    w.hipZ += (want - w.hipZ) * Math.min(1, (dt || 1 / 60) * 14);
    if (w.hipZ > most) w.hipZ = most;
  }

  // Settling: a lifted foot comes down under its hip, and a planted foot that the hips have turned or moved away
  // from takes a short step back under it, one foot at a time. The hips ease to standing height.
  function settle(w, x, y, h, dt) {
    const c = w.c; w.x = x; w.y = y; w.h = h;
    if (!w.idle) { w.idle = true; w.phase = 0; for (const f of w.feet) f.st = 0; }
    const dur = 0.2;      // seconds for one settling step
    let busy = -1; for (let i = 0; i < 2; i++) if (w.feet[i].st > 0) busy = i;
    for (let i = 0; i < 2; i++) {
      const f = w.feet[i], g = hipGround(w, i, h);
      if (f.st > 0) {                           // a settling step in progress
        f.st = Math.min(1, f.st + dt / dur); const e = ease(f.st);
        f.x = f.fx + (g[0] - f.fx) * e; f.y = f.fy + (g[1] - f.fy) * e; f.z = f.lz * (1 - e) + c.lift * 0.5 * Math.sin(Math.PI * f.st); f.rot = turn(f.frot, h, e);
        if (f.st >= 1) { f.st = 0; f.z = 0; f.planted = true; f.x = g[0]; f.y = g[1]; f.rot = h; w.steps++; }
        continue;
      }
      const off = Math.hypot(f.x - g[0], f.y - g[1]), dr = Math.abs(turn(0, h - f.rot, 1));
      if ((!f.planted || f.z > 0.01 || off > c.hipHalf * 0.9 || dr > 0.45) && busy < 0) {
        f.st = 1e-3; f.fx = f.x; f.fy = f.y; f.frot = f.rot; f.lz = f.z; f.planted = false; busy = i;
      }
    }
    w.hipZ += (c.standHip - w.hipZ) * Math.min(1, dt * 10);
  }

  // Everything a drawing needs, as plain data: joints are [x, y, z]. arms is empty when the character has none.
  function pose(w) {
    const c = w.c, ph = w.phase * TAU, fwd = [Math.cos(w.h), Math.sin(w.h), 0];
    const twist = c.twist * Math.cos(ph), hipsAngle = w.h + twist, shouldersAngle = w.h - twist * 1.2;
    const pz = w.hipZ - c.bob * Math.cos(2 * ph);
    const P = { x: w.x, y: w.y, heading: w.h, phase: w.phase, pelvis: [w.x, w.y, pz], top: [w.x, w.y, pz + c.spine], hipsAngle: hipsAngle, shouldersAngle: shouldersAngle, legs: [], arms: [] };
    for (let i = 0; i < 2; i++) {
      const side = i ? 1 : -1, f = w.feet[i];
      const hip = [w.x - Math.sin(hipsAngle) * side * c.hipHalf, w.y + Math.cos(hipsAngle) * side * c.hipHalf, pz];
      const ankle = [f.x, f.y, f.z + c.ankle];
      P.legs.push({ hip: hip, knee: solveTwoBone(hip, ankle, c.thigh, c.shin, [fwd[0] * c.kneeHint, fwd[1] * c.kneeHint, 0]), ankle: ankle, sole: [f.x, f.y, f.z], rot: f.rot, planted: f.planted });
      if (!c.arms) continue;
      // the arm swings against the leg on its side; the elbow is solved with the same function, bending backwards
      const sh = [w.x - Math.sin(shouldersAngle) * side * c.shoulderHalf, w.y + Math.cos(shouldersAngle) * side * c.shoulderHalf, pz + c.spine];
      const a = side * c.armSwing * Math.cos(ph), L = (c.upperArm + c.foreArm) * 0.93;
      const hand = [sh[0] + fwd[0] * Math.sin(a) * L, sh[1] + fwd[1] * Math.sin(a) * L, sh[2] - Math.cos(a) * L];
      P.arms.push({ shoulder: sh, elbow: solveTwoBone(sh, hand, c.upperArm, c.foreArm, [-fwd[0], -fwd[1], 0]), hand: hand });
    }
    return P;
  }

  // teleport: the same as place (stand the walker at (x, y) facing h, both feet under its hips): for a figure that
  // jumps, appears, or was not drawn for a while
  global.Rig = { solveTwoBone: solveTwoBone, createWalker: createWalker, place: place, teleport: place, step: step, pose: pose, DEFAULTS: DEFAULTS };
})(window);
