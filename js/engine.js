// engine.js: a sprite-stack renderer in plain WebGL2.
//
// What happens each frame:
//   1. Every slice of every stack becomes one or more instances of a quad: one for every screen row its layer is
//      tall, so stacks stay solid at any zoom, tilt or perspective. Instances are sorted by height.
//   2. The slice pass draws them into a small G-buffer: palette index, facing, height. No colour, no light.
//      - painter: lowest first, no depth test. Every slice is drawn in full (this is the overdraw).
//      - hidden-surface removal: highest first with a depth test, so a pixel already covered rejects the rest.
//   3. The light pass runs once per screen pixel: it looks up the colour, rebuilds the world position from the
//      stored height, and works out the light there: a low sun with soft shadows (a march through a height map),
//      a fill from the sky above and the earth below, ambient occlusion, a rim on sunward edges, lamps, haze,
//      a tone curve and a grade. Each has a comment where it is computed (FS_LIGHT).
//   4. What glows (fire always, lamps and windows at dusk) is blurred at a quarter of the size and added back: bloom.
//   5. The result is copied to the canvas, scaled up without smoothing if the internal resolution is lower.
// An optional count pass draws the same instances additively to measure overdraw exactly.
//
// VOXEL MODE is the second way the slice pass can draw (see the block at VS_VOXEL). Flat slices stay solid only
// while the camera looks down on them steeply enough; below that the engine draws every slice as the box it
// stands for, with side faces and a depth test, and stacks are solid from any angle.
//
// LIGHTS AND HORDES (see the README section of that name). Up to 256 point lights, read from a small float
// texture so their number costs no uniforms; each can be occluded by the height map and can glow in the haze.
// Up to 16 cone lights (searchlights, headlamps): a pool where they land and a beam through the air, both cut
// by a small shadow table per cone. Every instance can be faded (a screen-door dither) or stretched upward. An
// fx hook draws particles into the lit picture, depth-tested against the slice pass. itemPool reuses the items of
// a horde frame to frame, so thousands of moving stacks make no garbage.
(function (global) {
  'use strict';
  const FL = 12;                      // floats per instance: pos 3, rot 1, rect 4 (the fade rides in its first: see a_rectf), offset 2, scale 1, box height 1 (voxel mode)
  const NB = 2048, ZQ = 16;           // height buckets, and buckets per unit of height
  const HMAX = 128;                   // tallest thing the G-buffer and the height map can hold
  const LIGHTS = 256, CONES = 16, BINS = 64, RINGS = 8, BLOBS = 24, STEPS = 48, REACH = 195, CONTACTS = 32;     // point lights, cone lights, bins per cone in its shadow table
  const ANGLES = 32, IMP_W = 4096, IMP_H = 2048, IMP_PPU = 3, IL = 15;      // impostors: views per stack, their atlas, its pixels per unit, floats per sprite

  // ---------------------------------------------------------------- small matrix helpers (column-major 4x4)
  function mul(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3]; return o; }
  function invert(m) {
    const a = new Float64Array(32); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { a[r * 8 + c] = m[c * 4 + r]; a[r * 8 + 4 + c] = r === c ? 1 : 0; }
    for (let i = 0; i < 4; i++) {
      let p = i; for (let r = i + 1; r < 4; r++) if (Math.abs(a[r * 8 + i]) > Math.abs(a[p * 8 + i])) p = r;
      if (p !== i) for (let c = 0; c < 8; c++) { const t = a[i * 8 + c]; a[i * 8 + c] = a[p * 8 + c]; a[p * 8 + c] = t; }
      const d = a[i * 8 + i]; for (let c = 0; c < 8; c++) a[i * 8 + c] /= d;
      for (let r = 0; r < 4; r++) if (r !== i) { const f = a[r * 8 + i]; if (f) for (let c = 0; c < 8; c++) a[r * 8 + c] -= f * a[i * 8 + c]; }
    }
    const o = new Float32Array(16); for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) o[c * 4 + r] = a[r * 8 + 4 + c]; return o;
  }

  // The camera orbits a point on the ground. yaw turns it, pitch tilts it (90 degrees is straight down), dist zooms.
  // mode 'ortho' is the classic parallel view; 'persp' is a true perspective camera.
  // Sorting by height is exact as long as every view ray points downward, which holds while pitch > fov / 2.
  // unit (optional, 1 if not given): the size of an art pixel in world units, which sets the near and far planes
  // (cam.near and cam.far, if given, set them instead).
  function cameraMatrices(cam, aspect, unit) {
    const U = unit || 1;
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const f = [cp * cy, cp * sy, -sp], r = [sy, -cy, 0], u = [cy * sp, sy * sp, cp];
    const ortho = cam.mode !== 'persp', th = Math.tan(cam.fov / 2), back = ortho ? 1500 * U : cam.dist;
    const eye = [cam.tx - f[0] * back, cam.ty - f[1] * back, (cam.tz || 0) - f[2] * back];      // tz: the height of the point looked at (the ground, unless set)
    const dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    const V = new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, eye), -dot(u, eye), dot(f, eye), 1]);
    let P;
    if (ortho) { const hh = cam.dist * th, hw = hh * aspect, n = cam.near || U, fr = cam.far || 3200 * U; P = new Float32Array([1 / hw, 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, -2 / (fr - n), 0, 0, 0, -(fr + n) / (fr - n), 1]); }
    else { const n = cam.near || Math.max(2 * U, cam.dist * 0.05), fr = cam.far || cam.dist * 3 + 1400 * U; P = new Float32Array([1 / (th * aspect), 0, 0, 0, 0, 1 / th, 0, 0, 0, 0, -(fr + n) / (fr - n), -1, 0, 0, -2 * fr * n / (fr - n), 0]); }
    const vp = mul(P, V);
    return { vp: vp, inv: invert(vp), eye: eye, f: f, r: r, u: u, ortho: ortho, th: th, cp: cp, px: P[0], py: P[5], back: back };
  }

  // ---------------------------------------------------------------- shaders
  const VS_SLICE = `#version 300 es
  layout(location=0) in vec3 a_pos; layout(location=1) in float a_rot; layout(location=2) in vec4 a_rectf;
  layout(location=3) in vec2 a_off; layout(location=4) in float a_scale; layout(location=5) in vec2 a_corner;
  uniform mat4 u_vp; uniform float u_guard;                 // u_guard: half a pixel, in clip units (0 turns it off)
  out vec2 v_uv; flat out vec4 v_rect; flat out vec2 v_cs; out float v_h; flat out float v_fade, v_row;
  void main() {
    vec2 corner = a_corner;                                 // (0,0) (1,0) (0,1) (1,1): the same four for every instance
    // the slice's rectangle in the atlas starts on a whole texel; the fraction of its first number is half the fade,
    // the fraction of its second is its palette row over 64
    vec4 a_rect = vec4(floor(a_rectf.xy), a_rectf.zw); v_fade = (a_rectf.x - a_rect.x) * 2.0; v_row = floor((a_rectf.y - a_rect.y) * 64.0 + 0.5);
    float c = cos(a_rot), s = sin(a_rot);
    vec2 l = (a_off + (corner - 0.5) * a_rect.zw) * a_scale, m = a_off * a_scale;
    vec4 p = u_vp * vec4(a_pos + vec3(l.x * c - l.y * s, l.x * s + l.y * c, 0.0), 1.0);
    vec4 q = u_vp * vec4(a_pos + vec3(m.x * c - m.y * s, m.x * s + m.y * c, 0.0), 1.0);   // the middle of the slice
    // A slice seen edge-on has no height on screen and would vanish between pixel rows. Push every corner half a
    // pixel away from the slice's middle line, so it always covers at least one row.
    p.y += (p.y / p.w >= q.y / q.w ? 1.0 : -1.0) * u_guard * p.w;
    gl_Position = p; v_uv = a_rect.xy + corner * a_rect.zw; v_rect = a_rect; v_cs = vec2(c, s); v_h = a_pos.z;
  }`;
  // FADE: screen-door transparency. An instance with a fade leaves out that share of its pixels in a fixed 4x4
  // (Bayer) pattern, so what is behind it shows through without sorting or blending: a tree between the camera
  // and the player, a wreck sinking out of sight.
  // PALETTE ROWS. The palette can have several rows (E.setPalette(bytes, rows)): the same art in other colours (a
  // hit flash, burning, a ghost) without another copy of the stack in the atlas. An instance's row rides in its
  // rectangle (see VS_SLICE); while there is more than one row the slice pass writes it to a third target, which
  // the light pass reads. With one row none of this is compiled in (ROWS_ON 0).
  const ROWS_OUT = `
  #define ROWS_ON 0
  #if ROWS_ON
  layout(location=2) out vec4 o2;
  #define ROW_WRITE(r) o2 = vec4((r) / 255.0, 0.0, 0.0, 1.0)
  #else
  #define ROW_WRITE(r)
  #endif`;
  const FADED = `
  bool faded(float f) {
    if (f <= 0.0) return false;
    ivec2 q = ivec2(gl_FragCoord.xy) & 3; int a = q.x ^ q.y;
    int v = ((a & 1) << 3) | ((q.y & 1) << 2) | (a & 2) | ((q.y >> 1) & 1);
    return (float(v) + 0.5) / 16.0 < f;
  }`;
  const FS_G = `#version 300 es
  precision highp float;
  uniform sampler2D u_atlas;
  in vec2 v_uv; flat in vec4 v_rect; flat in vec2 v_cs; in float v_h; flat in float v_fade, v_row;
  layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
  ${ROWS_OUT}
  ${FADED}
  void main() {
    if (faded(v_fade)) discard;
    vec4 t = texelFetch(u_atlas, ivec2(clamp(v_uv, v_rect.xy, v_rect.xy + v_rect.zw - 0.001)), 0);
    if (t.r == 0.0) discard;                                // an empty pixel of the slice
    vec3 n = t.gba * 2.0 - 1.0; n.xy = vec2(n.x * v_cs.x - n.y * v_cs.y, n.x * v_cs.y + n.y * v_cs.x);   // turn the facing with the slice
    o0 = vec4(t.r, n * 0.5 + 0.5);                          // palette index, facing
    float h = clamp(v_h / ${HMAX}.0, 0.0, 1.0) * 65535.0, hi = floor(h / 256.0);
    o1 = vec4(hi / 255.0, (h - hi * 256.0) / 255.0, 0.0, 0.0);   // height, 16 bits (the other two are voxel mode's)
    ROW_WRITE(v_row);
  }`;
  const FS_COUNT = `#version 300 es
  precision highp float;
  uniform sampler2D u_atlas; uniform int u_all; uniform float u_unit;   // u_unit: what one fragment adds
  in vec2 v_uv; flat in vec4 v_rect; flat in vec2 v_cs; in float v_h;
  out vec4 o;
  void main() {
    if (u_all == 1) { o = vec4(0.0, u_unit, 0.0, 0.0); return; }   // every fragment the quad covers
    vec4 t = texelFetch(u_atlas, ivec2(clamp(v_uv, v_rect.xy, v_rect.xy + v_rect.zw - 0.001)), 0);
    if (t.r == 0.0) discard;
    o = vec4(u_unit, 0.0, 0.0, 0.0);                          // every fragment written
  }`;
  // ================================================================ VOXEL MODE
  // What it is. A slice is a picture of one layer of an object, and the layer is one unit thick. Normal sprite
  // stacking draws the picture as a flat quad and hides the gaps between layers by drawing it again for every
  // screen row the layer is tall ("thickness fill"). That works while the camera looks down. As the view drops
  // towards the horizon each flat quad shrinks to a line, a layer needs more copies than the engine will draw
  // (the cap is 48), and stacks come apart into separate layers.
  // Voxel mode draws each slice as what it stands for: a box one layer tall, with a top and four side faces.
  // The box is drawn once. Its fragment shader starts where the view ray enters the box and steps from texel
  // to texel of the slice until it meets a filled one (so every filled pixel of the slice becomes a little
  // column with its own sides) or leaves the box. The point it finds writes its own depth, and the depth test
  // is always on, so boxes hide one another correctly from any direction, level or even looking up.
  // When. main.js switches it on by itself when the tilt drops under a measured threshold or a layer would be
  // taller on screen than the fill can cover, shows a badge while it is on, and has a key to force it.
  // Cost. One box (12 triangles) per slice instead of up to 48 quads, a short loop per fragment, and no early
  // depth test, because the shader writes depth. The numbers are in the README.
  const VS_VOXEL = `#version 300 es
  layout(location=0) in vec3 a_pos; layout(location=1) in float a_rot; layout(location=2) in vec4 a_rectf;
  layout(location=3) in vec2 a_off; layout(location=4) in float a_scale; layout(location=5) in vec3 a_box; layout(location=6) in float a_span;
  uniform mat4 u_vp; uniform vec3 u_eye, u_fwd; uniform float u_ortho;
  out vec3 v_p, v_d; flat out vec4 v_rect, v_base; flat out vec3 v_how; flat out vec2 v_off; flat out float v_fade, v_row;
  void main() {
    vec4 a_rect = vec4(floor(a_rectf.xy), a_rectf.zw); v_fade = (a_rectf.x - a_rect.x) * 2.0; v_row = floor((a_rectf.y - a_rect.y) * 64.0 + 0.5);     // (fade and row: see VS_SLICE)
    float c = cos(a_rot), s = sin(a_rot);
    vec2 l = (a_off + (a_box.xy - 0.5) * a_rect.zw) * a_scale;
    vec3 w = a_pos + vec3(l.x * c - l.y * s, l.x * s + l.y * c, a_box.z * a_span);
    gl_Position = u_vp * vec4(w, 1.0);
    v_p = vec3(a_box.xy * a_rect.zw, a_box.z * a_span / a_scale);       // where this corner is inside the box, in texels (a layer is one texel tall)
    vec3 d = u_ortho > 0.5 ? u_fwd : w - u_eye;                            // the view ray through this corner
    v_d = vec3(d.x * c + d.y * s, -d.x * s + d.y * c, d.z);               // turned into the slice's own frame
    v_rect = a_rect; v_base = vec4(a_pos, a_scale); v_how = vec3(c, s, a_span / a_scale); v_off = a_off;
  }`;
  const WALK = `
  uniform sampler2D u_atlas; uniform mat4 u_vp;
  in vec3 v_p, v_d; flat in vec4 v_rect, v_base; flat in vec3 v_how;
  // Step the ray through the slice's texels (the classic grid walk). t: the texel hit. q: where, in texels.
  bool walk(out vec4 t, out vec3 q) {
    vec3 dir = v_d / max(length(v_d), 1e-6); vec2 size = v_rect.zw;
    vec3 p = vec3(clamp(v_p.xy, vec2(0.001), size - 0.001), v_p.z);
    ivec2 cell = ivec2(p.xy), lim = ivec2(size + 0.5), stp = ivec2(dir.x < 0.0 ? -1 : 1, dir.y < 0.0 ? -1 : 1);
    vec2 inv = 1.0 / max(abs(dir.xy), vec2(0.00001));
    vec2 next = vec2(dir.x < 0.0 ? p.x - float(cell.x) : float(cell.x) + 1.0 - p.x, dir.y < 0.0 ? p.y - float(cell.y) : float(cell.y) + 1.0 - p.y) * inv;
    // the ray leaves the box through its bottom if it points down, through its top if it points up
    float leave = dir.z < -0.00001 ? p.z / -dir.z : dir.z > 0.00001 ? (v_how.z - p.z) / dir.z : 1000000.0, k = 0.0; bool hit = false;
    for (int i = 0; i < 48; i++) {
      t = texelFetch(u_atlas, ivec2(v_rect.xy) + cell, 0);
      if (t.r > 0.0) { hit = true; break; }
      if (next.x < next.y) { k = next.x; next.x += inv.x; cell.x += stp.x; } else { k = next.y; next.y += inv.y; cell.y += stp.y; }
      if (k > leave || cell.x < 0 || cell.y < 0 || cell.x >= lim.x || cell.y >= lim.y) break;
    }
    q = p + dir * k; return hit;
  }
  // the depth of that point, so boxes hide one another correctly whatever order they are drawn in
  float depthOf(vec3 q, vec2 off, out float h) {
    vec2 l = (off + q.xy - v_rect.zw * 0.5) * v_base.w; h = v_base.z + clamp(q.z, 0.0, v_how.z) * v_base.w;
    vec4 c = u_vp * vec4(v_base.xy + vec2(l.x * v_how.x - l.y * v_how.y, l.x * v_how.y + l.y * v_how.x), h, 1.0);
    return c.z / c.w * 0.5 + 0.5;
  }`;
  const FS_GVOXEL = `#version 300 es
  precision highp float;
  ${WALK}
  flat in vec2 v_off; flat in float v_fade, v_row;
  uniform vec3 u_eye, u_fwd;
  layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
  ${ROWS_OUT}
  ${FADED}
  void main() {
    if (faded(v_fade)) discard;
    vec4 t; vec3 q; if (!walk(t, q)) discard;
    vec3 n = t.gba * 2.0 - 1.0; n.xy = vec2(n.x * v_how.x - n.y * v_how.y, n.x * v_how.y + n.y * v_how.x);
    float hw; gl_FragDepth = depthOf(q, v_off, hw);
    o0 = vec4(t.r, n * 0.5 + 0.5);
    float h = clamp(hw / ${HMAX}.0, 0.0, 1.0) * 65535.0, hi = floor(h / 256.0);
    // Besides the height, how far in front of the camera the point is (16 bits over 4096 units). The light pass
    // finds a pixel's place from its height, which fails for a ray that runs level (the row of the horizon); there
    // it uses this distance instead.
    vec2 l = (v_off + q.xy - v_rect.zw * 0.5) * v_base.w;
    float far = clamp(dot(vec3(v_base.xy + vec2(l.x * v_how.x - l.y * v_how.y, l.x * v_how.y + l.y * v_how.x), hw) - u_eye, u_fwd) / 4096.0, 0.0, 1.0) * 65535.0, fi = floor(far / 256.0);
    o1 = vec4(hi / 255.0, (h - hi * 256.0) / 255.0, fi / 255.0, (far - fi * 256.0) / 255.0);
    ROW_WRITE(v_row);
  }`;
  const FS_COUNTVOXEL = `#version 300 es
  precision highp float;
  ${WALK}
  flat in vec2 v_off;
  uniform int u_all; uniform float u_unit;
  out vec4 o;
  void main() {
    if (u_all == 1) { o = vec4(0.0, u_unit, 0.0, 0.0); gl_FragDepth = gl_FragCoord.z; return; }
    vec4 t; vec3 q; if (!walk(t, q)) discard;
    float hw; gl_FragDepth = depthOf(q, v_off, hw);
    o = vec4(u_unit, 0.0, 0.0, 0.0);
  }`;
  // ================================================================ end of voxel mode's shaders
  // Impostors. A stack that never changes can be drawn ahead of time: once from each of ${ANGLES} directions round
  // it, into an atlas that keeps what the G-buffer needs (material, facing, height). After that the whole stack is
  // one quad that faces the camera, showing the view nearest to the real one. The catches are real: the stack
  // turns in steps of ${360 / ANGLES} degrees, the sprites hold for one tilt of the parallel camera only (they are
  // drawn again when the tilt changes), they are sharp at one zoom, and the atlas costs memory.
  const VS_IMP = `#version 300 es
  layout(location=0) in vec4 a_pos;      // x, y, z, scale
  layout(location=1) in vec4 a_cell;     // this view's rectangle in the impostor atlas
  layout(location=2) in vec4 a_how;      // the turn its normals need, lean x, lean y, the stack's height
  layout(location=3) in vec3 a_size;     // the sprite's width and height in world units, and how far under the base it starts
  layout(location=5) in vec2 a_corner;
  uniform mat4 u_vp; uniform vec3 u_right, u_up;
  out vec2 v_uv; out vec3 v_w; flat out vec4 v_cell, v_pos; flat out float v_rot;
  void main() {
    vec3 w = a_pos.xyz + (u_right * ((a_corner.x - 0.5) * a_size.x) + u_up * (a_corner.y * a_size.y - a_size.z)) * a_pos.w
           + vec3(a_how.yz, 0.0) * (a_corner.y * a_how.w * a_pos.w);                 // the top leans with the wind
    gl_Position = u_vp * vec4(w, 1.0); v_uv = a_corner * a_cell.zw; v_w = w; v_cell = a_cell; v_pos = a_pos; v_rot = a_how.x;
  }`;
  const IMP_FS = `
  uniform sampler2D u_i0, u_i1; uniform mat4 u_vp; uniform vec3 u_fwd;
  in vec2 v_uv; in vec3 v_w; flat in vec4 v_cell, v_pos; flat in float v_rot;
  // the sprite's pixel, the height it stood at when it was drawn, and from that its true depth
  bool sprite(out vec4 a, out float h) {
    ivec2 tc = ivec2(v_cell.xy) + ivec2(clamp(v_uv, vec2(0.0), v_cell.zw - 0.001));
    a = texelFetch(u_i0, tc, 0); if (a.r == 0.0) return false;
    vec4 b = texelFetch(u_i1, tc, 0);
    h = v_pos.z + (b.r * 65280.0 + b.g * 255.0) / 65535.0 * ${HMAX}.0 * v_pos.w;
    vec4 c = u_vp * vec4(v_w + u_fwd * ((v_w.z - h) / -u_fwd.z), 1.0);
    gl_FragDepth = c.z / c.w * 0.5 + 0.5; return true;
  }`;
  const FS_GIMP = `#version 300 es
  precision highp float;
  ${IMP_FS}
  layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
  ${ROWS_OUT}
  void main() {
    vec4 a; float hw; if (!sprite(a, hw)) discard;
    float c = cos(v_rot), s = sin(v_rot); vec3 n = a.gba * 2.0 - 1.0; n.xy = vec2(n.x * c - n.y * s, n.x * s + n.y * c);
    o0 = vec4(a.r, n * 0.5 + 0.5);
    float h = clamp(hw / ${HMAX}.0, 0.0, 1.0) * 65535.0, hi = floor(h / 256.0);
    o1 = vec4(hi / 255.0, (h - hi * 256.0) / 255.0, 0.0, 1.0);
    ROW_WRITE(0.0);
  }`;
  const FS_COUNTIMP = `#version 300 es
  precision highp float;
  ${IMP_FS}
  uniform int u_all; uniform float u_unit;
  out vec4 o;
  void main() {
    if (u_all == 1) { o = vec4(0.0, u_unit, 0.0, 0.0); gl_FragDepth = gl_FragCoord.z; return; }
    vec4 a; float hw; if (!sprite(a, hw)) discard;
    o = vec4(u_unit, 0.0, 0.0, 0.0);
  }`;
  const VS_FULL = `#version 300 es
  layout(location=5) in vec2 a_corner;
  out vec2 v_uv;
  void main() { v_uv = a_corner; gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0); }`;

  // The light pass. Everything here is worked out from three things per pixel (colour, facing, height) and one
  // small texture of the whole map (u_hm: the height of the tallest solid thing over every ground cell).
  const FS_LIGHT = `#version 300 es
  precision highp float;
  #define CONES_ON 0
  #define ROWS_ON 0
  #define GROUND_ON 0
  #define LIGHTMAP_ON 0
  #define HDR_ON 0
  #define RINGS_ON 0
  #define TWO_ON 0
  #define FILM_ON 0
  uniform sampler2D u_g0, u_g1, u_pal, u_hm, u_cone;
  uniform float u_falloff;    // 0: the lamps fall off as (1 - r / reach)^2; 1: windowed and steep near the source (opt.falloff)
  uniform vec4 u_qual;        // opt.quality: steps of a lamp's occlusion test, beam steps, the shadow walk's step scale, occlusion radius scale
  #if RINGS_ON
  uniform vec4 u_ring[${RINGS}], u_ringCol[${RINGS}]; uniform float u_ringGlow[${RINGS}]; uniform int u_nr;     // rings: x y z radius / r g b width / the band's own glow
  #endif
  #if GROUND_ON
  uniform sampler2D u_gm; uniform vec4 u_gmBox;     // the ground map, and where it lies: x0, y0, width, depth
  #endif
  #if LIGHTMAP_ON
  uniform sampler2D u_lm; uniform vec4 u_lmBox; uniform float u_lmK;     // the light map, where it lies, what 1.0 in it is worth
  #endif
  #if ROWS_ON
  uniform sampler2D u_g2;     // the palette row of each pixel
  #endif
  uniform highp sampler2D u_lt;  // the lights' table (float): a column per light, rows 0-2 point lights from the ninth on, rows 3-6 cones
  uniform vec4 u_lamp[8], u_lampCol[8]; uniform float u_lampHalo[8];   // the first eight point lights, as uniforms: the common case reads no texture
  uniform mat4 u_inv;
  uniform vec3 u_sun, u_sunCol, u_skyCol, u_bounceCol, u_hazeCol, u_outer, u_eye, u_fwd;
  uniform vec4 u_world;       // (unused xy), the level of open ground, the time in seconds
  uniform vec4 u_hmBox;       // the height map's place: x0, y0, width, depth; the edge of the map is its edge too
  uniform vec3 u_hmK;         // world height per step of a height map byte, the highest it can hold less a margin, U
  uniform vec4 u_hh;          // height haze: its density at the ground (per unit of distance), how fast it thins upward (0: off)
  // U (u_hmK.z) is the size of one art pixel in world units (opt.unit, 1 if not given): every distance written as
  // a number below is in art pixels and is multiplied by it, so a world in metres lights like one in art pixels.
  uniform vec4 u_fx;          // shadow softness (0: no shadows), occlusion strength, how far the lamps are lit, cloud shadows
  uniform vec4 u_view;        // the direction to the sun on screen (xy, pixels), where the haze starts, how deep it is
  uniform vec4 u_tone;        // exposure, haze strength, 1 for the perspective camera
  uniform vec4 u_walk;        // the shadow walk: steps, how much each grows, the longest, the reach
  uniform float u_dirs;       // ambient occlusion: directions sampled (8, or 4 at one distance for the low preset)
  uniform float u_water;      // the palette index of water
  uniform int u_nl, u_ns;     // how many point lights there are (all of them) and how many cones
  uniform float u_lampCap;    // 0: lights add up freely; above 0 their sum is rolled off per pixel (many lights, no white-out)
  uniform vec4 u_blob[${BLOBS}]; uniform float u_blobLow[${BLOBS}]; uniform int u_nblob;
  in vec2 v_uv; out vec4 o;

  float land(vec2 p) { return textureLod(u_hm, (p - u_hmBox.xy) / u_hmBox.zw, 0.0).r * u_hmK.x; }      // smoothed between cells
  // how far a point is clear of the land: above it, or (with a two-layer height map) under a floating crown
#if TWO_ON
  float clr(vec3 s) { vec2 h = textureLod(u_hm, (s.xy - u_hmBox.xy) / u_hmBox.zw, 0.0).rg * u_hmK.x; return max(s.z - h.x, h.y - s.z); }
#else
  float clr(vec3 s) { return s.z - land(s.xy); }
#endif
  float height(ivec2 px) { vec4 g = texelFetch(u_g1, clamp(px, ivec2(0), textureSize(u_g1, 0) - 1), 0); return (g.r * 65280.0 + g.g * 255.0) / 65535.0 * ${HMAX}.0; }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
  // The country beyond the map, which no stack covers: a patchwork of fields with hedges between them, made up
  // on the spot from noise. It is flat and it is soon lost in the haze; it only has to stop the map from
  // ending at a ruled edge.
  vec3 beyond(vec2 p) {
    vec2 w = (p + 40.0 * vec2(vnoise(p * 0.009), vnoise(p * 0.009 + 7.3))) / 118.0, c = floor(w), f = fract(w);
    float k = hash(c), e = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * 118.0;
    vec3 col = u_outer * (k < 0.45 ? vec3(1.0) : k < 0.68 ? vec3(1.28, 1.1, 0.8) : k < 0.84 ? vec3(1.06, 0.84, 0.7) : vec3(0.9, 0.97, 0.85));
    return mix(u_outer * 0.7, col, smoothstep(1.0, 3.2, e)) * (0.9 + 0.2 * vnoise(p * 0.11));
  }
  // Tone curve and grade. The curve leaves dark and middle tones alone and rolls bright ones off towards white
  // instead of clipping them. The grade adds a little saturation, warms the highlights and cools the shadows.
  vec3 finish(vec3 c) {
#if HDR_ON
    return max(c, vec3(0.0));                               // HDR: linear light, the curve is applied after bloom (FS_POST)
#endif
    c = 1.0 - exp(-pow(max(c * u_tone.x, 0.0), vec3(1.25)) * 1.7);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.16);
    c += vec3(0.022, 0.006, -0.022) * smoothstep(0.4, 1.0, l) + vec3(-0.014, 0.0, 0.022) * (1.0 - smoothstep(0.0, 0.45, l));
    return clamp(c, 0.0, 1.0);
  }
#if CONES_ON
  // CONES. Table rows per cone k: 3 origin and range, 4 axis and cos(half angle), 5 colour and beam strength,
  // 6 the yaw and half width of its shadow table. How much of cone k reaches a point s (and how far it is):
  // a soft edge, a linear falloff to the range, a brighter core.
  float spotOf(vec4 S, vec4 D, vec3 s, out float dist) {
    vec3 v = s - S.xyz; dist = length(v); if (dist > S.w || dist < 0.01) return 0.0;
    float c = dot(v / dist, D.xyz), ch = D.w;
    return smoothstep(ch, ch + (1.0 - ch) * 0.35, c) * (1.0 - dist / S.w) * (0.55 + 0.45 * smoothstep(ch + (1.0 - ch) * 0.5, 1.0, c));
  }
  // A cone's shadow table (u_cone): one row per cone, one bin per angle round its light as seen from above. A bin
  // holds the distance to the first blocker that way (16 bits, as a share of the range) and how tall it is (8 bits,
  // of ${HMAX}). Behind a blocker a point is lit only above the line from the light over the blocker's top. Two
  // bins are mixed so the edge of a post's wedge is not a stair.
  float coneBin(int k, int b, vec4 S, vec3 s, float d) {
    vec4 t = texelFetch(u_cone, ivec2(clamp(b, 0, ${BINS - 1}), k), 0);
    float bd = (t.r * 65280.0 + t.g * 255.0) / 65535.0 * S.w, bh = t.b * ${HMAX}.0;
    if (d < bd + S.w * 0.004) return 1.0;
    float lz = S.z + (bh - S.z) * d / max(bd, S.w * 0.001);
    return clamp((s.z - lz) / max(S.w * 0.02, 0.01) + 0.5, 0.0, 1.0);
  }
  float coneShadow(int k, vec4 S, vec4 X, vec3 s) {
    if (X.z < 0.5) return 1.0;                               // no table for this cone
    vec2 h = s.xy - S.xy; float d = length(h);
    if (d < 0.01) return 1.0;
    float a = atan(h.y, h.x + 1e-5) - X.x; a = mod(a + 3.14159265, 6.2831853) - 3.14159265;
    float f = (a / max(X.y, 0.01) * 0.5 + 0.5) * ${BINS}.0 - 0.5;
    if (f < -1.0 || f > ${BINS}.0) return 1.0;
    float i = floor(f); int b = int(i);
    return mix(coneBin(k, b, S, s, d), coneBin(k, b + 1, S, s, d), f - i);
  }
#endif
  // One point light at p. L: position and reach. C: colour and occlusion (1: test the height map between the light
  // and the pixel, seven steps). hk: the halo's strength. The halo is the light scattered in the air: where the view
  // ray passes closest to the light.
  void lamp(vec4 L, vec4 C, float hk, vec3 p, vec3 n, vec3 ray, float dist, inout vec3 irr, inout vec3 halo) {
    vec3 d3 = L.xyz - p; float r = length(d3);
    if (r < L.w) {
      float att = 1.0 - r / L.w, occ = 1.0;
      if (u_falloff > 0.5) { float x = r * r / (L.w * L.w), win = (1.0 - x) * (1.0 - x); att = sqrt(win * win / (1.0 + r * r / max(L.w * L.w * 0.02, 1e-4))); }      // (squared below)
      if (C.w > 0.5) {
        vec3 q = p + vec3(n.xy * (3.5 * u_hmK.z), 1.3 * u_hmK.z), e = L.xyz - q;   // start off the surface, as the sun's walk does
        for (int k = 1; k < 32; k++) { if (float(k) >= u_qual.x) break; vec3 s = q + e * (float(k) / u_qual.x); occ = min(occ, clamp((s.z - land(s.xy)) * 0.5 / u_hmK.z + 0.5, 0.0, 1.0)); }
      }
      irr += C.rgb * att * att * occ * (0.3 + 0.7 * max(dot(n, d3 / max(r, 0.001)), 0.0));
    }
    if (hk > 0.0) {
      float tt = clamp(dot(L.xyz - u_eye, ray), 0.0, dist), hr = L.w * 0.45, dp = length(u_eye + ray * tt - L.xyz);
      if (dp < hr) { float q = 1.0 - dp / max(hr, 0.001); halo += C.rgb * hk * q * q * q; }
    }
  }
  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy);
    vec4 g0 = texelFetch(u_g0, px, 0);
    bool outer = g0.r == 0.0;                               // nothing was drawn here: open ground beyond the map
    float h = outer ? u_world.z : height(px);
    // the world position: where this pixel's view ray meets the plane at the stored height
    vec2 ndc = v_uv * 2.0 - 1.0; vec4 a = u_inv * vec4(ndc, -1.0, 1.0), b = u_inv * vec4(ndc, 1.0, 1.0); a /= a.w; b /= b.w;
    float fall = b.z - a.z; bool level = fall > -0.0001;    // a ray that does not come down (voxel mode lets the camera look along the ground)
    if (outer && (level || (h - a.z) / fall > 1.0)) { o = vec4(finish(mix(u_hazeCol, u_hazeCol * 0.86 + u_skyCol * 0.3, clamp(normalize(b.xyz - a.xyz).z * 4.0, 0.0, 1.0))), 0.0); return; }      // sky
    vec3 p = mix(a.xyz, b.xyz, (h - a.z) / (abs(fall) < 0.0001 ? -0.0001 : fall));
    // A ray that runs nearly level meets a height at no definite place. Voxel mode stores the distance in front of
    // the camera for that case (perspective only: the parallel camera's rays all slope alike).
    vec3 ray = normalize(b.xyz - a.xyz); vec4 g1 = texelFetch(u_g1, px, 0);
    if (!outer && u_tone.z > 0.5 && abs(ray.z) < 0.06 && g1.b + g1.a > 0.0) p = u_eye + ray * ((g1.b * 65280.0 + g1.a * 255.0) / 65535.0 * 4096.0 / dot(ray, u_fwd));
    float t = u_world.w, U = u_hmK.z;

    // The edge of the map dissolves into haze: no hard border, and things driving off it fade out.
    vec2 over = max(u_hmBox.xy - p.xy, p.xy - (u_hmBox.xy + u_hmBox.zw));
    float fade = smoothstep(-24.0 * U, 92.0 * U, length(max(over, 0.0)) + min(max(over.x, over.y), 0.0) + (vnoise(p.xy / U * 0.012) - 0.5) * (30.0 * U));
    if (fade > 0.995) { o = vec4(finish(u_hazeCol), 0.0); return; }

#if ROWS_ON
    vec4 pal = texelFetch(u_pal, ivec2(int(g0.r * 255.0 + 0.5), int(texelFetch(u_g2, px, 0).r * 255.0 + 0.5)), 0);
#else
    vec4 pal = texelFetch(u_pal, ivec2(int(g0.r * 255.0 + 0.5), 0), 0);
#endif
    vec3 alb = outer ? mix(beyond(p.xy / U), u_outer, smoothstep(0.1, 0.5, fade)) : pal.rgb;      // the made-up fields lose their detail first
    vec3 n = outer ? vec3(0.0, 0.0, 1.0) : normalize(g0.gba * 2.0 - 1.0);
    float glow = outer ? 0.0 : pal.a;
#if GROUND_ON
    // THE GROUND MAP: open ground inside its box takes its colour from it, a texel per cell: two palette indices
    // and how far the first has worn towards the second (tracks, scorch, glassed slag are texel writes).
    if (outer) {
      vec2 gu = (p.xy - u_gmBox.xy) / u_gmBox.zw;
      if (gu.x >= 0.0 && gu.y >= 0.0 && gu.x < 1.0 && gu.y < 1.0) {
        ivec2 gs = textureSize(u_gm, 0); vec4 gm = texelFetch(u_gm, clamp(ivec2(gu * vec2(gs)), ivec2(0), gs - 1), 0);
        vec4 ga = texelFetch(u_pal, ivec2(int(gm.r * 255.0 + 0.5), 0), 0), gb = texelFetch(u_pal, ivec2(int(gm.g * 255.0 + 0.5), 0), 0), gc = mix(ga, gb, gm.b);
        alb = gc.rgb; glow = gc.a;
      }
    }
#endif
    bool wet = !outer && abs(g0.r * 255.0 - u_water) < 1.5;
    if (wet) {                                              // water: ripples that drift, one art pixel each
      vec2 q = floor(p.xy / U);
      n = normalize(vec3(vnoise(q * 0.45 + vec2(t * 0.7, t * 1.1)) - 0.5, vnoise(q * 0.8 - vec2(t * 0.9, t * 0.4)) - 0.5, 1.6));
    }

    // Soft shadows. Walk from the pixel towards the sun over the height map, in steps that grow (1.3 units at
    // first, 4.6 at most), and keep the smallest clearance over the land, measured against the distance walked:
    // a ray that only just clears a roof far away is in the penumbra, so shadows are sharp at the foot of a wall
    // and soft at their tips. The walk ends after ${REACH} units; shadows fade out there instead of stopping dead.
    float sh = 1.0;
    if (u_fx.x > 0.0) {
      vec3 q = p + vec3(n.xy * (3.5 * U), 1.3 * U);           // start off the surface (and clear of the eaves)
      // (every art pixel takes steps of a slightly different length, which turns the banding of a coarse walk into
      // a fine dither that stays put on the ground)
      float d = 0.0, ds = 1.3 * U * u_qual.z, jit = 0.78 + 0.44 * hash(floor(p.xy / U) + floor(p.z / U) * 7.31);
      for (int i = 0; i < 160; i++) {
        if (float(i) >= u_walk.x) break;
        d += ds * jit; ds = min(ds * u_walk.y, u_walk.z);
        vec3 s = q + u_sun * d;
        sh = min(sh, mix(clamp(clr(s) / (u_fx.x * d), 0.0, 1.0), 1.0, smoothstep(u_walk.w * 0.7, u_walk.w, d)));
        if (sh <= 0.0 || s.z > u_hmK.y) break;
      }
      sh = sh * sh * (3.0 - 2.0 * sh);
      // Moving things are not in the height map. Each is an upright cylinder (soldiers, the jeep) or a blob in
      // the air (smoke, birds): the ray to the sun is tested against its axis.
      for (int i = 0; i < ${BLOBS}; i++) {
        if (i >= u_nblob) break;
        vec4 B = u_blob[i]; vec2 dd = B.xy - p.xy; float k = dot(dd, u_sun.xy) / dot(u_sun.xy, u_sun.xy);
        if (k > 0.5) {
          float z = p.z + u_sun.z * k, r = length(dd - u_sun.xy * k);
          sh *= 1.0 - 0.72 * smoothstep(B.w * 1.2, B.w * 0.5, r) * smoothstep(u_blobLow[i] - 1.5 * U, u_blobLow[i] + 0.5 * U, z) * (1.0 - smoothstep(B.z - 0.5 * U, B.z + 1.5 * U, z));
        }
      }
      // cloud shadows: two layers of slow noise sliding over the land
      vec2 pu = p.xy / U; float cl = vnoise(pu * 0.0058 + t * vec2(0.045, 0.028)) * 0.65 + vnoise(pu * 0.017 - t * vec2(0.02, 0.05)) * 0.35;
      sh *= 1.0 - u_fx.w * smoothstep(0.5, 0.78, cl);
    }

    // Ambient occlusion from the height map: look round the pixel at two distances and see how much of the
    // land there rises above it. A corner between ground and wall, or the ground under a hedge, gets less of
    // the sky. Walls are sampled out in front of themselves, and darken a little towards their foot (contact).
    float ao = 1.0;
    if (u_fx.y > 0.0) {
      vec2 c0 = p.xy + n.xy * (3.0 * U); float occ = 0.0, UR = U * u_qual.w;
      for (int i = 0; i < 16; i++) {
        if (float(i) >= u_dirs) break;
        float an = float(i) * 6.2832 / u_dirs + 0.4; vec2 dir = vec2(cos(an), sin(an));
        if (u_dirs > 4.5) occ += clamp((land(c0 + dir * (2.5 * UR)) - p.z - U) / (2.5 * UR), 0.0, 1.0) * 0.55 + clamp((land(c0 + dir * (7.5 * UR)) - p.z - U) / (7.5 * UR), 0.0, 1.0) * 0.45;
        else occ += clamp((land(c0 + dir * (4.5 * UR)) - p.z - U) / (4.5 * UR), 0.0, 1.0);
      }
      ao = 1.0 - occ / u_dirs;
      if (n.z < 0.6) ao *= mix(0.68, 1.0, smoothstep(0.0, 7.0 * U, p.z - land(p.xy + n.xy * (4.5 * U))));
      ao = mix(1.0, max(ao, 0.25), u_fx.y);
    }

    // The fill: instead of one flat ambient colour, cool light from the sky on what faces up and warm light
    // bounced off the earth on what faces down, blended by the facing (hemisphere lighting).
    vec3 fill = mix(u_bounceCol, u_skyCol, n.z * 0.5 + 0.5);
    // Bounce: a wall in shade is still lit by the sunlit ground and walls across from it. A cheap stand-in for
    // that: warm light arriving level, strongest on the side turned away from the sun.
    fill += u_bounceCol * (1.0 - n.z * n.z) * (0.3 + 0.7 * max(0.0, -dot(n.xy, normalize(u_sun.xy))));
    // The key: a warm sun.
    float nl = max(dot(n, u_sun), 0.0);
    vec3 light = fill * ao + u_sunCol * nl * sh;
    // Rim: where the next pixel towards the sun is much lower, this pixel is a sunward edge, and catches light.
    if (!outer) {
      float drop = h - height(px + ivec2(floor(u_view.xy + 0.5)));
      light += u_sunCol * smoothstep(3.0 * U, 9.0 * U, drop) * 0.3 * (0.25 + 0.75 * sh);
    }
    vec3 col = alb * light;
    if (wet) {                                              // water also mirrors the sky and glints
      vec3 v = normalize(u_eye - p), hv = normalize(u_sun + v);
      col = col * 0.75 + u_skyCol * 0.3 + u_sunCol * pow(max(dot(n, hv), 0.0), 120.0) * sh;
    }
    // POINT LIGHTS: they fall off to nothing at their reach. The first eight are uniforms (a loop the compiler can
    // unroll, as cheap as it always was); the rest are read from the table: rows 0 position and reach, 1 colour and
    // occlusion, 2 the halo.
    vec3 irr = vec3(0.0), halo = vec3(0.0); float dist = length(p - u_eye);
    for (int i = 0; i < 8; i++) { if (u_lamp[i].w > 0.0) lamp(u_lamp[i], u_lampCol[i], u_lampHalo[i], p, n, ray, dist, irr, halo); }
    for (int i = 8; i < ${LIGHTS}; i++) {
      if (i >= u_nl) break;
      lamp(texelFetch(u_lt, ivec2(i, 0), 0), texelFetch(u_lt, ivec2(i, 1), 0), texelFetch(u_lt, ivec2(i, 2), 0).x, p, n, ray, dist, irr, halo);
    }
    // CONE LIGHTS: the pool where the beam lands, and the beam in the air, marched in 12 steps along the part of the
    // view ray inside the cone's bounding sphere (each pixel starts its steps at a different offset). Compiled only
    // into the second build of this shader, used while there are cones: the first stays as light as before.
    vec3 beam = vec3(0.0);
#if CONES_ON
    for (int k = 0; k < ${CONES}; k++) {
      if (k >= u_ns) break;
      vec4 S = texelFetch(u_lt, ivec2(k, 3), 0), D = texelFetch(u_lt, ivec2(k, 4), 0), K = texelFetch(u_lt, ivec2(k, 5), 0), X = texelFetch(u_lt, ivec2(k, 6), 0);
      float dd, s0 = spotOf(S, D, p, dd);
      if (s0 > 0.0) irr += K.rgb * s0 * coneShadow(k, S, X, p) * (0.35 + 0.65 * max(dot(n, (S.xyz - p) / max(dd, 0.01)), 0.0));
      if (K.w > 0.0) {
        vec3 cc = S.xyz + D.xyz * S.w * 0.5;
        float sn = sqrt(max(1.0 - D.w * D.w, 0.0)), rs = S.w * (0.5 + sn / max(D.w, 0.2) * 0.9);
        vec3 oc = u_eye - cc; float bq = dot(oc, ray), disc = bq * bq - (dot(oc, oc) - rs * rs);
        if (disc > 0.0) {
          float sq = sqrt(disc), t0 = max(-bq - sq, 0.0), t1 = min(-bq + sq, dist);
          if (t1 > t0) {
            float ds = (t1 - t0) / u_qual.y, jit = hash(vec2(px) + float(k) * 13.7), acc = 0.0;
            for (int i = 0; i < 64; i++) { if (float(i) >= u_qual.y) break; float sd; vec3 s = u_eye + ray * (t0 + (float(i) + jit) * ds); float sp = spotOf(S, D, s, sd); if (sp > 0.0) acc += sp * coneShadow(k, S, X, s); }
            beam += K.rgb * K.w * acc * ds / max(S.w, 0.01);
          }
        }
      }
    }
#endif
#if LIGHTMAP_ON
    // THE LIGHT MAP: light that does not move (lamp masts, windows, a glowing pool) painted once into a world-space
    // texture, any number of lights for one read
    vec2 lu = (p.xy - u_lmBox.xy) / u_lmBox.zw;
    if (lu.x >= 0.0 && lu.y >= 0.0 && lu.x <= 1.0 && lu.y <= 1.0) irr += textureLod(u_lm, lu, 0.0).rgb * u_lmK;
#endif
#if RINGS_ON
    // RING LIGHTS: a band of light round a centre (an expanding pulse). What is in the band and near its height is
    // lit, faces turned towards the band's middle line most; the band itself can also shine (its glow), so it reads
    // on ground that is black.
    vec3 ringE = vec3(0.0);
    for (int i = 0; i < ${RINGS}; i++) {
      if (i >= u_nr) break;
      vec4 G = u_ring[i], C = u_ringCol[i]; vec2 dv = p.xy - G.xy; float r = length(dv), w = max(C.w, 1e-3);
      float d = (r - G.w) / w, band = exp(-d * d * 2.0) * exp(-max(p.z - G.z, 0.0) / (w * 2.0));
      if (band < 0.002) continue;
      vec3 toMid = vec3(-dv / max(r, 1e-3) * sign(d), 0.6); toMid = toMid / max(length(toMid), 1e-4);
      irr += C.rgb * band * (0.35 + 0.65 * max(dot(n, toMid), 0.0));
      ringE += C.rgb * u_ringGlow[i] * band * band;
    }
#endif
    if (u_lampCap > 0.0) irr = irr / (1.0 + max(irr.r, max(irr.g, irr.b)) * u_lampCap);
    col += alb * irr;
    // Pixels that shine. A glow of 1 in the palette always shines (fire). A smaller glow is a lamp or a window:
    // dull by day, and lit as dusk falls. The amount goes out in alpha, and the bloom pass spreads it.
    float e = glow > 0.98 ? 1.0 : glow * u_fx.z;
    if (glow > 0.0) { if (glow <= 0.98) col *= 0.45; col = mix(col, alb * 1.7, e); }

    // Haze: things further into the picture take on the colour of the air.
    float hz = clamp((dot(p - u_eye, u_fwd) - u_view.z) / u_view.w, 0.0, 1.0);
    col = mix(col, u_hazeCol, hz * hz * u_tone.y * (1.0 - e));
    // Height haze (off unless asked for): dense at the ground, thinning upward, integrated exactly along the view ray
    if (u_hh.x > 0.0) {
      float dz = u_eye.z - p.z, k = max(u_hh.y, 1e-4), ze = max(u_eye.z, 0.0), zp = max(p.z, 0.0);
      float od = abs(dz) > 0.01 ? u_hh.x * dist * (exp(-zp * k) - exp(-ze * k)) / (dz * k) : u_hh.x * dist * exp(-zp * k);
      col = mix(col, u_hazeCol, (1.0 - exp(-max(od, 0.0))) * (1.0 - e * 0.6));
    }
    col = mix(col, u_hazeCol, fade);
    // the lights' halos and the beams are in the air in front of the surface: after the haze, each rolled off so a
    // beam seen down its length cannot white the frame out
    halo = halo / (1.0 + max(halo.r, max(halo.g, halo.b)) * 0.8); beam = beam / (1.0 + max(beam.r, max(beam.g, beam.b)) * 1.2);
    col += (halo + beam) * (1.0 - fade);
#if RINGS_ON
    col += ringE * (1.0 - fade);
#endif
#if FILM_ON
    o = vec4(finish(col), dist);                           // the film post: the view distance, for the depth of field
#else
    o = vec4(finish(col), e * (1.0 - fade));
#endif
  }`;
  // ================================================================ THE NIGHT LIGHT MODEL (light.model 'night')
  // A second light pass, for scenes lit by a low moon and the lights people carry. Same G-buffer, different light:
  //   moon      the key is a low, cool moon, its shadows walked over the height map (with a two-layer map, a tree's
  //             crown floats over open air and the moon gets in under it), a wide penumbra, then smoothed
  //   fill      a hemisphere of sky above and earth below, both dim; occlusion from the height map, and a canopy
  //             (land overhead) takes sky away
  //   contact   up to 8 soft dark pools under figures that are not in the height map (opt.contacts)
  //   rim       a silhouette edge (the next pixel up the screen, or across towards the moon, lies well behind this
  //             one) catches the moon and the warm lights round it: a one-pixel bright outline
  //   lamps     point lights with a windowed falloff (or the day model's, with opt.falloff), occlusion, a soft cap,
  //             a glint on wet ground, and a halo in the haze that scales with the haze where the light hangs
  //   cones     a pool and a beam marched through the haze, cut by the cone's shadow table
  //   haze      exponential height fog, thick at the ground and thinning upward, integrated exactly along the view
  //             ray, clear near the eye; it takes a little moonlight towards the moon
  //   glow      palette glow is emissive and only partly dimmed by the haze, so eyes and lamps read far into it
  //   floor     where no slice was drawn: a game's own floor function (light.floor, GLSL), else the ground map,
  //             else a flat colour
  // Every number below that is a distance is in metres for a scene with an art pixel of a tenth of a metre, and
  // is scaled by KM (ten times opt.unit), so it holds at any scale. Its output is linear light (it needs, and
  // turns on, the half-float picture) with the view distance in alpha, for the depth of field (opt.post).
  const FS_NIGHT = `#version 300 es
  precision highp float;
  #define CONES_ON 0
  #define ROWS_ON 0
  #define GROUND_ON 0
  #define LIGHTMAP_ON 0
  #define RINGS_ON 0
  #define TWO_ON 0
  #define FLOOR_ON 0
  uniform sampler2D u_g0, u_g1, u_pal, u_hm, u_cone;
  uniform highp sampler2D u_lt;
  uniform vec4 u_lamp[8], u_lampCol[8]; uniform float u_lampHalo[8];
  uniform int u_nl, u_ns; uniform float u_lampCap, u_falloff;
  #if ROWS_ON
  uniform sampler2D u_g2;
  #endif
  #if GROUND_ON
  uniform sampler2D u_gm; uniform vec4 u_gmBox;
  #endif
  #if LIGHTMAP_ON
  uniform sampler2D u_lm; uniform vec4 u_lmBox; uniform float u_lmK;
  #endif
  #if RINGS_ON
  uniform vec4 u_ring[${RINGS}], u_ringCol[${RINGS}]; uniform float u_ringGlow[${RINGS}]; uniform int u_nr;
  #endif
  uniform mat4 u_inv;
  uniform vec3 u_eye, u_fwd, u_moon, u_moonCol, u_skyCol, u_earthCol, u_fogCol, u_floorCol;
  uniform vec4 u_fog;         // haze: density at the ground (per unit of distance), how fast it thins upward (per unit), moon in the haze, (unused)
  uniform vec4 u_hmBox;       // the height map's place: x0, y0, width, depth
  uniform vec3 u_hmK;         // world height per step of a byte, the highest it can hold less a margin, opt.unit
  uniform vec4 u_q;           // moon shadow steps (0: none), occlusion on, beams on, glow strength
  uniform vec4 u_look;        // the haze starts this far from the eye, rim strength, (free), the warm lights' share of the rim
  uniform vec4 u_contact[${CONTACTS}]; uniform int u_ncontact;     // contact shadows: x, y, radius, strength
  uniform vec4 u_qual;        // opt.quality: steps of a lamp's occlusion test, beam steps, the moon walk's step scale, occlusion radius scale
  uniform vec4 u_qual2;       // the moon walk's growth per step, occlusion directions, penumbra scale
  uniform float u_time, u_ground;
  in vec2 v_uv; out vec4 o;

  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f); return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y); }
  float height(ivec2 px) { vec4 g = texelFetch(u_g1, clamp(px, ivec2(0), textureSize(u_g1, 0) - 1), 0); return (g.r * 65280.0 + g.g * 255.0) / 65535.0 * ${HMAX}.0; }
  // the height map at a point: x the top of the tallest thing, y the bottom of its highest solid run (0 with one layer)
  vec2 hm(vec2 p) {
    vec2 uv = (p - u_hmBox.xy) / u_hmBox.zw; if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(0.0);
  #if TWO_ON
    return textureLod(u_hm, uv, 0.0).rg * u_hmK.x;
  #else
    return vec2(textureLod(u_hm, uv, 0.0).r * u_hmK.x, 0.0);
  #endif
  }
  // how far a point is clear of the solid there (negative inside it): above the top, or under a floating crown
  float clearOf(vec3 s) { vec2 h = hm(s.xy); return max(s.z - h.x, h.y - s.z); }
  float fogAt(float z) { return u_fog.x * exp(-max(z, 0.0) * u_fog.y); }
  // where another internal pixel of this frame lies in the world (its stored height on its own view ray); sky: far away
  vec3 worldAt(ivec2 q) {
    ivec2 S = textureSize(u_g0, 0); q = clamp(q, ivec2(0), S - 1);
    bool gq = texelFetch(u_g0, q, 0).r == 0.0; float hq = gq ? u_ground : height(q);
    vec2 nd = (vec2(q) + 0.5) / vec2(S) * 2.0 - 1.0;
    vec4 a = u_inv * vec4(nd, -1.0, 1.0), b = u_inv * vec4(nd, 1.0, 1.0); a /= a.w; b /= b.w;
    float fz = b.z - a.z; vec3 rq = normalize(b.xyz - a.xyz + vec3(0.0, 0.0, 1e-6));
    vec4 g1q = texelFetch(u_g1, q, 0);
    if (!gq && abs(rq.z) < 0.3 && g1q.b + g1q.a > 0.0) return u_eye + rq * ((g1q.b * 65280.0 + g1q.a * 255.0) / 65535.0 * 4096.0 / max(dot(rq, u_fwd), 0.05));
    if (gq && (fz > -0.0001 || (hq - a.z) / fz > 1.0)) return u_eye + rq * 9999.0;
    return mix(a.xyz, b.xyz, (hq - a.z) / (abs(fz) < 0.0001 ? -0.0001 : fz));
  }
  #if CONES_ON
  float spotOf(vec4 S, vec4 D, vec3 s, out float dist) {
    vec3 v = s - S.xyz; dist = length(v); if (dist > S.w || dist < 0.01) return 0.0;
    float c = dot(v / dist, D.xyz), ch = D.w;
    return smoothstep(ch, ch + (1.0 - ch) * 0.35, c) * (1.0 - dist / S.w) * (0.55 + 0.45 * smoothstep(ch + (1.0 - ch) * 0.5, 1.0, c));
  }
  float coneBin(int k, int b, vec4 S, vec3 s, float d) {
    vec4 t = texelFetch(u_cone, ivec2(clamp(b, 0, ${BINS - 1}), k), 0);
    float bd = (t.r * 65280.0 + t.g * 255.0) / 65535.0 * S.w, bh = t.b * ${HMAX}.0;
    if (d < bd + S.w * 0.004) return 1.0;
    float lz = S.z + (bh - S.z) * d / max(bd, S.w * 0.001);
    return clamp((s.z - lz) / max(S.w * 0.02, 0.01) + 0.5, 0.0, 1.0);
  }
  float coneShadow(int k, vec4 S, vec4 X, vec3 s) {
    if (X.z < 0.5) return 1.0;
    vec2 h = s.xy - S.xy; float d = length(h);
    if (d < 0.01) return 1.0;
    float a = atan(h.y, h.x + 1e-5) - X.x; a = mod(a + 3.14159265, 6.2831853) - 3.14159265;
    float f = (a / max(X.y, 0.01) * 0.5 + 0.5) * ${BINS}.0 - 0.5;
    if (f < -1.0 || f > ${BINS}.0) return 1.0;
    float i = floor(f); int b = int(i);
    return mix(coneBin(k, b, S, s, d), coneBin(k, b + 1, S, s, d), f - i);
  }
  #endif
  #if FLOOR_ON
  // a game's floor (light.floor). To hand: hash, vnoise, u_time, u_floor[8] (light.floorParams) and groundTexel(p)
  // (the ground map's raw texel there: palette index A, B, wear, spare; all 0 without a ground map)
  uniform vec4 u_floor[8];
  vec4 groundTexel(vec2 p) {
  #if GROUND_ON
    vec2 gu = (p - u_gmBox.xy) / u_gmBox.zw;
    if (gu.x >= 0.0 && gu.y >= 0.0 && gu.x < 1.0 && gu.y < 1.0) { ivec2 gs = textureSize(u_gm, 0); return texelFetch(u_gm, clamp(ivec2(gu * vec2(gs)), ivec2(0), gs - 1), 0); }
  #endif
    return vec4(0.0);
  }
  FLOOR_SOURCE
  #endif
  // one point light (see the day model's lamp for the layout)
  void lamp(vec4 L, vec4 C, float hk, vec3 p, vec3 n, vec3 ray, float dist, float wet, float KM, inout vec3 irr, inout vec3 warm, inout vec3 spec, inout vec3 halo) {
    vec3 d3 = L.xyz - p; float r2 = dot(d3, d3), R2 = L.w * L.w;
    if (r2 < R2) {
      float r = sqrt(r2), att;
      if (u_falloff > 0.5) { float x = r2 / R2, win = (1.0 - x) * (1.0 - x); att = win * win / (1.0 + r2 / max(R2 * 0.02, 0.01 * KM * KM)); }   // windowed, steep near the source
      else { float a = 1.0 - r / L.w; att = a * a; }
      float lam = u_falloff > 0.5 ? 0.22 + 0.78 * max(dot(n, d3 / max(r, 0.001)), 0.0) : 0.3 + 0.7 * max(dot(n, d3 / max(r, 0.001)), 0.0);
      float occ = 1.0;
      if (C.w > 0.5 && r > 0.4 * KM) { for (int k = 1; k < 32; k++) { if (float(k) >= u_qual.x) break; vec3 s = p + d3 * (float(k) / u_qual.x); occ = min(occ, clamp(clearOf(s) * 2.5 / KM + 0.35, 0.0, 1.0)); } }
      irr += C.rgb * att * lam * occ; warm += C.rgb * att * occ;
      if (wet > 0.0) { vec3 hv = normalize(d3 / max(r, 0.001) - ray); spec += C.rgb * att * occ * pow(max(dot(n, hv), 0.0001), wet > 0.5 ? 70.0 : 18.0) * (wet > 0.5 ? 0.8 : 0.5 * wet); }
    }
    if (hk > 0.0) {
      float tt = clamp(dot(L.xyz - u_eye, ray), 0.0, dist), dp = length(u_eye + ray * tt - L.xyz), hr = L.w * 0.45;
      if (dp < hr) { float q = 1.0 - dp / max(hr, 0.001); halo += C.rgb * hk * fogAt(L.z) * q * q * hr * 0.09 / (dp + 0.3 * KM + hr * 0.02); }
    }
  }

  void main() {
    ivec2 px = ivec2(gl_FragCoord.xy); float KM = u_hmK.z * 10.0;
    vec4 g0 = texelFetch(u_g0, px, 0);
    bool ground = g0.r == 0.0;
    float h = ground ? u_ground : height(px);
    vec2 ndc = v_uv * 2.0 - 1.0; vec4 a = u_inv * vec4(ndc, -1.0, 1.0), b = u_inv * vec4(ndc, 1.0, 1.0); a /= a.w; b /= b.w;
    vec3 seg = b.xyz - a.xyz; vec3 ray = seg / max(length(seg), 1e-6);
    float fall = seg.z;
    if (ground && (fall > -0.0001 || (h - a.z) / fall > 1.0)) {      // the sky
      float up = clamp(ray.z * 3.0, 0.0, 1.0), m = max(dot(ray, u_moon), 0.0);
      vec3 sky = mix(u_fogCol * 1.15, u_skyCol * 0.5, up) + u_moonCol * (pow(max(m, 1e-4), 64.0) * 0.5 + pow(max(m, 1e-4), 6.0) * 0.08);
      o = vec4(sky, 999.0); return;
    }
    vec3 p = mix(a.xyz, b.xyz, (h - a.z) / (abs(fall) < 0.0001 ? -0.0001 : fall));
    vec4 g1 = texelFetch(u_g1, px, 0);
    if (!ground && abs(ray.z) < 0.06 && g1.b + g1.a > 0.0) p = u_eye + ray * ((g1.b * 65280.0 + g1.a * 255.0) / 65535.0 * 4096.0 / max(dot(ray, u_fwd), 0.05));
    float dist = length(p - u_eye);

    vec3 alb, n = vec3(0.0, 0.0, 1.0); float glow = 0.0, wet = 0.0;
    if (ground) {
  #if FLOOR_ON
      alb = floorAt(p.xy, n, wet, glow);
  #else
      alb = u_floorCol;
    #if GROUND_ON
      vec2 gu = (p.xy - u_gmBox.xy) / u_gmBox.zw;
      if (gu.x >= 0.0 && gu.y >= 0.0 && gu.x < 1.0 && gu.y < 1.0) {
        ivec2 gs = textureSize(u_gm, 0); vec4 gm = texelFetch(u_gm, clamp(ivec2(gu * vec2(gs)), ivec2(0), gs - 1), 0);
        vec4 gc = mix(texelFetch(u_pal, ivec2(int(gm.r * 255.0 + 0.5), 0), 0), texelFetch(u_pal, ivec2(int(gm.g * 255.0 + 0.5), 0), 0), gm.b);
        alb = gc.rgb; glow = gc.a;
      }
    #endif
  #endif
    } else {
  #if ROWS_ON
      vec4 pal = texelFetch(u_pal, ivec2(int(g0.r * 255.0 + 0.5), int(texelFetch(u_g2, px, 0).r * 255.0 + 0.5)), 0);
  #else
      vec4 pal = texelFetch(u_pal, ivec2(int(g0.r * 255.0 + 0.5), 0), 0);
  #endif
      alb = pal.rgb; glow = pal.a;
      vec3 nn = g0.gba * 2.0 - 1.0; n = nn / max(length(nn), 1e-4);
    }
    n = n / max(length(n), 1e-4);

    // the moon's shadow: walk towards it over the height map, steps from 0.12 m growing to 1 m, a wide penumbra
    float sh = 1.0;
    if (u_q.x > 0.0) {
      vec3 q = p + n * (0.06 * KM) + vec3(0.0, 0.0, 0.04 * KM);
      float d = 0.0, ds = 0.12 * KM * u_qual.z;
      for (int i = 0; i < 160; i++) {
        if (float(i) >= u_q.x) break;
        d += ds; ds = min(ds * u_qual2.x, KM * u_qual.z);
        vec3 s = q + u_moon * d;
        if (s.z > u_hmK.y) break;
        sh = min(sh, clamp(clearOf(s) / ((0.11 * d + 0.05 * KM) * u_qual2.z), 0.0, 1.0));
        if (sh <= 0.0) break;
      }
      sh = sh * sh * (3.0 - 2.0 * sh);
    }
    // occlusion: land that rises close round the pixel takes sky away; land overhead (a canopy) takes some too
    float ao = 1.0;
    if (u_q.y > 0.0) {
      vec2 c0 = p.xy + n.xy * (0.3 * KM); float occ = 0.0, KR = KM * u_qual.w;
      for (int i = 0; i < 16; i++) {
        if (float(i) >= u_qual2.y) break;
        float an = float(i) * 6.2832 / u_qual2.y + 0.3; vec2 dir = vec2(cos(an), sin(an));
        occ += clamp((hm(c0 + dir * (0.6 * KR)).x - p.z - 0.1 * KM) / (0.6 * KR), 0.0, 1.0) * 0.55 + clamp((hm(c0 + dir * (2.0 * KR)).x - p.z - 0.2 * KM) / (2.0 * KR), 0.0, 1.0) * 0.45;
      }
      vec2 over = hm(p.xy); float canopy = over.y > p.z + KM ? 0.35 : 0.0;
      ao = clamp(1.0 - occ / u_qual2.y - canopy, 0.25, 1.0);
    }
    // contact shadows under figures the height map does not hold
    for (int i = 0; i < ${CONTACTS}; i++) {
      if (i >= u_ncontact) break;
      vec4 C = u_contact[i];
      if (C.w > 0.0 && p.z < u_ground + 0.25 * KM) { float cd = length((p.xy - C.xy) * vec2(1.0, 1.25)), ck = C.w * (1.0 - smoothstep(C.z * 0.25, max(C.z, 1e-3), cd)); sh *= 1.0 - ck; ao *= 1.0 - ck * 0.7; }
    }
    vec3 light = mix(u_earthCol, u_skyCol, n.z * 0.5 + 0.5) * ao;
    light += u_moonCol * max(dot(n, u_moon), 0.0) * sh;
    vec3 col = alb * light;
    if (wet > 0.5) { vec3 v = -ray, hv = (u_moon + v) / max(length(u_moon + v), 1e-4); col = col * 0.5 + u_skyCol * 0.2 + u_moonCol * pow(max(dot(n, hv), 0.0001), 90.0) * sh * 0.55; }

    // POINT LIGHTS: the first eight from uniforms, the rest from the table
    vec3 irr = vec3(0.0), warm = vec3(0.0), spec = vec3(0.0), halo = vec3(0.0);
    for (int i = 0; i < 8; i++) { if (u_lamp[i].w > 0.0) lamp(u_lamp[i], u_lampCol[i], u_lampHalo[i], p, n, ray, dist, wet, KM, irr, warm, spec, halo); }
    for (int i = 8; i < ${LIGHTS}; i++) {
      if (i >= u_nl) break;
      lamp(texelFetch(u_lt, ivec2(i, 0), 0), texelFetch(u_lt, ivec2(i, 1), 0), texelFetch(u_lt, ivec2(i, 2), 0).x, p, n, ray, dist, wet, KM, irr, warm, spec, halo);
    }
  #if LIGHTMAP_ON
    vec2 lu = (p.xy - u_lmBox.xy) / u_lmBox.zw;
    if (lu.x >= 0.0 && lu.y >= 0.0 && lu.x <= 1.0 && lu.y <= 1.0) irr += textureLod(u_lm, lu, 0.0).rgb * u_lmK;
  #endif
  #if RINGS_ON
    vec3 ringE = vec3(0.0);
    for (int i = 0; i < ${RINGS}; i++) {
      if (i >= u_nr) break;
      vec4 G = u_ring[i], C = u_ringCol[i]; vec2 dv = p.xy - G.xy; float r = length(dv), w = max(C.w, 1e-3);
      float d = (r - G.w) / w, band = exp(-d * d * 2.0) * exp(-max(p.z - G.z, 0.0) / (w * 2.0));
      if (band < 0.002) continue;
      vec3 toMid = vec3(-dv / max(r, 1e-3) * sign(d), 0.6); toMid = toMid / max(length(toMid), 1e-4);
      irr += C.rgb * band * (0.35 + 0.65 * max(dot(n, toMid), 0.0)); ringE += C.rgb * u_ringGlow[i] * band * band;
    }
  #endif
    if (u_lampCap > 0.0) irr = irr / (1.0 + max(irr.r, max(irr.g, irr.b)) * u_lampCap);
    col += alb * irr + spec;

    // CONES: the pool where the beam lands, and the beam in the haze
    vec3 beam = vec3(0.0);
  #if CONES_ON
    for (int k = 0; k < ${CONES}; k++) {
      if (k >= u_ns) break;
      vec4 S = texelFetch(u_lt, ivec2(k, 3), 0), D = texelFetch(u_lt, ivec2(k, 4), 0), K = texelFetch(u_lt, ivec2(k, 5), 0), X = texelFetch(u_lt, ivec2(k, 6), 0);
      float dd, s0 = spotOf(S, D, p, dd);
      if (s0 > 0.0) col += alb * K.rgb * s0 * coneShadow(k, S, X, p) * (0.35 + 0.65 * max(dot(n, (S.xyz - p) / max(dd, 0.01)), 0.0)) * 1.6 / (1.0 + dd * dd * 0.003 / (KM * KM));
      if (u_q.z > 0.0 && K.w > 0.0) {
        vec3 cc = S.xyz + D.xyz * S.w * 0.5;
        float sn = sqrt(max(1.0 - D.w * D.w, 0.0)), rs = S.w * (0.5 + sn / max(D.w, 0.2) * 0.9);
        vec3 oc = u_eye - cc; float bq = dot(oc, ray), disc = bq * bq - (dot(oc, oc) - rs * rs);
        if (disc > 0.0) {
          float sq = sqrt(disc), t0 = max(-bq - sq, 0.0), t1 = min(-bq + sq, dist);
          if (t1 > t0) {
            float ds = (t1 - t0) / u_qual.y, jit = hash(vec2(px) + float(k) * 13.7); vec3 acc = vec3(0.0);
            for (int i = 0; i < 64; i++) { if (float(i) >= u_qual.y) break; float sd; vec3 s = u_eye + ray * (t0 + (float(i) + jit) * ds); float sp = spotOf(S, D, s, sd); if (sp > 0.0) acc += vec3(sp * fogAt(s.z) * coneShadow(k, S, X, s) / (1.0 + sd * 0.05 / KM)); }
            beam += K.rgb * K.w * acc * ds * 3.6;
          }
        }
      }
    }
  #endif

    // RIM: a silhouette edge catches the moon from behind, and the warm lights round it
    if (!ground && u_look.y > 0.0 && glow < 0.05) {
      vec3 rw = vec3(u_fwd.y, -u_fwd.x, 0.0); int sx = dot(u_moon, rw) >= 0.0 ? 1 : -1;
      float d0 = length(worldAt(px) - u_eye), j0 = 0.5 * KM + d0 * 0.03, j1 = 1.5 * KM + d0 * 0.08;
      float e1 = smoothstep(j0, j1, length(worldAt(px + ivec2(0, 1)) - u_eye) - d0);
      float e2 = smoothstep(j0, j1, length(worldAt(px + ivec2(sx, 0)) - u_eye) - d0);
      float e3 = smoothstep(j0, j1, length(worldAt(px - ivec2(sx, 0)) - u_eye) - d0) * 0.4;
      float rim = max(max(e1, e2), e3) * exp(-d0 / (38.0 * KM));
      col += rim * u_look.y * (u_moonCol * (0.25 + 0.75 * sh) + warm * u_look.w) * (0.12 + alb * 1.4);
    }
    vec3 emit = alb * glow * u_q.w;
    col += emit;
    // THE HAZE: exponential height fog along the view ray, clear for the first stretch from the eye
    float ze = u_eye.z, zp = p.z, dz = ze - zp, kf = u_fog.y;
    float od = abs(dz) > 0.01 ? u_fog.x * dist * (exp(-max(zp, 0.0) * kf) - exp(-max(ze, 0.0) * kf)) / (dz * max(kf, 1e-3)) : u_fog.x * dist * exp(-max(zp, 0.0) * kf);
    od *= clamp((dist - u_look.x) / max(dist, 1e-3), 0.0, 1.0);
    float fa = 1.0 - exp(-max(od, 0.0));
    vec3 fogC = u_fogCol + u_moonCol * u_fog.z * pow(max(dot(ray, u_moon), 1e-4), 4.0);
    beam = beam / (1.0 + max(beam.r, max(beam.g, beam.b)) * 1.2);
    halo = halo / (1.0 + max(halo.r, max(halo.g, halo.b)) * 0.8);
    col = mix(col, fogC, fa) + emit * fa * 0.6 + halo + beam;
  #if RINGS_ON
    col += ringE;
  #endif
    o = vec4(max(col, vec3(0.0)), dist);
  }`;

  const FS_HEAT = `#version 300 es
  precision highp float;
  uniform sampler2D u_count; uniform int u_channel; uniform float u_unit;
  in vec2 v_uv; out vec4 o;
  void main() {
    vec4 c = texture(u_count, v_uv); float n = (u_channel == 0 ? c.r : c.g) / u_unit;
    // 0 black, 1 dark blue, 4 green, 16 yellow, 64 red, 256 white (a step of colour for every doubling)
    float t = n < 0.5 ? 0.0 : (log2(max(n, 0.5)) + 1.0) / 9.0;
    vec3 col = t <= 0.0 ? vec3(0.0) : t < 0.33 ? mix(vec3(0.05, 0.10, 0.45), vec3(0.10, 0.75, 0.35), t / 0.33)
      : t < 0.55 ? mix(vec3(0.10, 0.75, 0.35), vec3(0.98, 0.90, 0.20), (t - 0.33) / 0.22)
      : t < 0.78 ? mix(vec3(0.98, 0.90, 0.20), vec3(0.92, 0.15, 0.12), (t - 0.55) / 0.23) : mix(vec3(0.92, 0.15, 0.12), vec3(1.0), min(1.0, (t - 0.78) / 0.22));
    o = vec4(col, 1.0);
  }`;
  // Bloom, in three small shaders. Bright: keep only what glows (colour times the alpha the light pass wrote),
  // shrunk to a quarter. Blur: nine taps along one axis, run across then down, twice. Post: add the blur back
  // over the sharp picture ("screen", so it cannot go past white) and darken the corners a little (vignette).
  // HDR (opt.hdr): the light pass writes linear light to a half-float picture, the fx hook can add more than 1,
  // and the tone curve and grade move to the post pass. A NaN or an infinity from any pass would spread through
  // every blur after it, so what the bloom and the post pass read is scrubbed first: clamped, and anything that is
  // not a number becomes 0. Bloom then takes what glows and what is brighter than a knee.
  const SCRUB = `
  vec3 scrub(vec3 c) {
    c = clamp(c, vec3(0.0), vec3(48.0));
    if (isnan(c.r) || isnan(c.g) || isnan(c.b) || isinf(c.r) || isinf(c.g) || isinf(c.b)) c = vec3(0.0);
    return c;
  }`;
  const FS_BRIGHT = `#version 300 es
  precision highp float;
  #define HDR_ON 0
  uniform sampler2D u_tex; uniform vec2 u_px; uniform float u_knee; in vec2 v_uv; out vec4 o;
  ${SCRUB}
#if HDR_ON
  vec3 pick(vec4 t) { vec3 c = scrub(t.rgb); return c * max(clamp(t.a, 0.0, 1.0), smoothstep(u_knee, u_knee + 0.8, max(c.r, max(c.g, c.b)))); }
#else
  vec3 pick(vec4 t) { return t.rgb * t.a; }
#endif
  void main() {
    vec3 s = pick(texture(u_tex, v_uv + vec2(-1.0, -1.0) * u_px)) + pick(texture(u_tex, v_uv + vec2(1.0, -1.0) * u_px)) + pick(texture(u_tex, v_uv + vec2(-1.0, 1.0) * u_px)) + pick(texture(u_tex, v_uv + vec2(1.0, 1.0) * u_px));
    o = vec4(min(s * 0.25, vec3(24.0)), 1.0);
  }`;
  // THE FILM POST (opt.post, or the night model): bloom keyed on brightness alone (the light pass's alpha is the
  // view distance here), a tilt-shift depth of field, an ACES-fitted tone curve and a grade, a vignette and grain.
  const FS_KNEE = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex; uniform vec2 u_px; uniform float u_knee; in vec2 v_uv; out vec4 o;
  ${SCRUB}
  vec3 pick(vec3 c) { c = scrub(c); float l = max(c.r, max(c.g, c.b)); return c * smoothstep(u_knee, u_knee + 0.8, l); }
  void main() {
    vec3 a = pick(texture(u_tex, v_uv + vec2(-1.0, -1.0) * u_px).rgb), b = pick(texture(u_tex, v_uv + vec2(1.0, -1.0) * u_px).rgb);
    vec3 c = pick(texture(u_tex, v_uv + vec2(-1.0, 1.0) * u_px).rgb), d = pick(texture(u_tex, v_uv + vec2(1.0, 1.0) * u_px).rgb);
    o = vec4(min((a + b + c + d) * 0.25, vec3(24.0)), 1.0);
  }`;
  const FS_DOWN = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex; uniform vec2 u_px; in vec2 v_uv; out vec4 o;
  ${SCRUB}
  void main() {
    vec3 a = scrub(texture(u_tex, v_uv + vec2(-1.0, -1.0) * u_px).rgb), b = scrub(texture(u_tex, v_uv + vec2(1.0, -1.0) * u_px).rgb);
    vec3 c = scrub(texture(u_tex, v_uv + vec2(-1.0, 1.0) * u_px).rgb), d = scrub(texture(u_tex, v_uv + vec2(1.0, 1.0) * u_px).rgb);
    o = vec4(min((a + b + c + d) * 0.25, vec3(8.0)), 1.0);
  }`;
  //   tilt-shift  crisp at the focus distance, soft nearer and further, and softer towards the top and bottom of
  //               the frame (the miniature look); the soft copy is read at the internal pixel's centre, so even the
  //               soft parts keep square pixels
  //   tone        a filmic curve (ACES fitted), exposure first; then the grade: black point, an S-curve for
  //               contrast, saturation, blue in the shadows; a vignette; grain per canvas pixel
  const FS_FILM = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex, u_bloom, u_dof; uniform vec2 u_size;
  uniform vec4 u_k;            // bloom strength, vignette, grain, exposure
  uniform vec4 u_focus;        // focus distance, its depth, the screen row of the tilt-shift band (0..1, below 0: none), strength
  uniform vec4 u_grade;        // contrast, black level, saturation, shadow blue
  uniform float u_time;
  uniform vec3 u_ss;          // supersampling: on, and a quarter of a canvas pixel in uv (see FS_POST)
  in vec2 v_uv; out vec4 o;
  ${SCRUB}
  float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main() {
    ivec2 ip = ivec2(min(v_uv * u_size, u_size - 1.0));
    vec4 s = texelFetch(u_tex, ip, 0); vec3 c = scrub(s.rgb);
    if (u_ss.x > 0.5) c = (scrub(texture(u_tex, v_uv + vec2(-u_ss.y, -u_ss.z)).rgb) + scrub(texture(u_tex, v_uv + vec2(u_ss.y, -u_ss.z)).rgb) + scrub(texture(u_tex, v_uv + vec2(-u_ss.y, u_ss.z)).rgb) + scrub(texture(u_tex, v_uv + vec2(u_ss.y, u_ss.z)).rgb)) * 0.25;
    vec2 cuv = (vec2(ip) + 0.5) / u_size;
    float dz = abs(s.a - u_focus.x) / max(u_focus.y, 0.1), ty = u_focus.z < 0.0 ? 0.0 : abs(cuv.y - u_focus.z);
    float coc = clamp(max(smoothstep(0.6, 2.2, dz), smoothstep(0.3, 0.68, ty) * 0.75) * u_focus.w, 0.0, 1.0);
    c = mix(c, scrub(texture(u_dof, cuv).rgb), coc);
    c += scrub(texture(u_bloom, v_uv).rgb) * u_k.x;
    c *= u_k.w;
    c = clamp((c * (2.51 * c + 0.03)) / max(c * (2.43 * c + 0.59) + 0.14, vec3(1e-4)), 0.0, 1.0);
    c = max(c - u_grade.y, vec3(0.0)) / max(1.0 - u_grade.y, 0.01);
    c = mix(c, c * c * (3.0 - 2.0 * c), u_grade.x);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, u_grade.z);
    c += vec3(0.025, 0.01, -0.02) * smoothstep(0.35, 1.0, l) + vec3(-0.01, 0.0, 0.028) * u_grade.w * (1.0 - smoothstep(0.0, 0.25, l)) * smoothstep(0.0, 0.05, l);
    vec2 d = v_uv - 0.5; c *= 1.0 - u_k.y * dot(d, d) * 1.8;
    c += (hash(gl_FragCoord.xy + fract(u_time * 7.13) * 91.7) - 0.5) * u_k.z;
    o = vec4(clamp(c, 0.0, 1.0), 1.0);
  }`;
  const FS_BLUR = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex; uniform vec2 u_step; in vec2 v_uv; out vec4 o;
  void main() {
    vec3 c = texture(u_tex, v_uv).rgb * 0.227;
    c += (texture(u_tex, v_uv + u_step).rgb + texture(u_tex, v_uv - u_step).rgb) * 0.1945;
    c += (texture(u_tex, v_uv + u_step * 2.0).rgb + texture(u_tex, v_uv - u_step * 2.0).rgb) * 0.1216;
    c += (texture(u_tex, v_uv + u_step * 3.0).rgb + texture(u_tex, v_uv - u_step * 3.0).rgb) * 0.0541;
    c += (texture(u_tex, v_uv + u_step * 4.0).rgb + texture(u_tex, v_uv - u_step * 4.0).rgb) * 0.0162;
    o = vec4(c, 1.0);
  }`;
  const FS_POST = `#version 300 es
  precision highp float;
  #define HDR_ON 0
  uniform sampler2D u_tex, u_bloom; uniform vec2 u_size; uniform vec2 u_k;      // u_k: bloom strength, vignette strength
  uniform float u_exp;        // HDR: the exposure (the light pass's tone curve and grade, applied here instead)
  uniform vec3 u_ss;          // supersampling (opt.quality.ss): on, and a quarter of a canvas pixel in uv
  in vec2 v_uv; out vec4 o;
  ${SCRUB}
  // the picture at this canvas pixel: the nearest internal pixel, or (supersampled) four smoothed taps a quarter of a
  // canvas pixel either way, which for twice the canvas is exactly the 2 x 2 internal pixels under it
  vec3 lit() {
    if (u_ss.x < 0.5) return texelFetch(u_tex, ivec2(min(v_uv * u_size, u_size - 1.0)), 0).rgb;
    return (texture(u_tex, v_uv + vec2(-u_ss.y, -u_ss.z)).rgb + texture(u_tex, v_uv + vec2(u_ss.y, -u_ss.z)).rgb + texture(u_tex, v_uv + vec2(-u_ss.y, u_ss.z)).rgb + texture(u_tex, v_uv + vec2(u_ss.y, u_ss.z)).rgb) * 0.25;
  }
  void main() {
#if HDR_ON
    vec3 c = scrub(lit()) + scrub(texture(u_bloom, v_uv).rgb) * u_k.x;
    c = 1.0 - exp(-pow(max(c * u_exp, 0.0), vec3(1.25)) * 1.7);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.16);
    c += vec3(0.022, 0.006, -0.022) * smoothstep(0.4, 1.0, l) + vec3(-0.014, 0.0, 0.022) * (1.0 - smoothstep(0.0, 0.45, l));
    c = clamp(c, 0.0, 1.0);
#else
    vec3 c = lit();                                          // the nearest internal pixel: no smoothing (unless supersampled)
    vec3 b = min(texture(u_bloom, v_uv).rgb * u_k.x, 1.0);
    c = 1.0 - (1.0 - c) * (1.0 - b);
#endif
    vec2 d = v_uv - 0.5; c *= 1.0 - u_k.y * dot(d, d) * 1.6;
    o = vec4(c, 1.0);
  }`;

  // opts (optional): { warm: features for E.warm (default { cones: true }: the plain and the cone light pass are
  // made at once, so the first frame with cones does not hitch), or false }
  function create(canvas, opts) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    const floatOK = !!gl.getExtension('EXT_color_buffer_float');
    const timerExt = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');

    function program(vs, fs) {
      const p = gl.createProgram();
      [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]].forEach(function (s) {
        const sh = gl.createShader(s[0]); gl.shaderSource(sh, s[1]); gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
        gl.attachShader(p, sh);
      });
      gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) { const name = gl.getActiveUniform(p, i).name.replace('[0]', ''); u[name] = gl.getUniformLocation(p, name); }
      return { p: p, u: u };
    }
    function texture(w, h, internal, format, type, data, filter) {
      const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, data || null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    const pG = program(VS_SLICE, FS_G), pCount = program(VS_SLICE, FS_COUNT), pLight = program(VS_FULL, FS_LIGHT), pHeat = program(VS_FULL, FS_HEAT);
    const pGVoxel = program(VS_VOXEL, FS_GVOXEL), pCountVoxel = program(VS_VOXEL, FS_COUNTVOXEL);
    const pGImp = program(VS_IMP, FS_GIMP), pCountImp = program(VS_IMP, FS_COUNTIMP);
    // Builds of a shader with some of its #define NAME 0 switched to 1, made the first time they are needed.
    const variants = {};
    function variant(key, vs, fs, on) {
      if (!variants[key]) { let src = fs; on.forEach(function (d) { src = src.split('#define ' + d + ' 0').join('#define ' + d + ' 1'); }); variants[key] = program(vs, src); }
      return variants[key];
    }
    // the light pass for a set of features
    function lightProgram(cones, rows, ground, lightMap, hdr, rings, two, film) {
      const on = (cones ? ['CONES_ON'] : []).concat(rows ? ['ROWS_ON'] : [], ground ? ['GROUND_ON'] : [], lightMap ? ['LIGHTMAP_ON'] : [], hdr ? ['HDR_ON'] : [], rings ? ['RINGS_ON'] : [], two ? ['TWO_ON'] : [], film ? ['FILM_ON'] : []);
      return on.length ? variant('l' + on.join(), VS_FULL, FS_LIGHT, on) : pLight;
    }
    // the night model for a set of features, and a game's floor (GLSL source, or none)
    const floors = [];
    function nightProgram(cones, rows, ground, lightMap, rings, two, floor) {
      const on = (cones ? ['CONES_ON'] : []).concat(rows ? ['ROWS_ON'] : [], ground ? ['GROUND_ON'] : [], lightMap ? ['LIGHTMAP_ON'] : [], rings ? ['RINGS_ON'] : [], two ? ['TWO_ON'] : [], floor ? ['FLOOR_ON'] : []);
      let fi = floor ? floors.indexOf(floor) : -1; if (floor && fi < 0) { floors.push(floor); fi = floors.length - 1; }
      return variant('n' + on.join() + '|' + fi, VS_FULL, floor ? FS_NIGHT.replace('FLOOR_SOURCE', floor) : FS_NIGHT, on);
    }
    const pBright = program(VS_FULL, FS_BRIGHT), pBlur = program(VS_FULL, FS_BLUR), pPost = program(VS_FULL, FS_POST);

    // the four corners of a quad (one small buffer, shared), the instance buffer, and their vertex arrays
    const corners = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, corners); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    let cap = 1 << 16, inst = new Float32Array(cap * FL), tmp = new Float32Array(cap * FL), keys = new Uint16Array(cap);
    const counts = new Uint32Array(NB + 1);
    const vao = gl.createVertexArray(), buf = gl.createBuffer(); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    const perInstance = function (list) { list.forEach(function (a) { gl.enableVertexAttribArray(a[0]); gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, FL * 4, a[2] * 4); gl.vertexAttribDivisor(a[0], 1); }); };
    perInstance([[0, 3, 0], [1, 1, 3], [2, 4, 4], [3, 2, 8], [4, 1, 10]]);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners); gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);
    // voxel mode: a box's top, four sides and bottom as triangles, each wound anticlockwise seen from outside
    const box = gl.createBuffer(), vaoVoxel = gl.createVertexArray(); gl.bindVertexArray(vaoVoxel); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    perInstance([[0, 3, 0], [1, 1, 3], [2, 4, 4], [3, 2, 8], [4, 1, 10], [6, 1, 11]]);
    gl.bindBuffer(gl.ARRAY_BUFFER, box); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1, 1,   0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1,   1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 1,
      1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 0, 1, 1, 1, 1, 0, 1,   0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 1, 1,   0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 1, 0]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 3, gl.FLOAT, false, 0, 0);
    const impBuf = gl.createBuffer(), vaoImp = gl.createVertexArray(); gl.bindVertexArray(vaoImp); gl.bindBuffer(gl.ARRAY_BUFFER, impBuf);
    [[0, 4, 0], [1, 4, 4], [2, 4, 8], [3, 3, 12]].forEach(function (a) { gl.enableVertexAttribArray(a[0]); gl.vertexAttribPointer(a[0], a[1], gl.FLOAT, false, IL * 4, a[2] * 4); gl.vertexAttribDivisor(a[0], 1); });
    gl.bindBuffer(gl.ARRAY_BUFFER, corners); gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);
    const vaoFull = gl.createVertexArray(); gl.bindVertexArray(vaoFull); gl.bindBuffer(gl.ARRAY_BUFFER, corners); gl.enableVertexAttribArray(5); gl.vertexAttribPointer(5, 2, gl.FLOAT, false, 0, 0);

    // render targets, made again when the internal resolution changes
    let iw = 0, ih = 0, bw = 0, bh = 0, g0, g1, g2, lit, countTex, depth, fboG, fboGR, fboLit, fboCount, bloom = [], fboBloom = [], hdr = null;
    // the half-float picture and bloom for opt.hdr, made the first time they are asked for at this size
    function hdrTargets() {
      if (hdr) return hdr;
      const t = { lit: texture(iw, ih, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, gl.LINEAR), fbo: gl.createFramebuffer(), bloom: [], fboBloom: [] };
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.lit, 0); gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      for (let i = 0; i < 2; i++) { t.bloom[i] = texture(bw, bh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, gl.LINEAR); t.fboBloom[i] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboBloom[i]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.bloom[i], 0); }
      t.dof = []; t.fboDof = [];
      for (let i = 0; i < 2; i++) { t.dof[i] = texture(bw, bh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, null, gl.LINEAR); t.fboDof[i] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, t.fboDof[i]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.dof[i], 0); }
      return (hdr = t);
    }
    let fxShift = 2;      // bloom and the depth of field at a quarter (2) or a half (1) of the internal size (opt.quality.fxRes)
    function targets(w, h, shift) {
      if (w === iw && h === ih && shift === fxShift) return; iw = w; ih = h; fxShift = shift; bw = Math.max(1, w >> shift); bh = Math.max(1, h >> shift); hdr = null;
      g0 = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); g1 = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); lit = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR);
      countTex = floatOK ? texture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT) : texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      fboG = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboG);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g0, 0); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g1, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth); gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      // the same with the palette row as a third target, for a palette with more than one row
      g2 = texture(w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE); fboGR = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboGR);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g0, 0); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g1, 0); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, g2, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth); gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      fboLit = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboLit); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lit, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);      // so the fx hook can test against the slice pass
      fboCount = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboCount); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, countTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      for (let i = 0; i < 2; i++) { bloom[i] = texture(bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR); fboBloom[i] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloom[i]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloom[i], 0); }
    }

    const E = { gl: gl, program: program, floatOK: floatOK, LIGHTS: LIGHTS, CONES: CONES, BINS: BINS, RINGS: RINGS, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', hmW: 0, hmH: 0,
      // (SHAPES. Every object the engine reads each frame gets all its fields when it is made, and a field that will
      // hold a fraction starts as one: V8 then gives it one hidden class and stores the field as a double from the
      // start. A field added later, or an integer field that later takes a fraction, changes the class mid-run and
      // throws away the optimised code of every function that reads it.)
      stats: { instances: 0, slices: 0, rows: 0.5, cpuMs: 0.5, gpuMs: null, written: null, covered: null, pixels: 0, pixelsHit: 0, exact: false, iw: 0, ih: 0 } };
    let palTex = null, hmTex = null, hmBox = [0, 0, 1, 1], hmStep = 0.5, hmTwo = false, query = null, timing = false;
    let gmTex = null, gmBox = null, lmTex = null, lmBox = null, lmK = 1;
    const UNIT = floatOK ? 1 : 1 / 255;                      // without float targets the count stops at 255

    E.makeAtlas = function (data, size) { return texture(size, size, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data); };
    // WARMING. The optional builds are made the first time a frame needs them, and making one (compiling and
    // linking, and the driver's own work on the first draw) can take a hundred milliseconds or more: a hitch in
    // the middle of a game. E.warm(features) makes them all at start-up instead. features: { cones, rings, rows,
    // groundMap, lightMap, hdr } (true for each the game will use). Cones and rings come and go from frame to
    // frame, so every combination of them is made; the rest are taken to stay on once they are set. Each program
    // is drawn once into a 1 x 1 target, so the driver does its own part now too. Returns how many were made.
    let warmFbo = null;      // (features also: night, floor (its GLSL), twoLayer, post: see the night model and the film post)
    E.warm = function (f) {
      f = f || {};
      if (!warmFbo) { warmFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, warmFbo); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture(1, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), 0); gl.bindTexture(gl.TEXTURE_2D, null); }      // (unbound, or the programs would sample their own target)
      const night = !!f.night && floatOK, film = (night || !!f.post) && floatOK, hdr = (!!f.hdr || film) && floatOK, progs = [];
      [false, !!f.cones].forEach(function (c, i) { if (i && !c) return; [false, !!f.rings].forEach(function (r, j) { if (j && !r) return;
        progs.push(night ? nightProgram(c, !!f.rows, !!f.groundMap, !!f.lightMap, r, !!f.twoLayer, f.floor || null) : lightProgram(c, !!f.rows, !!f.groundMap, !!f.lightMap, hdr, r, !!f.twoLayer, film)); }); });
      if (film) progs.push(variant('knee', VS_FULL, FS_KNEE, []), variant('down', VS_FULL, FS_DOWN, []), variant('film', VS_FULL, FS_FILM, []));
      if (f.rows) progs.push(variant('gr', VS_SLICE, FS_G, ['ROWS_ON']), variant('gvr', VS_VOXEL, FS_GVOXEL, ['ROWS_ON']), variant('gir', VS_IMP, FS_GIMP, ['ROWS_ON']));
      if (hdr && !film) progs.push(variant('bh', VS_FULL, FS_BRIGHT, ['HDR_ON']), variant('ph', VS_FULL, FS_POST, ['HDR_ON']));
      gl.bindFramebuffer(gl.FRAMEBUFFER, warmFbo); gl.viewport(0, 0, 1, 1); gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND); gl.bindVertexArray(vaoFull);
      progs.forEach(function (p) { gl.useProgram(p.p); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return progs.length;
    };
    // the palette: 256 colours (rgb, and a glow in alpha) per row, `rows` rows (1 if not given; at most 64)
    let palRows = 1;
    E.setPalette = function (bytes, rows) { palRows = Math.max(1, Math.min(64, rows || 1)); palTex = texture(256, palRows, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bytes); };
    // the height map for shadows and occlusion: one byte per ground cell, the height of the tallest thing standing
    // on it (in half units). It is read with smoothing, which is what rounds the shadows' edges.
    // box (optional): where it lies in the world, [x0, y0, width, depth] (0, 0, w, h if not given: a cell per unit);
    // step (optional): the world height of one step of a byte (0.5 if not given). The edge of the height map is the
    // edge of the map. A map of the same size as the last goes up in place, so sending a whole map every frame (a
    // horde splatted into it, to throw shadows) costs one upload.
    // layers (optional, 1 or 2): with 2 the map has two bytes a cell, the top of the tallest thing and the bottom
    // of its highest solid run, so a tree's crown floats on its trunk and the sun or the moon gets in under it.
    E.setHeightMap = function (bytes, w, h, box, step, layers) {
      const two = layers === 2, F = two ? gl.RG : gl.RED;
      if (hmTex && E.hmW === w && E.hmH === h && hmTwo === two) { gl.bindTexture(gl.TEXTURE_2D, hmTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, F, gl.UNSIGNED_BYTE, bytes); }
      else { hmTex = texture(w, h, two ? gl.RG8 : gl.R8, F, gl.UNSIGNED_BYTE, bytes, gl.LINEAR); E.hmW = w; E.hmH = h; hmTwo = two; }
      hmBox = box ? box.slice(0, 4) : [0, 0, w, h]; hmStep = step || 0.5;
    };
    // THE GROUND MAP (optional): open ground (where no slice was drawn) inside `box` takes its colour from this, a
    // texel per cell, RGBA: palette index A, palette index B, wear (0 all A, 255 all B), unused. null switches it off.
    E.setGroundMap = function (bytes, w, h, box) { if (!bytes) { gmTex = null; return; } gmTex = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bytes); gmBox = box.slice(0, 4); };
    E.patchGroundMap = function (bytes, x, y, w, h) { gl.bindTexture(gl.TEXTURE_2D, gmTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes); };
    // THE LIGHT MAP (optional): light that does not move, RGBA (rgb used), read smoothed over `box`; 255 is worth
    // `scale` (1 if not given). It lights slices and ground alike. null switches it off.
    E.setLightMap = function (bytes, w, h, box, scale) { if (!bytes) { lmTex = null; return; } lmTex = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bytes, gl.LINEAR); lmBox = box.slice(0, 4); lmK = scale || 1; };
    E.patchLightMap = function (bytes, x, y, w, h) { gl.bindTexture(gl.TEXTURE_2D, lmTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bytes); };
    // a part of it again, when something on the map changes height (a wall lowered, a roof blown off)
    E.patchHeightMap = function (bytes, x, y, w, h) { gl.bindTexture(gl.TEXTURE_2D, hmTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, bytes); };

    // The lights' table: a float texture, a column per light (see FS_LIGHT), filled each frame from opt.lamps and
    // opt.cones. And the cones' shadow tables: a row of BINS bins per cone, filled from opt.coneBlockers.
    const LROWS = 7, ltData = new Float32Array(LIGHTS * LROWS * 4), ltTex = texture(LIGHTS, LROWS, gl.RGBA32F, gl.RGBA, gl.FLOAT, ltData);
    const coneBytes = new Uint8Array(BINS * CONES * 4), coneTex = texture(BINS, CONES, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, coneBytes);
    const binD = new Float32Array(BINS), binH = new Float32Array(BINS);
    // A cone: [x, y, z, range, dx, dy, dz, half angle, r, g, b, beam]. The axis need not be unit length; beam is how
    // strongly it shows in the air (0: only the pool). Returns how many cones went into the table.
    function putCones(C, blockers, table) {
      const ns = Math.min(CONES, C.length), L4 = LIGHTS * 4;
      for (let k = 0; k < ns; k++) {
        const c = C[k], l = Math.hypot(c[4], c[5], c[6]) || 1, dx = c[4] / l, dy = c[5] / l, dz = c[6] / l, half = c[7], j = k * 4;
        // how wide the cone is seen from above, round its light: its shadow table must span that (all round, for a cone that points down)
        const yaw = Math.atan2(dy, dx), tilt = Math.asin(Math.max(-1, Math.min(1, -dz))), hw = tilt + half > 1.25 ? Math.PI : Math.min(Math.PI, half / Math.max(0.25, Math.cos(tilt + half * 0.5)) + 0.15);
        ltData.set([c[0], c[1], c[2], Math.max(0.1, c[3])], 3 * L4 + j); ltData.set([dx, dy, dz, Math.cos(half)], 4 * L4 + j);
        ltData.set([c[8], c[9], c[10], c[11] || 0], 5 * L4 + j); ltData.set([yaw, hw, blockers || table ? 1 : 0, 0], 6 * L4 + j);
        if (!blockers) continue;
        // the shadow table: per angle round the light, how far to the nearest blocker [x, y, radius, height] and how tall it is
        binD.fill(c[3]); binH.fill(0);
        for (let q = 0; q < blockers.length; q++) {
          const b = blockers[q], bx = b[0] - c[0], by = b[1] - c[1], d = Math.hypot(bx, by); if (d < b[2] * 0.5 || d - b[2] > c[3]) continue;
          let a = Math.atan2(by, bx) - yaw; a -= Math.round(a / (2 * Math.PI)) * 2 * Math.PI;
          const w = Math.asin(Math.min(1, b[2] / d)), b0 = Math.floor(((a - w) / hw * 0.5 + 0.5) * BINS), b1 = Math.floor(((a + w) / hw * 0.5 + 0.5) * BINS);
          for (let i = Math.max(0, b0); i <= Math.min(BINS - 1, b1); i++) if (d - b[2] < binD[i]) { binD[i] = Math.max(0, d - b[2]); binH[i] = b[3]; }
        }
        for (let i = 0; i < BINS; i++) { const v = Math.round(Math.max(0, Math.min(1, binD[i] / c[3])) * 65535), o = (k * BINS + i) * 4; coneBytes[o] = v >> 8; coneBytes[o + 1] = v & 255; coneBytes[o + 2] = Math.round(Math.max(0, Math.min(1, binH[i] / HMAX)) * 255); coneBytes[o + 3] = 255; }
      }
      if (table && ns && !blockers) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, coneTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BINS, ns, gl.RGBA, gl.UNSIGNED_BYTE, table); }
      if (blockers && ns) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, coneTex);      // (its own unit: binding it to whatever unit was active would knock out the light map or the ground map)
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, BINS, ns, gl.RGBA, gl.UNSIGNED_BYTE, coneBytes); }
      return ns;
    }
    // A point light: [x, y, z, reach, r, g, b, occlude (1: shadowed by the height map), halo (its glow in the air)].
    // Returns how many went into the table.
    // The first eight go in uniforms (lampU, lampC, lampH), the rest in the table.
    const lampU = new Float32Array(32), lampC = new Float32Array(32), lampH = new Float32Array(8);
    function putLights(L, haloDefault) {
      const nl = Math.min(LIGHTS, L.length), L4 = LIGHTS * 4;
      lampU.fill(0); lampC.fill(0); lampH.fill(0);
      for (let i = 0; i < nl; i++) {
        const l = L[i], j = i * 4, U = i < 8 ? lampU : ltData, A = i < 8 ? 0 : L4, a = i < 8 ? lampC : ltData;
        U[j] = l[0]; U[j + 1] = l[1]; U[j + 2] = l[2]; U[j + 3] = Math.max(0.1, l[3]);
        a[A + j] = l[4]; a[A + j + 1] = l[5]; a[A + j + 2] = l[6]; a[A + j + 3] = l[7] || 0;
        const hk = l[8] !== undefined ? l[8] : haloDefault;
        if (i < 8) lampH[i] = hk; else ltData[2 * L4 + j] = hk;
      }
      return nl;
    }

    // Turn slices into sorted instances. list: [{ stack, x, y, z, rot, scale, only (one slice index, or -1 for all),
    // shx, shy (optional: how far the stack leans per unit of height, for trees and wheat in the wind),
    // zs (optional: each layer drawn zs times as tall), fade (optional, 0 to 1: the share of its pixels left out),
    // each (optional: function (layer, layers, out) -> out or null, moves or hides single slices: the slice effects),
    // reach (optional: how far each can move a slice, for culling; 60 if not given), lift (optional: rings lift it),
    // row (optional: the palette row it is drawn in, 0 to 63, see setPalette) }]
    // horde (optional, opt.horde): [{ frames: [stack, ...], n, x, y, z, rot, frame, fade, row, scale, lift }], thousands of units
    // as typed arrays with no object per unit: x, y, rot Float32Array; z Float32Array or null (0); frame Uint8Array
    // or null (an index into frames: a walk or a flap, one stack per frame); fade Uint8Array or null (0..255); row
    // Uint8Array or null (the palette row: a hit flash, a unit powered down). Each
    // unit goes through the same culling and instance writing as an item (one scratch item, reused).
    const moved = { dx: 0.5, dy: 0.5, dz: 0.5, rot: 0.5, scale: 1.5 };      // (fractions from the start: see SHAPES)
    const lift = new Float32Array(RINGS * 7), NOHORDE = [], NOQ = {}, unit = newItem();
    function build(list, M, opt) {
      const ppuOrtho = ih / (2 * opt.cam.dist * M.th), vp = M.vp, voxel = !!opt.voxel, U = opt.unit || 1, zq = ZQ;      // zq: height buckets per world unit (2048 of them: 128 units)
      let n = 0, slices = 0, tallest = 0;
      // A shell stack is hollow, so a shallow view ray must not slip between two copies of a slice and through the
      // shell: the copies have to be closer together than the shell is deep along that ray.
      const slope = Math.tan(Math.max(0.06, M.ortho ? opt.cam.pitch : opt.cam.pitch - opt.cam.fov * 0.35));
      // the items, then the horde's units one by one through the same body (no closure: n stays a local, and the
      // instance loops below stay fast)
      const H = opt.horde || NOHORDE, L = list.length, RG = opt.rings || NOHORDE;
      // the rings that lift (see opt.rings), each with the square of the inner and outer edge of its band (two widths
      // either side of its radius), so most things are passed over without a square root
      let lifting = 0;
      for (let r = 0; r < RG.length && r < RINGS; r++) { const g = RG[r]; if (!(g[9] > 0)) continue; const w = Math.max(g[4], 1e-3), a = Math.max(0, g[3] - 2 * w), b = g[3] + 2 * w, o = lifting++ * 7; lift[o] = g[0]; lift[o + 1] = g[1]; lift[o + 2] = g[3]; lift[o + 3] = 1 / w; lift[o + 4] = g[9]; lift[o + 5] = a * a; lift[o + 6] = b * b; }
      // how far the rings lift a thing standing at (x, y): a bump that rides the band, its lift high at the band's middle
      const ringLift = function (x, y) {
        let z = 0;
        for (let r = 0; r < lifting; r++) { const o = r * 7, dx = x - lift[o], dy = y - lift[o + 1], q = dx * dx + dy * dy; if (q < lift[o + 5] || q > lift[o + 6]) continue; const d = (Math.sqrt(q) - lift[o + 2]) * lift[o + 3]; z = Math.max(z, lift[o + 4] * Math.exp(-d * d * 2)); }
        return z;
      };
      let gi = 0, ui = 0;
      for (let q = 0; ; q++) {
        let it;
        if (q < L) it = list[q];
        else {
          while (gi < H.length && ui >= H[gi].n) { gi++; ui = 0; }
          if (gi >= H.length) break;
          const G = H[gi], i = ui++;
          unit.stack = G.frames[G.frame ? G.frame[i] : 0]; unit.x = G.x[i]; unit.y = G.y[i]; unit.z = G.z ? G.z[i] : 0; unit.rot = G.rot ? G.rot[i] : 0;
          unit.scale = G.scale || 1; unit.fade = G.fade ? G.fade[i] / 255 : 0; unit.row = G.row ? G.row[i] : 0; unit.lift = !!G.lift; it = unit;
        }
        // sc, zs: the item's scale and how much taller each layer is drawn (zs, optional), with the stack's own sampling (art.js: res, zres)
        const st = it.stack, sc = it.scale * (st.k || 1), one = it.only >= 0, zs = (it.zs || 1) * (st.kz || 1), zk = (st.k || 1) * (st.kz || 1);
        // iz: the item's height, plus the lift of any ring crossing it (rings with a lift, items and horde groups with lift: true)
        const iz = it.z + (lifting && it.lift ? ringLift(it.x, it.y) : 0);
        // Leave out what the camera cannot see: a sphere round the stack against the edges of the view.
        const zc = one ? iz : iz + st.n * sc * zs * 0.5, R = (one ? st.radius : Math.hypot(st.radius, st.n * zs * 0.5)) * sc + (it.each ? it.reach || 60 * U : 2 * U);      // reach: how far an effect can move slices
        const cw = vp[3] * it.x + vp[7] * it.y + vp[11] * zc + vp[15], cx = vp[0] * it.x + vp[4] * it.y + vp[8] * zc + vp[12], cy = vp[1] * it.x + vp[5] * it.y + vp[9] * zc + vp[13];
        if (!M.ortho && cw < -R) continue;                     // behind the camera
        if ((M.ortho || cw > R) && (Math.abs(cx) - R * M.px > cw || Math.abs(cy) - R * M.py > cw)) continue;
        const sides = one || st.slices.length > 1 || st.slices[0].sides;
        // how many screen rows one layer of this stack is tall: that many copies of each slice
        let rows = 1;
        if (opt.fill || opt.lod || voxel) {
          if (M.ortho) rows = ppuOrtho * M.cp * sc * zs;
          else {
            // the nearest this stack can be: its middle less its radius, but no nearer than where the lowest ray on
            // screen comes down to the stack's top (a ground tile under the camera is not really four units away)
            const reach = (M.eye[2] - iz - st.n * sc * zs) / Math.sin(Math.min(1.5, opt.cam.pitch + opt.cam.fov / 2)) * Math.cos(opt.cam.fov / 2);
            const d = Math.max(4 * U, reach, (it.x - M.eye[0]) * M.f[0] + (it.y - M.eye[1]) * M.f[1] + (iz - M.eye[2]) * M.f[2] - st.radius * sc); rows = ih / (2 * d * M.th) * Math.min(1, M.cp + 0.25) * sc * zs * 1.15;
          }
        }
        if (rows > tallest && sides && Math.abs(cx) < cw && Math.abs(cy) < cw) tallest = rows;      // the tallest layer on screen (of stacks whose middle is in view and that have sides to fill)
        // Level of detail: when a layer is thinner than a pixel on screen, several layers land on one row.
        // Keep one of every `skip` (counting down from the top, which is always kept) and leave the rest out.
        const skip = opt.lod && !one && !it.each && rows < 1 ? Math.floor(1 / rows) : 1;
        const copies = voxel ? 1 : Math.max(st.shell ? Math.ceil(1 / (st.shell * slope)) : 1, Math.min(48, Math.ceil(opt.fill ? rows : 1)));
        // voxel mode draws runs (layers that repeat merged into one taller box) unless an effect moves single slices
        const src = voxel && !one && !it.each ? st.runs : st.slices;
        const a = one ? it.only : 0, b = one ? it.only + 1 : src.length, shx = it.shx || 0, shy = it.shy || 0, fade = Math.max(0, Math.min(1, it.fade || 0)) * 0.5, row = it.row > 0 ? Math.min(63, it.row) / 64 : 0;      // (half the fade added to the atlas column, the row over 64 to the atlas line: see VS_SLICE)
        // (a layer with no side, flat ground, needs no fill: it is drawn once, at the top of its layer)
        if (n + (b - a) * copies * 4 > cap) { while (n + (b - a) * copies * 4 > cap) cap *= 2; const i2 = new Float32Array(cap * FL), t2 = new Float32Array(cap * FL), k2 = new Uint16Array(cap); t2.set(tmp); k2.set(keys); inst = i2; tmp = t2; keys = k2; }
        for (let s = a; s < b; s++) {
          if (skip > 1 && (b - 1 - s) % skip) continue;
          const sl = src[s], first = sl.sides ? 0 : copies - 1; let x0 = it.x, y0 = it.y, z0 = iz + (one ? 0 : sl.z * sc * zs), rot = it.rot, k1 = sc;
          if (it.each) { const m = it.each(sl.z * zk, st.n * zk, moved); if (!m) continue; x0 += m.dx; y0 += m.dy; z0 += m.dz; rot += m.rot; k1 *= m.scale; }
          slices++;
          // a hollow slice is drawn as the strips round its hole (see art.js), unless that is switched off
          const parts = opt.split ? sl.parts : sl.whole;
          for (let pi = 0; pi < parts.length; pi++) {
            const pt = parts[pi];
            if (voxel) {
              // VOXEL MODE: one box per slice or run, as tall as the layers it stands for (paper thin, at the top of its layer, for ground with no side)
              const j = n * FL, up = z0 - iz, thin = !sl.sides, tall = thin ? 0.03 : s === b - 1 ? sl.n : Math.max(sl.n, skip);
              tmp[j] = x0 + shx * up; tmp[j + 1] = y0 + shy * up; tmp[j + 2] = z0 + (thin ? (sl.n - 0.03) * k1 * zs : 0); tmp[j + 3] = rot;
              tmp[j + 4] = pt.u + fade; tmp[j + 5] = pt.v + row; tmp[j + 6] = pt.w; tmp[j + 7] = pt.h; tmp[j + 8] = pt.ox; tmp[j + 9] = pt.oy; tmp[j + 10] = k1; tmp[j + 11] = tall * k1 * zs;
              keys[n++] = NB - 1 - Math.min(NB - 1, Math.max(0, Math.floor(z0 * zq)));      // highest first; the depth test does the rest
              continue;
            }
            for (let k = first; k < copies; k++) {
              const z = z0 + k / copies * k1 * zs, j = n * FL, up = z - iz;
              tmp[j] = x0 + shx * up; tmp[j + 1] = y0 + shy * up; tmp[j + 2] = z; tmp[j + 3] = rot;
              tmp[j + 4] = pt.u + fade; tmp[j + 5] = pt.v + row; tmp[j + 6] = pt.w; tmp[j + 7] = pt.h; tmp[j + 8] = pt.ox; tmp[j + 9] = pt.oy; tmp[j + 10] = k1; tmp[j + 11] = 0;
              let key = Math.min(NB - 1, Math.max(0, Math.floor(z * zq))); if (opt.hsr) key = NB - 1 - key;      // painter: lowest first; hidden-surface removal: highest first
              keys[n++] = key;
            }
          }
        }
      }
      counts.fill(0); for (let i = 0; i < n; i++) counts[keys[i] + 1]++;
      for (let i = 0; i < NB; i++) counts[i + 1] += counts[i];
      for (let i = 0; i < n; i++) { const d = counts[keys[i]]++ * FL, s = i * FL; for (let k = 0; k < FL; k++) inst[d + k] = tmp[s + k]; }
      E.stats.instances = n; E.stats.slices = slices; E.stats.rows = tallest; return n;
    }

    function drawSlices(prog, n, M, opt, hsr) {
      gl.useProgram(prog.p); gl.uniformMatrix4fv(prog.u.u_vp, false, M.vp);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, opt.atlas); gl.uniform1i(prog.u.u_atlas, 0);
      if (hsr) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); } else gl.disable(gl.DEPTH_TEST);
      if (opt.voxel) {                                         // VOXEL MODE: boxes, 36 corners each, back faces culled
        gl.bindVertexArray(vaoVoxel); gl.uniform3fv(prog.u.u_eye, M.eye); gl.uniform3fv(prog.u.u_fwd, M.f); gl.uniform1f(prog.u.u_ortho, M.ortho ? 1 : 0);
        gl.enable(gl.CULL_FACE); gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, n); gl.disable(gl.CULL_FACE);
      } else { gl.bindVertexArray(vao); gl.uniform1f(prog.u.u_guard, opt.guard ? 1 / ih : 0); gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n); }
      gl.disable(gl.DEPTH_TEST);
    }
    function pass(fbo, w, h, prog, tex) { gl.bindFramebuffer(gl.FRAMEBUFFER, fbo); gl.viewport(0, 0, w, h); gl.useProgram(prog.p); gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(prog.u.u_tex, 0); }

    // Draw every stack in `stacks` from ${ANGLES} directions into the impostor atlas, for this tilt. Returns the
    // table of sprites, or null when it is not ready: the bake is redone when the tilt or the art changes, but
    // not more than four times a second (while the camera is being tilted the real stacks are drawn instead).
    let imp = null, impTex = null, impFbo = null;
    E.prepareImpostors = function (stacks, atlas, pitch) {
      if (imp && imp.atlas === atlas && imp.count === stacks.length && Math.abs(imp.pitch - pitch) < 0.01) return imp;
      const now = performance.now(); if (imp && now - imp.time < 250) return null;
      if (!impTex) {
        impTex = [texture(IMP_W, IMP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE), texture(IMP_W, IMP_H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE)];
        const d = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, d); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, IMP_W, IMP_H);
        impFbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, impFbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, impTex[0], 0); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, impTex[1], 0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, d); gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      }
      const cp = Math.cos(pitch), sp = Math.sin(pitch), th = Math.tan(0.35), cells = new Map(), t0 = now;
      let x = 0, y = 0, rowH = 0;
      gl.bindFramebuffer(gl.FRAMEBUFFER, impFbo); gl.disable(gl.BLEND); gl.enable(gl.SCISSOR_TEST); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true);
      for (let q = 0; q < stacks.length; q++) {
        const st = stacks[q], r = st.radius + 1, Ww = 2 * r, Hw = st.n * cp + 2 * r * sp, w = Math.ceil(Ww * IMP_PPU), h = Math.ceil(Hw * IMP_PPU), at = [];
        for (let k = 0; k < ANGLES; k++) {
          if (x + w > IMP_W) { x = 0; y += rowH; rowH = 0; }
          if (y + h > IMP_H) { gl.disable(gl.SCISSOR_TEST); return (imp = { atlas: atlas, count: stacks.length, pitch: pitch, time: now, full: true, cells: new Map() }); }     // no room: draw real stacks
          const cam = { mode: 'ortho', tx: 0, ty: 0, yaw: k * Math.PI * 2 / ANGLES, pitch: pitch, dist: Hw / 2 / th, fov: 0.7 }, M = cameraMatrices(cam, w / h);
          M.vp[13] += -1 + 2 * r * sp / Hw;                     // put the stack's foot where the sprite expects it
          const opt = { cam: cam, voxel: true, hsr: true, fill: true, atlas: atlas }, n = build([{ stack: st, x: 0, y: 0, z: 0, rot: 0, scale: 1, only: -1 }], M, opt);
          gl.viewport(x, y, w, h); gl.scissor(x, y, w, h); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, n * FL), gl.DYNAMIC_DRAW);
          drawSlices(pGVoxel, n, M, opt, true);
          at.push(x, y); x += w; if (h > rowH) rowH = h;
        }
        cells.set(st, { w: w, h: h, Ww: Ww, Hw: Hw, foot: r * sp, at: at });
      }
      gl.disable(gl.SCISSOR_TEST);
      return (imp = { atlas: atlas, count: stacks.length, pitch: pitch, time: now, cells: cells, ms: performance.now() - t0, bytes: IMP_W * IMP_H * 8, used: (y + rowH) / IMP_H });
    };
    let impData = new Float32Array(1024 * IL);
    function drawImpostors(prog, items, M, opt, depth) {
      const n = items.length; if (impData.length < n * IL) impData = new Float32Array(n * IL * 2);
      let m = 0;
      for (let i = 0; i < n; i++) {
        const it = items[i], c = imp.cells.get(it.stack); if (!c) continue;
        const step = Math.PI * 2 / ANGLES, k = ((Math.round((opt.cam.yaw - it.rot) / step) % ANGLES) + ANGLES) % ANGLES, j = m++ * IL;
        impData[j] = it.x; impData[j + 1] = it.y; impData[j + 2] = it.z; impData[j + 3] = it.scale;
        impData[j + 4] = c.at[k * 2]; impData[j + 5] = c.at[k * 2 + 1]; impData[j + 6] = c.w; impData[j + 7] = c.h;
        impData[j + 8] = opt.cam.yaw - k * step; impData[j + 9] = it.shx || 0; impData[j + 10] = it.shy || 0; impData[j + 11] = it.stack.n;
        impData[j + 12] = c.Ww; impData[j + 13] = c.Hw; impData[j + 14] = c.foot;
      }
      gl.useProgram(prog.p); gl.bindVertexArray(vaoImp); gl.bindBuffer(gl.ARRAY_BUFFER, impBuf); gl.bufferData(gl.ARRAY_BUFFER, impData.subarray(0, m * IL), gl.DYNAMIC_DRAW);
      gl.uniformMatrix4fv(prog.u.u_vp, false, M.vp); gl.uniform3fv(prog.u.u_right, M.r); gl.uniform3fv(prog.u.u_up, M.u); gl.uniform3fv(prog.u.u_fwd, M.f);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, impTex[0]); gl.uniform1i(prog.u.u_i0, 0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, impTex[1]); gl.uniform1i(prog.u.u_i1, 1);
      if (depth) { gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true); } else gl.disable(gl.DEPTH_TEST);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, m); gl.disable(gl.DEPTH_TEST); gl.activeTexture(gl.TEXTURE0);
      return m;
    }

    // opt: { cam, list, atlas, hsr, fill, guard, voxel (draw boxes instead of flat quads), lod (skip layers thinner than a pixel),
    //        split (hollow slices as strips round their hole), cheap (shorter shadow walk, fewer occlusion samples), impostors (items drawn as sprites: needs the depth test and the parallel camera), heat (0 off, 1 written, 2 covered), measure, scale (canvas pixels per
    //        internal pixel), shadows, ao, bloom, water (palette index), time (seconds),
    //        light { sun, sunCol, skyCol, bounceCol, hazeCol, hazeK, glow, exposure, outer, cloud },
    //        lamps [[x, y, z, reach, r, g, b, occlude, halo]] (up to 256), lampCap (roll off the lights' sum: 0 off),
    //        cones [[x, y, z, range, dx, dy, dz, half angle, r, g, b, beam]] (up to 16), coneBlockers [[x, y, radius, height]],
    //        coneTable (instead of coneBlockers: the shadow tables themselves, ${BINS} x 16 RGBA bytes: per bin the
    //        distance to the first blocker over the cone's range in 16 bits, its height over ${HMAX} in 8),
    //        falloff ('window' for the steep windowed lamp falloff), contacts [[x, y, radius, strength]] (night),
    //        post ({ dof: [focus, depth, row, strength], grade: [contrast, black, saturation, shadow blue], grain,
    //        vignette, exposure, bloom, knee }: the film post, on the half-float picture),
    //        lightMapScale (the light map's strength this frame: 1 if not given, 0 by day),
    //        rings [[x, y, z, radius, width, r, g, b, glow, lift]] (up to 8: a band of light round a centre, an expanding pulse),
    //        blobs [[x, y, top, radius, bottom]], fx (function (gl, M, size): draws into the lit picture, see the README) }
    E.render = function (opt) {
      const t0 = performance.now(), W = canvas.width, H = canvas.height, env = opt.light;
      // the picture is drawn at 1 / scale of the canvas (scale: a whole number) and shown scale times larger, each
      // internal pixel a clean square, centred, with a thin bar where the canvas does not divide evenly
      // opt.quality (all optional; the defaults are the engine's usual look and cost):
      //   ss          supersampling: the picture drawn at ss times the canvas (1.5 or 2) and filtered down; scale is ignored
      //   shadow      how much finer the shadow walk is: steps times this, each that much shorter (1; 2 is twice as fine)
      //   shadowReach how much further it goes (1), shadowSoft how much wider the penumbra (1)
      //   aoDirs      occlusion directions (8 by day, 6 at night; up to 16), aoRadius how far they look (1)
      //   occSteps    steps of a lamp's occlusion test (8; up to 32), beamSteps a cone beam's steps (12; up to 64)
      //   fxRes       bloom and the depth of field at a quarter (4) or half (2) of the picture's size
      const Q = opt.quality || NOQ, ss = Q.ss > 1 ? Math.min(2, Q.ss) : 0, scale = ss ? 1 : Math.max(1, Math.round(opt.scale)), fxh = Q.fxRes === 2 ? 1 : 2;
      targets(ss ? Math.round(W * ss) : Math.max(1, Math.floor(W / scale)), ss ? Math.round(H * ss) : Math.max(1, Math.floor(H / scale)), fxh);
      const U = opt.unit || 1, M = cameraMatrices(opt.cam, iw / ih, U), n = build(opt.list, M, opt);
      if (timerExt && !query) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); timing = true; }
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, n * FL), gl.DYNAMIC_DRAW);
      gl.viewport(0, 0, iw, ih); gl.disable(gl.BLEND);

      // the slice pass: G-buffer only
      const rowsOn = palRows > 1;
      gl.bindFramebuffer(gl.FRAMEBUFFER, rowsOn ? fboGR : fboG); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const pg = rowsOn ? (opt.voxel ? variant('gvr', VS_VOXEL, FS_GVOXEL, ['ROWS_ON']) : variant('gr', VS_SLICE, FS_G, ['ROWS_ON'])) : opt.voxel ? pGVoxel : pG, pc = opt.voxel ? pCountVoxel : pCount, tested = opt.hsr || !!opt.voxel;      // voxel mode always tests depth
      const sprites = opt.impostors && opt.impostors.length ? opt.impostors : null;
      drawSlices(pg, n, M, opt, tested);
      if (sprites) E.stats.instances += drawImpostors(rowsOn ? variant('gir', VS_IMP, FS_GIMP, ['ROWS_ON']) : pGImp, sprites, M, opt, true);

      // the count pass: the same draw again, adding 1 per fragment. Red: fragments written. Green: fragments the quads cover.
      if (opt.measure || opt.heat) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboCount); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
        gl.useProgram(pc.p); gl.uniform1f(pc.u.u_unit, UNIT); gl.uniform1i(pc.u.u_all, 0); drawSlices(pc, n, M, opt, tested);
        if (sprites) { gl.useProgram(pCountImp.p); gl.uniform1f(pCountImp.u.u_unit, UNIT); gl.uniform1i(pCountImp.u.u_all, 0); drawImpostors(pCountImp, sprites, M, opt, true); }
        gl.useProgram(pc.p); gl.uniform1i(pc.u.u_all, 1); drawSlices(pc, n, M, opt, false);
        if (sprites) { gl.useProgram(pCountImp.p); gl.uniform1i(pCountImp.u.u_all, 1); drawImpostors(pCountImp, sprites, M, opt, false); }
        gl.disable(gl.BLEND);
        if (opt.measure) {                                     // read the counts back: average and largest, per screen pixel
          const px = iw * ih, d = floatOK ? new Float32Array(px * 4) : new Uint8Array(px * 4); let sr = 0, sg = 0, mr = 0, mg = 0, any = 0;
          gl.readPixels(0, 0, iw, ih, gl.RGBA, floatOK ? gl.FLOAT : gl.UNSIGNED_BYTE, d);
          for (let i = 0; i < px * 4; i += 4) { const r = d[i], g = d[i + 1]; sr += r; sg += g; if (r > mr) mr = r; if (g > mg) mg = g; if (g > 0) any++; }
          E.stats.written = { avg: sr / px, max: mr }; E.stats.covered = { avg: sg / px, max: mg }; E.stats.pixels = px; E.stats.pixelsHit = any; E.stats.exact = floatOK;
        }
      }

      // the light pass: once per pixel
      // (with cones, the build of the shader that has them, made the first time it is needed)
      const ns = Math.min(CONES, (opt.cones || []).length);
      const nr = Math.min(RINGS, (opt.rings || []).length);
      // the night model and the film post both need the half-float picture
      const night = env.model === 'night', film = !!(opt.post || night) && floatOK;
      const HD = (opt.hdr || night || opt.post) && floatOK ? hdrTargets() : null, litT = HD ? HD.lit : lit, litF = HD ? HD.fbo : fboLit, bl = HD ? HD.bloom : bloom, blF = HD ? HD.fboBloom : fboBloom;
      const pl = night ? nightProgram(!!ns, rowsOn, !!gmTex, !!lmTex, !!nr, hmTwo, env.floor || null) : lightProgram(!!ns, rowsOn, !!gmTex, !!lmTex, !!HD, !!nr, hmTwo, film), u = pl.u, sun = env.sun;
      gl.bindFramebuffer(gl.FRAMEBUFFER, litF); gl.useProgram(pl.p); gl.bindVertexArray(vaoFull);
      [[g0, 'u_g0'], [g1, 'u_g1'], [palTex, 'u_pal'], [hmTex, 'u_hm']].forEach(function (t, i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t[0]); gl.uniform1i(u[t[1]], i); });
      if (rowsOn) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, g2); gl.uniform1i(u.u_g2, 7); }
      if (nr) {
        // rings: [x, y, z, radius, width, r, g, b, glow, lift]
        const rp = new Float32Array(RINGS * 4), rc = new Float32Array(RINGS * 4), rg = new Float32Array(RINGS);
        for (let i = 0; i < nr; i++) { const g = opt.rings[i]; rp.set([g[0], g[1], g[2], g[3]], i * 4); rc.set([g[5], g[6], g[7], Math.max(1e-3, g[4])], i * 4); rg[i] = g[8] || 0; }
        gl.uniform4fv(u.u_ring, rp); gl.uniform4fv(u.u_ringCol, rc); gl.uniform1fv(u.u_ringGlow, rg); gl.uniform1i(u.u_nr, nr);
      }
      if (gmTex) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, gmTex); gl.uniform1i(u.u_gm, 8); gl.uniform4fv(u.u_gmBox, gmBox); }
      if (lmTex) { gl.activeTexture(gl.TEXTURE9); gl.bindTexture(gl.TEXTURE_2D, lmTex); gl.uniform1i(u.u_lm, 9); gl.uniform4fv(u.u_lmBox, lmBox); gl.uniform1f(u.u_lmK, lmK * (opt.lightMapScale !== undefined ? opt.lightMapScale : 1)); }
      gl.uniform1f(u.u_falloff, (opt.falloff || (night ? 'window' : 'linear')) === 'window' ? 1 : 0);
      const qf = Math.max(0.25, Q.shadow || 1), qr = Q.shadowReach || 1;
      gl.uniform4f(u.u_qual, Math.max(2, Math.min(32, Q.occSteps || 8)), Math.max(2, Math.min(64, Q.beamSteps || 12)), 1 / qf, Q.aoRadius || 1);
      if (night) {
        // THE NIGHT MODEL's own uniforms (see FS_NIGHT); light: { model: 'night', moon, moonCol, skyCol, earthCol,
        // fogCol, fog: [density, thinning, moon in the haze], fogNear, rim, rimWarm, emissive, floorCol, floor (GLSL),
        // floorParams (up to 8 [x, y, z, w], read as u_floor), floorUniforms (function (gl, uniforms): sets the floor's own) }
        const fg = env.fog || [0, 0, 0];
        gl.uniformMatrix4fv(u.u_inv, false, M.inv); gl.uniform3fv(u.u_eye, M.eye); gl.uniform3fv(u.u_fwd, M.f);
        gl.uniform3fv(u.u_moon, env.moon); gl.uniform3fv(u.u_moonCol, env.moonCol); gl.uniform3fv(u.u_skyCol, env.skyCol); gl.uniform3fv(u.u_earthCol, env.earthCol || [0, 0, 0]);
        gl.uniform3fv(u.u_fogCol, env.fogCol || [0, 0, 0]); gl.uniform3fv(u.u_floorCol, env.floorCol || [0.1, 0.09, 0.08]);
        gl.uniform4f(u.u_fog, fg[0], fg[1], fg[2] || 0, 0); gl.uniform1f(u.u_time, opt.time || 0); gl.uniform1f(u.u_ground, opt.ground || 0);
        gl.uniform4fv(u.u_hmBox, hmBox); gl.uniform3f(u.u_hmK, 255 * hmStep, 255 * hmStep - 0.875 * U * 10, U);
        gl.uniform4f(u.u_q, opt.shadows ? Math.min(160, Math.round((opt.cheap ? 22 : 48) * qf * qr)) : 0, opt.ao ? 1 : 0, opt.beams === false ? 0 : 1, env.emissive !== undefined ? env.emissive : 3);
        gl.uniform4f(u.u_qual2, Math.pow(1.13, 1 / qf), Math.max(1, Math.min(16, Q.aoDirs || 6)), Q.shadowSoft || 1, 0);
        gl.uniform4f(u.u_look, env.fogNear || 0, env.rim || 0, 0, env.rimWarm || 0);
        const CT = opt.contacts || [], nc = Math.min(CONTACTS, CT.length), cv = new Float32Array(CONTACTS * 4); for (let i = 0; i < nc; i++) cv.set(CT[i].slice(0, 4), i * 4);
        gl.uniform4fv(u.u_contact, cv); gl.uniform1i(u.u_ncontact, nc);
        if (env.floor) { const fp = new Float32Array(32); (env.floorParams || []).slice(0, 8).forEach(function (v, i) { fp.set(v.slice(0, 4), i * 4); }); gl.uniform4fv(u.u_floor, fp); if (env.floorUniforms) env.floorUniforms(gl, u); }
      } else {
      gl.uniformMatrix4fv(u.u_inv, false, M.inv); gl.uniform3fv(u.u_sun, sun); gl.uniform3fv(u.u_sunCol, env.sunCol); gl.uniform3fv(u.u_skyCol, env.skyCol); gl.uniform3fv(u.u_bounceCol, env.bounceCol);
      gl.uniform3fv(u.u_hazeCol, env.hazeCol); gl.uniform3fv(u.u_outer, env.outer); gl.uniform3fv(u.u_eye, M.eye); gl.uniform3fv(u.u_fwd, M.f);
      gl.uniform4f(u.u_world, 0, 0, opt.ground || 0, opt.time || 0); gl.uniform4fv(u.u_hmBox, hmBox); gl.uniform3f(u.u_hmK, 255 * hmStep, 255 * hmStep - 2.5 * U, U);
      gl.uniform4f(u.u_hh, env.hazeH ? env.hazeH[0] : 0, env.hazeH ? env.hazeH[1] : 0, 0, 0);
      // the shadow's softness follows the sun: its edge is wider on the ground when the light comes in low
      // (env.soft, if given, sets it instead: near 0 for a hard light from far away)
      gl.uniform4f(u.u_fx, opt.shadows ? (env.soft !== undefined ? Math.max(0.001, env.soft) : 0.1 * sun[2] + 0.012) * (Q.shadowSoft || 1) : 0, opt.ao ? 0.9 : 0, env.glow, opt.shadows ? env.cloud || 0 : 0);
      // the sun's direction as it lies on the screen, two pixels long (for the rim)
      const sx = M.r[0] * sun[0] + M.r[1] * sun[1], sy = M.u[0] * sun[0] + M.u[1] * sun[1] + M.u[2] * sun[2], sl = Math.hypot(sx, sy) || 1;
      gl.uniform4f(u.u_view, sx / sl * 2, sy / sl * 2, M.back - 140 * U, 760 * U);
      gl.uniform4f(u.u_tone, env.exposure, env.hazeK, M.ortho ? 0 : 1, 0);
      // the full walk: ${STEPS} steps to ${REACH} units, 16 occlusion samples. cheap: 14 longer steps to 90 units, 4 samples
      if (opt.cheap) { gl.uniform4f(u.u_walk, Math.min(160, Math.round(14 * qf * qr)), Math.pow(1.22, 1 / qf), 9 * U / qf, 90 * U * qr); gl.uniform1f(u.u_dirs, Q.aoDirs ? Math.min(16, Q.aoDirs) : 4); }
      else { gl.uniform4f(u.u_walk, Math.min(160, Math.round(STEPS * qf * qr)), Math.pow(1.09, 1 / qf), 4.6 * U / qf, REACH * U * qr); gl.uniform1f(u.u_dirs, Q.aoDirs ? Math.min(16, Q.aoDirs) : 8); } gl.uniform1f(u.u_water, opt.water || -9);
      }
      const blobs = new Float32Array(BLOBS * 4), low = new Float32Array(BLOBS), B = opt.blobs || [];
      B.slice(0, BLOBS).forEach(function (b, i) { blobs.set(b.slice(0, 4), i * 4); low[i] = b[4]; });
      const nl = putLights(opt.lamps || [], night ? 1 : 0); putCones(opt.cones || [], opt.coneBlockers || null, opt.coneTable || null);
      // only the rows in use go up: the shader reads no further than u_nl and u_ns
      gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, ltTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (nl > 8) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LIGHTS, 3, gl.RGBA, gl.FLOAT, ltData.subarray(0, LIGHTS * 12));
      if (ns) gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 3, LIGHTS, 4, gl.RGBA, gl.FLOAT, ltData.subarray(LIGHTS * 12));
      gl.uniform1i(u.u_lt, 5); gl.uniform1i(u.u_nl, nl); gl.uniform1f(u.u_lampCap, opt.lampCap || 0);
      gl.uniform4fv(u.u_lamp, lampU); gl.uniform4fv(u.u_lampCol, lampC); gl.uniform1fv(u.u_lampHalo, lampH);
      if (ns) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, coneTex); gl.uniform1i(u.u_cone, 6); gl.uniform1i(u.u_ns, ns); }
      if (!night) { gl.uniform4fv(u.u_blob, blobs); gl.uniform1fv(u.u_blobLow, low); gl.uniform1i(u.u_nblob, Math.min(BLOBS, B.length)); }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.activeTexture(gl.TEXTURE0);

      // THE FX HOOK: the game draws particles (sparks, tracers, smoke) into the lit picture, with the slice pass's
      // depth buffer attached (it holds depths where the slices were drawn with the depth test: hsr or voxel mode).
      // The picture is tone-mapped colour; its alpha is how much each pixel blooms. The engine's state is put back after.
      if (opt.fx && !opt.heat) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, litF); gl.viewport(0, 0, iw, ih); opt.fx(gl, M, { w: iw, h: ih, hdr: !!HD });
        gl.disable(gl.BLEND); gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE); gl.depthMask(true); gl.bindVertexArray(vaoFull); gl.activeTexture(gl.TEXTURE0);
      }

      // bloom: what glows, shrunk to a quarter, blurred across and down, then again wider
      const PO = opt.post || {}, knee = PO.knee || env.knee || 1;
      if (opt.bloom && !opt.heat) {
        const pb = film ? variant('knee', VS_FULL, FS_KNEE, []) : HD ? variant('bh', VS_FULL, FS_BRIGHT, ['HDR_ON']) : pBright;
        pass(blF[0], bw, bh, pb, litT); gl.uniform2f(pb.u.u_px, 1 / iw, 1 / ih); gl.uniform1f(pb.u.u_knee, knee); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        (fxh === 1 ? [[1.2, 0], [0, 1.2], [2.4, 0], [0, 2.4], [5.2, 0], [0, 5.2]] : [[1.2, 0], [0, 1.2], [2.6, 0], [0, 2.6]]).forEach(function (s, i) { pass(blF[1 - (i & 1)], bw, bh, pBlur, bl[i & 1]); gl.uniform2f(pBlur.u.u_step, s[0] / bw, s[1] / bh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); });
      }

      // the depth of field's soft copy: the whole picture at a quarter, blurred
      const dof = film && PO.dof && PO.dof[3] > 0 && !opt.heat;
      if (dof) {
        const pd = variant('down', VS_FULL, FS_DOWN, []);
        pass(HD.fboDof[0], bw, bh, pd, litT); gl.uniform2f(pd.u.u_px, 1 / iw, 1 / ih); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        (fxh === 1 ? [[1, 0], [0, 1], [2, 0], [0, 2]] : [[1, 0], [0, 1]]).forEach(function (s, i) { pass(HD.fboDof[1 - (i & 1)], bw, bh, pBlur, HD.dof[i & 1]); gl.uniform2f(pBlur.u.u_step, s[0] / bw, s[1] / bh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); });
      }
      // to the canvas: the lit picture with its bloom, or the overdraw heat map, scaled up without smoothing
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      if (ss) gl.viewport(0, 0, W, H); else gl.viewport((W - iw * scale) >> 1, (H - ih * scale) >> 1, iw * scale, ih * scale); gl.activeTexture(gl.TEXTURE0);
      if (opt.heat) { gl.useProgram(pHeat.p); gl.bindTexture(gl.TEXTURE_2D, countTex); gl.uniform1i(pHeat.u.u_count, 0); gl.uniform1i(pHeat.u.u_channel, opt.heat - 1); gl.uniform1f(pHeat.u.u_unit, UNIT); }
      else if (film) {
        const pp = variant('film', VS_FULL, FS_FILM, []), gr = PO.grade || [0, 0, 1.12, 1], fo = PO.dof || [30, 12, -1, 0];
        gl.useProgram(pp.p); gl.bindTexture(gl.TEXTURE_2D, litT); gl.uniform1i(pp.u.u_tex, 0);
        gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bl[0]); gl.uniform1i(pp.u.u_bloom, 1);
        gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, HD.dof[0]); gl.uniform1i(pp.u.u_dof, 2);
        gl.uniform2f(pp.u.u_size, iw, ih);
        gl.uniform4f(pp.u.u_k, opt.bloom ? (PO.bloom !== undefined ? PO.bloom : 0.6) : 0, PO.vignette !== undefined ? PO.vignette : 0.35, PO.grain || 0, PO.exposure || env.exposure || 1);
        gl.uniform4f(pp.u.u_focus, fo[0], fo[1], fo[2], dof ? fo[3] : 0); gl.uniform4fv(pp.u.u_grade, gr); gl.uniform1f(pp.u.u_time, opt.time || 0); gl.uniform3f(pp.u.u_ss, ss ? 1 : 0, 0.25 / W, 0.25 / H);
      }
      else {
        const pp = HD ? variant('ph', VS_FULL, FS_POST, ['HDR_ON']) : pPost;
        gl.useProgram(pp.p); gl.bindTexture(gl.TEXTURE_2D, litT); gl.uniform1i(pp.u.u_tex, 0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bl[0]); gl.uniform1i(pp.u.u_bloom, 1);
        gl.uniform2f(pp.u.u_size, iw, ih); gl.uniform2f(pp.u.u_k, opt.bloom ? 0.55 + 0.75 * env.glow : 0, 0.22); if (HD) gl.uniform1f(pp.u.u_exp, env.exposure); gl.uniform3f(pp.u.u_ss, ss ? 1 : 0, 0.25 / W, 0.25 / H);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // GPU time for the frame, when the browser offers a timer (many do not)
      if (timing) { gl.endQuery(timerExt.TIME_ELAPSED_EXT); timing = false; }
      else if (query && gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(timerExt.GPU_DISJOINT_EXT)) E.stats.gpuMs = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        gl.deleteQuery(query); query = null;
      }
      E.stats.cpuMs = performance.now() - t0; E.stats.iw = iw; E.stats.ih = ih;
    };
    // the height of what each pixel of the last frame shows (0 where nothing was drawn): for comparing two ways of drawing
    E.heights = function () {
      const d = new Uint8Array(iw * ih * 4), h = new Float32Array(iw * ih);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboG); gl.readBuffer(gl.COLOR_ATTACHMENT1); gl.readPixels(0, 0, iw, ih, gl.RGBA, gl.UNSIGNED_BYTE, d); gl.readBuffer(gl.COLOR_ATTACHMENT0);
      for (let i = 0; i < h.length; i++) h[i] = (d[i * 4] * 256 + d[i * 4 + 1]) / 65535 * HMAX;
      return h;
    };
    // wait until the GPU has really finished the frame (reading a pixel back forces it)
    E.finish = function () { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); };
    if (!opts || opts.warm !== false) E.warm(opts && opts.warm ? opts.warm : { cones: true });
    return E;
  }

  // What the characters' draw functions call: queues slices of a figure standing at world scale `scale`.
  // lift: the height of the ground the figure stands on.
  function figureWriter(list, scale, lift) {
    const put = function (st, i, x, y, z, rot) { const it = newItem(st, x * scale, y * scale, z * scale + (lift || 0), rot, scale); it.only = i; list.push(it); };
    return {
      // k (optional): this one slice drawn k times as wide, as thick as before
      slice: function (st, i, x, y, z, rot, k) { put(st, i, x, y, z, rot); if (k) { const it = list[list.length - 1]; it.scale *= k; it.zs = 1 / k; } },
      stack: function (st, x, y, z, rot) { for (let i = 0; i < st.slices.length; i++) put(st, i, x, y, z + st.slices[i].z, rot); },
      // (as many slices as it takes to keep them less than a layer apart, so a limb is solid from the side too)
      limb: function (st, a, b, n) { n = Math.max(n, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.8)); for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; put(st, 0, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - 0.5, 0); } }
    };
  }

  // An item with every field the engine reads, the number fields already doubles (see SHAPES in create). Items made
  // this way all share one hidden class, which keeps the build loop's reads fast; a game's own items do best with the
  // same fields in the same order.
  function newItem(stack, x, y, z, rot, scale) {
    const it = { stack: null, x: 0.5, y: 0.5, z: 0.5, rot: 0.5, scale: 1.5, only: -1, shx: 0.5, shy: 0.5, zs: 1.5, fade: 0.5, row: 0, lift: false, each: null, reach: 0.5 };
    it.shx = 0; it.shy = 0; it.zs = 1; it.fade = 0; it.reach = 0;
    if (stack) { it.stack = stack; it.x = x; it.y = y; it.z = z || 0; it.rot = rot || 0; it.scale = scale || 1; }
    return it;
  }

  // A horde: thousands of moving stacks every frame. Making a new item for each of them every frame is garbage for
  // the collector to sweep; a pool hands out the same items again. Once a frame: begin(list). Then per thing:
  // add(stack, x, y, z, rot, scale), which puts a reused item on the list and returns it (set fade, zs, shx... on it
  // as needed: every optional field is reset). Animation is a choice of stack: one stack per gait frame, picked
  // from the thing's phase, so a moving horde costs no more to draw than a standing one.
  function itemPool() {
    const pool = []; let n = 0, out = null;
    return {
      begin: function (list) { out = list; n = 0; },
      add: function (stack, x, y, z, rot, scale) {
        let it = pool[n]; if (!it) { it = newItem(); pool.push(it); } n++;
        it.stack = stack; it.x = x; it.y = y; it.z = z || 0; it.rot = rot || 0; it.scale = scale || 1; it.only = -1;
        it.shx = 0; it.shy = 0; it.zs = 1; it.fade = 0; it.row = 0; it.lift = false; it.each = null; it.reach = 0;
        out.push(it); return it;
      },
      get size() { return pool.length; }
    };
  }

  global.Engine = { create: create, figureWriter: figureWriter, cameraMatrices: cameraMatrices, itemPool: itemPool, item: newItem, HMAX: HMAX };
})(window);
