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
(function (global) {
  'use strict';
  const FL = 12;                      // floats per instance: pos 3, rot 1, rect 4, offset 2, scale 1, box height 1 (voxel mode)
  const NB = 2048, ZQ = 16;           // height buckets, and buckets per unit of height
  const HMAX = 128;                   // tallest thing the G-buffer and the height map can hold
  const LAMPS = 8, BLOBS = 24, STEPS = 48, REACH = 195;
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
  function cameraMatrices(cam, aspect) {
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch), cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw);
    const f = [cp * cy, cp * sy, -sp], r = [sy, -cy, 0], u = [cy * sp, sy * sp, cp];
    const ortho = cam.mode !== 'persp', th = Math.tan(cam.fov / 2), back = ortho ? 1500 : cam.dist;
    const eye = [cam.tx - f[0] * back, cam.ty - f[1] * back, (cam.tz || 0) - f[2] * back];      // tz: the height of the point looked at (the ground, unless set)
    const dot = function (a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; };
    const V = new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, eye), -dot(u, eye), dot(f, eye), 1]);
    let P;
    if (ortho) { const hh = cam.dist * th, hw = hh * aspect, n = 1, fr = 3200; P = new Float32Array([1 / hw, 0, 0, 0, 0, 1 / hh, 0, 0, 0, 0, -2 / (fr - n), 0, 0, 0, -(fr + n) / (fr - n), 1]); }
    else { const n = Math.max(2, cam.dist * 0.05), fr = cam.dist * 3 + 1400; P = new Float32Array([1 / (th * aspect), 0, 0, 0, 0, 1 / th, 0, 0, 0, 0, -(fr + n) / (fr - n), -1, 0, 0, -2 * fr * n / (fr - n), 0]); }
    const vp = mul(P, V);
    return { vp: vp, inv: invert(vp), eye: eye, f: f, r: r, u: u, ortho: ortho, th: th, cp: cp, px: P[0], py: P[5], back: back };
  }

  // ---------------------------------------------------------------- shaders
  const VS_SLICE = `#version 300 es
  layout(location=0) in vec3 a_pos; layout(location=1) in float a_rot; layout(location=2) in vec4 a_rect;
  layout(location=3) in vec2 a_off; layout(location=4) in float a_scale; layout(location=5) in vec2 a_corner;
  uniform mat4 u_vp; uniform float u_guard;                 // u_guard: half a pixel, in clip units (0 turns it off)
  out vec2 v_uv; flat out vec4 v_rect; flat out vec2 v_cs; out float v_h;
  void main() {
    vec2 corner = a_corner;                                 // (0,0) (1,0) (0,1) (1,1): the same four for every instance
    float c = cos(a_rot), s = sin(a_rot);
    vec2 l = (a_off + (corner - 0.5) * a_rect.zw) * a_scale, m = a_off * a_scale;
    vec4 p = u_vp * vec4(a_pos + vec3(l.x * c - l.y * s, l.x * s + l.y * c, 0.0), 1.0);
    vec4 q = u_vp * vec4(a_pos + vec3(m.x * c - m.y * s, m.x * s + m.y * c, 0.0), 1.0);   // the middle of the slice
    // A slice seen edge-on has no height on screen and would vanish between pixel rows. Push every corner half a
    // pixel away from the slice's middle line, so it always covers at least one row.
    p.y += (p.y / p.w >= q.y / q.w ? 1.0 : -1.0) * u_guard * p.w;
    gl_Position = p; v_uv = a_rect.xy + corner * a_rect.zw; v_rect = a_rect; v_cs = vec2(c, s); v_h = a_pos.z;
  }`;
  const FS_G = `#version 300 es
  precision highp float;
  uniform sampler2D u_atlas;
  in vec2 v_uv; flat in vec4 v_rect; flat in vec2 v_cs; in float v_h;
  layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
  void main() {
    vec4 t = texelFetch(u_atlas, ivec2(clamp(v_uv, v_rect.xy, v_rect.xy + v_rect.zw - 0.001)), 0);
    if (t.r == 0.0) discard;                                // an empty pixel of the slice
    vec3 n = t.gba * 2.0 - 1.0; n.xy = vec2(n.x * v_cs.x - n.y * v_cs.y, n.x * v_cs.y + n.y * v_cs.x);   // turn the facing with the slice
    o0 = vec4(t.r, n * 0.5 + 0.5);                          // palette index, facing
    float h = clamp(v_h / ${HMAX}.0, 0.0, 1.0) * 65535.0, hi = floor(h / 256.0);
    o1 = vec4(hi / 255.0, (h - hi * 256.0) / 255.0, 0.0, 0.0);   // height, 16 bits (the other two are voxel mode's)
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
  layout(location=0) in vec3 a_pos; layout(location=1) in float a_rot; layout(location=2) in vec4 a_rect;
  layout(location=3) in vec2 a_off; layout(location=4) in float a_scale; layout(location=5) in vec3 a_box; layout(location=6) in float a_span;
  uniform mat4 u_vp; uniform vec3 u_eye, u_fwd; uniform float u_ortho;
  out vec3 v_p, v_d; flat out vec4 v_rect, v_base; flat out vec3 v_how; flat out vec2 v_off;
  void main() {
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
    vec3 dir = normalize(v_d); vec2 size = v_rect.zw;
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
  flat in vec2 v_off;
  uniform vec3 u_eye, u_fwd;
  layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
  void main() {
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
  void main() {
    vec4 a; float hw; if (!sprite(a, hw)) discard;
    float c = cos(v_rot), s = sin(v_rot); vec3 n = a.gba * 2.0 - 1.0; n.xy = vec2(n.x * c - n.y * s, n.x * s + n.y * c);
    o0 = vec4(a.r, n * 0.5 + 0.5);
    float h = clamp(hw / ${HMAX}.0, 0.0, 1.0) * 65535.0, hi = floor(h / 256.0);
    o1 = vec4(hi / 255.0, (h - hi * 256.0) / 255.0, 0.0, 1.0);
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
  uniform sampler2D u_g0, u_g1, u_pal, u_hm;
  uniform mat4 u_inv;
  uniform vec3 u_sun, u_sunCol, u_skyCol, u_bounceCol, u_hazeCol, u_outer, u_eye, u_fwd;
  uniform vec4 u_world;       // the map's width and depth, the level of open ground, the time in seconds
  uniform vec4 u_fx;          // shadow softness (0: no shadows), occlusion strength, how far the lamps are lit, cloud shadows
  uniform vec4 u_view;        // the direction to the sun on screen (xy, pixels), where the haze starts, how deep it is
  uniform vec4 u_tone;        // exposure, haze strength, 1 for the perspective camera
  uniform vec4 u_walk;        // the shadow walk: steps, how much each grows, the longest, the reach
  uniform float u_dirs;       // ambient occlusion: directions sampled (8, or 4 at one distance for the low preset)
  uniform float u_water;      // the palette index of water
  uniform vec4 u_lamp[${LAMPS}]; uniform vec3 u_lampCol[${LAMPS}];
  uniform vec4 u_blob[${BLOBS}]; uniform float u_blobLow[${BLOBS}]; uniform int u_nblob;
  in vec2 v_uv; out vec4 o;

  float land(vec2 p) { return textureLod(u_hm, p / u_world.xy, 0.0).r * 127.5; }            // smoothed between cells
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
    c = 1.0 - exp(-pow(max(c * u_tone.x, 0.0), vec3(1.25)) * 1.7);
    float l = dot(c, vec3(0.299, 0.587, 0.114));
    c = mix(vec3(l), c, 1.16);
    c += vec3(0.022, 0.006, -0.022) * smoothstep(0.4, 1.0, l) + vec3(-0.014, 0.0, 0.022) * (1.0 - smoothstep(0.0, 0.45, l));
    return clamp(c, 0.0, 1.0);
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
    float t = u_world.w;

    // The edge of the map dissolves into haze: no hard border, and things driving off it fade out.
    vec2 over = max(-p.xy, p.xy - u_world.xy);
    float fade = smoothstep(-24.0, 92.0, length(max(over, 0.0)) + min(max(over.x, over.y), 0.0) + (vnoise(p.xy * 0.012) - 0.5) * 30.0);
    if (fade > 0.995) { o = vec4(finish(u_hazeCol), 0.0); return; }

    vec4 pal = texelFetch(u_pal, ivec2(int(g0.r * 255.0 + 0.5), 0), 0);
    vec3 alb = outer ? mix(beyond(p.xy), u_outer, smoothstep(0.1, 0.5, fade)) : pal.rgb;      // the made-up fields lose their detail first
    vec3 n = outer ? vec3(0.0, 0.0, 1.0) : normalize(g0.gba * 2.0 - 1.0);
    float glow = outer ? 0.0 : pal.a;
    bool wet = !outer && abs(g0.r * 255.0 - u_water) < 1.5;
    if (wet) {                                              // water: ripples that drift, one art pixel each
      vec2 q = floor(p.xy);
      n = normalize(vec3(vnoise(q * 0.45 + vec2(t * 0.7, t * 1.1)) - 0.5, vnoise(q * 0.8 - vec2(t * 0.9, t * 0.4)) - 0.5, 1.6));
    }

    // Soft shadows. Walk from the pixel towards the sun over the height map, in steps that grow (1.3 units at
    // first, 4.6 at most), and keep the smallest clearance over the land, measured against the distance walked:
    // a ray that only just clears a roof far away is in the penumbra, so shadows are sharp at the foot of a wall
    // and soft at their tips. The walk ends after ${REACH} units; shadows fade out there instead of stopping dead.
    float sh = 1.0;
    if (u_fx.x > 0.0) {
      vec3 q = p + vec3(n.xy * 3.5, 1.3);                   // start off the surface (and clear of the eaves)
      // (every art pixel takes steps of a slightly different length, which turns the banding of a coarse walk into
      // a fine dither that stays put on the ground)
      float d = 0.0, ds = 1.3, jit = 0.78 + 0.44 * hash(floor(p.xy) + floor(p.z) * 7.31);
      for (int i = 0; i < ${STEPS}; i++) {
        if (float(i) >= u_walk.x) break;
        d += ds * jit; ds = min(ds * u_walk.y, u_walk.z);
        vec3 s = q + u_sun * d;
        sh = min(sh, mix(clamp((s.z - land(s.xy)) / (u_fx.x * d), 0.0, 1.0), 1.0, smoothstep(u_walk.w * 0.7, u_walk.w, d)));
        if (sh <= 0.0 || s.z > 125.0) break;
      }
      sh = sh * sh * (3.0 - 2.0 * sh);
      // Moving things are not in the height map. Each is an upright cylinder (soldiers, the jeep) or a blob in
      // the air (smoke, birds): the ray to the sun is tested against its axis.
      for (int i = 0; i < ${BLOBS}; i++) {
        if (i >= u_nblob) break;
        vec4 B = u_blob[i]; vec2 dd = B.xy - p.xy; float k = dot(dd, u_sun.xy) / dot(u_sun.xy, u_sun.xy);
        if (k > 0.5) {
          float z = p.z + u_sun.z * k, r = length(dd - u_sun.xy * k);
          sh *= 1.0 - 0.72 * smoothstep(B.w * 1.2, B.w * 0.5, r) * smoothstep(u_blobLow[i] - 1.5, u_blobLow[i] + 0.5, z) * (1.0 - smoothstep(B.z - 0.5, B.z + 1.5, z));
        }
      }
      // cloud shadows: two layers of slow noise sliding over the land
      float cl = vnoise(p.xy * 0.0058 + t * vec2(0.045, 0.028)) * 0.65 + vnoise(p.xy * 0.017 - t * vec2(0.02, 0.05)) * 0.35;
      sh *= 1.0 - u_fx.w * smoothstep(0.5, 0.78, cl);
    }

    // Ambient occlusion from the height map: look round the pixel at two distances and see how much of the
    // land there rises above it. A corner between ground and wall, or the ground under a hedge, gets less of
    // the sky. Walls are sampled out in front of themselves, and darken a little towards their foot (contact).
    float ao = 1.0;
    if (u_fx.y > 0.0) {
      vec2 c0 = p.xy + n.xy * 3.0; float occ = 0.0;
      for (int i = 0; i < 8; i++) {
        if (float(i) >= u_dirs) break;
        float an = float(i) * 6.2832 / u_dirs + 0.4; vec2 dir = vec2(cos(an), sin(an));
        if (u_dirs > 4.5) occ += clamp((land(c0 + dir * 2.5) - p.z - 1.0) / 2.5, 0.0, 1.0) * 0.55 + clamp((land(c0 + dir * 7.5) - p.z - 1.0) / 7.5, 0.0, 1.0) * 0.45;
        else occ += clamp((land(c0 + dir * 4.5) - p.z - 1.0) / 4.5, 0.0, 1.0);
      }
      ao = 1.0 - occ / u_dirs;
      if (n.z < 0.6) ao *= mix(0.68, 1.0, smoothstep(0.0, 7.0, p.z - land(p.xy + n.xy * 4.5)));
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
      light += u_sunCol * smoothstep(3.0, 9.0, drop) * 0.3 * (0.25 + 0.75 * sh);
    }
    vec3 col = alb * light;
    if (wet) {                                              // water also mirrors the sky and glints
      vec3 v = normalize(u_eye - p), hv = normalize(u_sun + v);
      col = col * 0.75 + u_skyCol * 0.3 + u_sunCol * pow(max(dot(n, hv), 0.0), 120.0) * sh;
    }
    // Lamps: point lights that fall off to nothing at their reach.
    for (int i = 0; i < ${LAMPS}; i++) {
      vec4 L = u_lamp[i];
      if (L.w > 0.0) { vec3 d3 = L.xyz - p; float r = length(d3), att = max(0.0, 1.0 - r / L.w); col += alb * u_lampCol[i] * att * att * (0.3 + 0.7 * max(dot(n, d3 / max(r, 0.001)), 0.0)); }
    }
    // Pixels that shine. A glow of 1 in the palette always shines (fire). A smaller glow is a lamp or a window:
    // dull by day, and lit as dusk falls. The amount goes out in alpha, and the bloom pass spreads it.
    float e = glow > 0.98 ? 1.0 : glow * u_fx.z;
    if (glow > 0.0) { if (glow <= 0.98) col *= 0.45; col = mix(col, alb * 1.7, e); }

    // Haze: things further into the picture take on the colour of the air.
    float hz = clamp((dot(p - u_eye, u_fwd) - u_view.z) / u_view.w, 0.0, 1.0);
    col = mix(col, u_hazeCol, hz * hz * u_tone.y * (1.0 - e));
    col = mix(col, u_hazeCol, fade);
    o = vec4(finish(col), e * (1.0 - fade));
  }`;
  const FS_HEAT = `#version 300 es
  precision highp float;
  uniform sampler2D u_count; uniform int u_channel; uniform float u_unit;
  in vec2 v_uv; out vec4 o;
  void main() {
    vec4 c = texture(u_count, v_uv); float n = (u_channel == 0 ? c.r : c.g) / u_unit;
    // 0 black, 1 dark blue, 4 green, 16 yellow, 64 red, 256 white (a step of colour for every doubling)
    float t = n < 0.5 ? 0.0 : (log2(n) + 1.0) / 9.0;
    vec3 col = t <= 0.0 ? vec3(0.0) : t < 0.33 ? mix(vec3(0.05, 0.10, 0.45), vec3(0.10, 0.75, 0.35), t / 0.33)
      : t < 0.55 ? mix(vec3(0.10, 0.75, 0.35), vec3(0.98, 0.90, 0.20), (t - 0.33) / 0.22)
      : t < 0.78 ? mix(vec3(0.98, 0.90, 0.20), vec3(0.92, 0.15, 0.12), (t - 0.55) / 0.23) : mix(vec3(0.92, 0.15, 0.12), vec3(1.0), min(1.0, (t - 0.78) / 0.22));
    o = vec4(col, 1.0);
  }`;
  // Bloom, in three small shaders. Bright: keep only what glows (colour times the alpha the light pass wrote),
  // shrunk to a quarter. Blur: nine taps along one axis, run across then down, twice. Post: add the blur back
  // over the sharp picture ("screen", so it cannot go past white) and darken the corners a little (vignette).
  const FS_BRIGHT = `#version 300 es
  precision highp float;
  uniform sampler2D u_tex; uniform vec2 u_px; in vec2 v_uv; out vec4 o;
  void main() {
    vec4 a = texture(u_tex, v_uv + vec2(-1.0, -1.0) * u_px), b = texture(u_tex, v_uv + vec2(1.0, -1.0) * u_px), c = texture(u_tex, v_uv + vec2(-1.0, 1.0) * u_px), d = texture(u_tex, v_uv + vec2(1.0, 1.0) * u_px);
    o = vec4((a.rgb * a.a + b.rgb * b.a + c.rgb * c.a + d.rgb * d.a) * 0.25, 1.0);
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
  uniform sampler2D u_tex, u_bloom; uniform vec2 u_size; uniform vec2 u_k;      // u_k: bloom strength, vignette strength
  in vec2 v_uv; out vec4 o;
  void main() {
    vec3 c = texelFetch(u_tex, ivec2(min(v_uv * u_size, u_size - 1.0)), 0).rgb;  // the nearest internal pixel: no smoothing
    vec3 b = min(texture(u_bloom, v_uv).rgb * u_k.x, 1.0);
    c = 1.0 - (1.0 - c) * (1.0 - b);
    vec2 d = v_uv - 0.5; c *= 1.0 - u_k.y * dot(d, d) * 1.6;
    o = vec4(c, 1.0);
  }`;

  function create(canvas) {
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
    let iw = 0, ih = 0, bw = 0, bh = 0, g0, g1, lit, countTex, depth, fboG, fboLit, fboCount, bloom = [], fboBloom = [];
    function targets(w, h) {
      if (w === iw && h === ih) return; iw = w; ih = h; bw = Math.max(1, w >> 2); bh = Math.max(1, h >> 2);
      g0 = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); g1 = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE); lit = texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR);
      countTex = floatOK ? texture(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT) : texture(w, h, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
      depth = gl.createRenderbuffer(); gl.bindRenderbuffer(gl.RENDERBUFFER, depth); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      fboG = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboG);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, g0, 0); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, g1, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth); gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      fboLit = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboLit); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, lit, 0);
      fboCount = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboCount); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, countTex, 0);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
      for (let i = 0; i < 2; i++) { bloom[i] = texture(bw, bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, null, gl.LINEAR); fboBloom[i] = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fboBloom[i]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, bloom[i], 0); }
    }

    const E = { gl: gl, renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown', stats: { instances: 0, slices: 0, cpuMs: 0, gpuMs: null, written: null, covered: null } };
    let palTex = null, hmTex = null, world = [1, 1], query = null, timing = false;
    const UNIT = floatOK ? 1 : 1 / 255;                      // without float targets the count stops at 255

    E.makeAtlas = function (data, size) { return texture(size, size, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, data); };
    E.setPalette = function (bytes) { palTex = texture(256, 1, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bytes); };
    // the height map for shadows and occlusion: one byte per ground cell, the height of the tallest thing standing
    // on it (in half units). It is read with smoothing, which is what rounds the shadows' edges.
    E.setHeightMap = function (bytes, w, h) { hmTex = texture(w, h, gl.R8, gl.RED, gl.UNSIGNED_BYTE, bytes, gl.LINEAR); world = [w, h]; };
    // a part of it again, when something on the map changes height (a wall lowered, a roof blown off)
    E.patchHeightMap = function (bytes, x, y, w, h) { gl.bindTexture(gl.TEXTURE_2D, hmTex); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, bytes); };

    // Turn slices into sorted instances. list: [{ stack, x, y, z, rot, scale, only (one slice index, or -1 for all),
    // shx, shy (optional: how far the stack leans per unit of height, for trees and wheat in the wind),
    // each (optional: function (layer, layers, out) -> out or null, moves or hides single slices: the slice effects) }]
    const moved = { dx: 0, dy: 0, dz: 0, rot: 0, scale: 1 };
    function build(list, M, opt) {
      const ppuOrtho = ih / (2 * opt.cam.dist * M.th), vp = M.vp, voxel = !!opt.voxel;
      let n = 0, slices = 0, tallest = 0;
      // A shell stack is hollow, so a shallow view ray must not slip between two copies of a slice and through the
      // shell: the copies have to be closer together than the shell is deep along that ray.
      const slope = Math.tan(Math.max(0.06, M.ortho ? opt.cam.pitch : opt.cam.pitch - opt.cam.fov * 0.35));
      for (let q = 0; q < list.length; q++) {
        const it = list[q], st = it.stack, sc = it.scale, one = it.only >= 0;
        // Leave out what the camera cannot see: a sphere round the stack against the edges of the view.
        const zc = one ? it.z : it.z + st.n * sc * 0.5, R = (one ? st.radius : Math.hypot(st.radius, st.n * 0.5)) * sc + (it.each ? 60 : 2);
        const cw = vp[3] * it.x + vp[7] * it.y + vp[11] * zc + vp[15], cx = vp[0] * it.x + vp[4] * it.y + vp[8] * zc + vp[12], cy = vp[1] * it.x + vp[5] * it.y + vp[9] * zc + vp[13];
        if (!M.ortho && cw < -R) continue;                     // behind the camera
        if ((M.ortho || cw > R) && (Math.abs(cx) - R * M.px > cw || Math.abs(cy) - R * M.py > cw)) continue;
        const sides = one || st.slices.length > 1 || st.slices[0].sides;
        // how many screen rows one layer of this stack is tall: that many copies of each slice
        let rows = 1;
        if (opt.fill || opt.lod || voxel) {
          if (M.ortho) rows = ppuOrtho * M.cp * sc;
          else {
            // the nearest this stack can be: its middle less its radius, but no nearer than where the lowest ray on
            // screen comes down to the stack's top (a ground tile under the camera is not really four units away)
            const reach = (M.eye[2] - it.z - st.n * sc) / Math.sin(Math.min(1.5, opt.cam.pitch + opt.cam.fov / 2)) * Math.cos(opt.cam.fov / 2);
            const d = Math.max(4, reach, (it.x - M.eye[0]) * M.f[0] + (it.y - M.eye[1]) * M.f[1] + (it.z - M.eye[2]) * M.f[2] - st.radius * sc); rows = ih / (2 * d * M.th) * Math.min(1, M.cp + 0.25) * sc * 1.15;
          }
        }
        if (rows > tallest && sides && Math.abs(cx) < cw && Math.abs(cy) < cw) tallest = rows;      // the tallest layer on screen (of stacks whose middle is in view and that have sides to fill)
        // Level of detail: when a layer is thinner than a pixel on screen, several layers land on one row.
        // Keep one of every `skip` (counting down from the top, which is always kept) and leave the rest out.
        const skip = opt.lod && !one && !it.each && rows < 1 ? Math.floor(1 / rows) : 1;
        const copies = voxel ? 1 : Math.max(st.shell ? Math.ceil(1 / (st.shell * slope)) : 1, Math.min(48, Math.ceil(opt.fill ? rows : 1)));
        // voxel mode draws runs (layers that repeat merged into one taller box) unless an effect moves single slices
        const src = voxel && !one && !it.each ? st.runs : st.slices;
        const a = one ? it.only : 0, b = one ? it.only + 1 : src.length, shx = it.shx || 0, shy = it.shy || 0;
        // (a layer with no side, flat ground, needs no fill: it is drawn once, at the top of its layer)
        if (n + (b - a) * copies * 4 > cap) { while (n + (b - a) * copies * 4 > cap) cap *= 2; const i2 = new Float32Array(cap * FL), t2 = new Float32Array(cap * FL), k2 = new Uint16Array(cap); t2.set(tmp); k2.set(keys); inst = i2; tmp = t2; keys = k2; }
        for (let s = a; s < b; s++) {
          if (skip > 1 && (b - 1 - s) % skip) continue;
          const sl = src[s], first = sl.sides ? 0 : copies - 1; let x0 = it.x, y0 = it.y, z0 = it.z + (one ? 0 : sl.z * sc), rot = it.rot, k1 = sc;
          if (it.each) { const m = it.each(sl.z, st.n, moved); if (!m) continue; x0 += m.dx; y0 += m.dy; z0 += m.dz; rot += m.rot; k1 *= m.scale; }
          slices++;
          // a hollow slice is drawn as the strips round its hole (see art.js), unless that is switched off
          const parts = opt.split ? sl.parts : sl.whole;
          for (let pi = 0; pi < parts.length; pi++) {
            const pt = parts[pi];
            if (voxel) {
              // VOXEL MODE: one box per slice or run, as tall as the layers it stands for (paper thin, at the top of its layer, for ground with no side)
              const j = n * FL, up = z0 - it.z, thin = !sl.sides, tall = thin ? 0.03 : s === b - 1 ? sl.n : Math.max(sl.n, skip);
              tmp[j] = x0 + shx * up; tmp[j + 1] = y0 + shy * up; tmp[j + 2] = z0 + (thin ? (sl.n - 0.03) * k1 : 0); tmp[j + 3] = rot;
              tmp[j + 4] = pt.u; tmp[j + 5] = pt.v; tmp[j + 6] = pt.w; tmp[j + 7] = pt.h; tmp[j + 8] = pt.ox; tmp[j + 9] = pt.oy; tmp[j + 10] = k1; tmp[j + 11] = tall * k1;
              keys[n++] = NB - 1 - Math.min(NB - 1, Math.max(0, Math.floor(z0 * ZQ)));      // highest first; the depth test does the rest
              continue;
            }
            for (let k = first; k < copies; k++) {
              const z = z0 + k / copies * k1, j = n * FL, up = z - it.z;
              tmp[j] = x0 + shx * up; tmp[j + 1] = y0 + shy * up; tmp[j + 2] = z; tmp[j + 3] = rot;
              tmp[j + 4] = pt.u; tmp[j + 5] = pt.v; tmp[j + 6] = pt.w; tmp[j + 7] = pt.h; tmp[j + 8] = pt.ox; tmp[j + 9] = pt.oy; tmp[j + 10] = k1; tmp[j + 11] = 0;
              let key = Math.min(NB - 1, Math.max(0, Math.floor(z * ZQ))); if (opt.hsr) key = NB - 1 - key;      // painter: lowest first; hidden-surface removal: highest first
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
    //        lamps [[x, y, z, reach, r, g, b]], blobs [[x, y, top, radius, bottom]] }
    E.render = function (opt) {
      const t0 = performance.now(), W = canvas.width, H = canvas.height, env = opt.light;
      // the picture is drawn at 1 / scale of the canvas (scale: a whole number) and shown scale times larger, each
      // internal pixel a clean square, centred, with a thin bar where the canvas does not divide evenly
      const scale = Math.max(1, Math.round(opt.scale));
      targets(Math.max(1, Math.floor(W / scale)), Math.max(1, Math.floor(H / scale)));
      const M = cameraMatrices(opt.cam, iw / ih), n = build(opt.list, M, opt);
      if (timerExt && !query) { query = gl.createQuery(); gl.beginQuery(timerExt.TIME_ELAPSED_EXT, query); timing = true; }
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, inst.subarray(0, n * FL), gl.DYNAMIC_DRAW);
      gl.viewport(0, 0, iw, ih); gl.disable(gl.BLEND);

      // the slice pass: G-buffer only
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboG); gl.clearColor(0, 0, 0, 0); gl.clearDepth(1); gl.depthMask(true); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const pg = opt.voxel ? pGVoxel : pG, pc = opt.voxel ? pCountVoxel : pCount, tested = opt.hsr || !!opt.voxel;      // voxel mode always tests depth
      const sprites = opt.impostors && opt.impostors.length ? opt.impostors : null;
      drawSlices(pg, n, M, opt, tested);
      if (sprites) E.stats.instances += drawImpostors(pGImp, sprites, M, opt, true);

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
      const u = pLight.u, sun = env.sun;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fboLit); gl.useProgram(pLight.p); gl.bindVertexArray(vaoFull);
      [[g0, 'u_g0'], [g1, 'u_g1'], [palTex, 'u_pal'], [hmTex, 'u_hm']].forEach(function (t, i) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t[0]); gl.uniform1i(u[t[1]], i); });
      gl.uniformMatrix4fv(u.u_inv, false, M.inv); gl.uniform3fv(u.u_sun, sun); gl.uniform3fv(u.u_sunCol, env.sunCol); gl.uniform3fv(u.u_skyCol, env.skyCol); gl.uniform3fv(u.u_bounceCol, env.bounceCol);
      gl.uniform3fv(u.u_hazeCol, env.hazeCol); gl.uniform3fv(u.u_outer, env.outer); gl.uniform3fv(u.u_eye, M.eye); gl.uniform3fv(u.u_fwd, M.f);
      gl.uniform4f(u.u_world, world[0], world[1], opt.ground || 0, opt.time || 0);
      // the shadow's softness follows the sun: its edge is wider on the ground when the light comes in low
      gl.uniform4f(u.u_fx, opt.shadows ? 0.1 * sun[2] + 0.012 : 0, opt.ao ? 0.9 : 0, env.glow, opt.shadows ? env.cloud || 0 : 0);
      // the sun's direction as it lies on the screen, two pixels long (for the rim)
      const sx = M.r[0] * sun[0] + M.r[1] * sun[1], sy = M.u[0] * sun[0] + M.u[1] * sun[1] + M.u[2] * sun[2], sl = Math.hypot(sx, sy) || 1;
      gl.uniform4f(u.u_view, sx / sl * 2, sy / sl * 2, M.back - 140, 760);
      gl.uniform4f(u.u_tone, env.exposure, env.hazeK, M.ortho ? 0 : 1, 0);
      // the full walk: ${STEPS} steps to ${REACH} units, 16 occlusion samples. cheap: 14 longer steps to 90 units, 4 samples
      if (opt.cheap) { gl.uniform4f(u.u_walk, 14, 1.22, 9, 90); gl.uniform1f(u.u_dirs, 4); } else { gl.uniform4f(u.u_walk, STEPS, 1.09, 4.6, REACH); gl.uniform1f(u.u_dirs, 8); } gl.uniform1f(u.u_water, opt.water || -9);
      const lamps = new Float32Array(LAMPS * 4), lampCol = new Float32Array(LAMPS * 3), blobs = new Float32Array(BLOBS * 4), low = new Float32Array(BLOBS);
      opt.lamps.slice(0, LAMPS).forEach(function (l, i) { lamps.set(l.slice(0, 4), i * 4); lampCol.set(l.slice(4, 7), i * 3); });
      opt.blobs.slice(0, BLOBS).forEach(function (b, i) { blobs.set(b.slice(0, 4), i * 4); low[i] = b[4]; });
      gl.uniform4fv(u.u_lamp, lamps); gl.uniform3fv(u.u_lampCol, lampCol); gl.uniform4fv(u.u_blob, blobs); gl.uniform1fv(u.u_blobLow, low); gl.uniform1i(u.u_nblob, Math.min(BLOBS, opt.blobs.length));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

      // bloom: what glows, shrunk to a quarter, blurred across and down, then again wider
      if (opt.bloom && !opt.heat) {
        pass(fboBloom[0], bw, bh, pBright, lit); gl.uniform2f(pBright.u.u_px, 1 / iw, 1 / ih); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        [[1.2, 0], [0, 1.2], [2.6, 0], [0, 2.6]].forEach(function (s, i) { pass(fboBloom[1 - (i & 1)], bw, bh, pBlur, bloom[i & 1]); gl.uniform2f(pBlur.u.u_step, s[0] / bw, s[1] / bh); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); });
      }

      // to the canvas: the lit picture with its bloom, or the overdraw heat map, scaled up without smoothing
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, W, H); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.viewport((W - iw * scale) >> 1, (H - ih * scale) >> 1, iw * scale, ih * scale); gl.activeTexture(gl.TEXTURE0);
      if (opt.heat) { gl.useProgram(pHeat.p); gl.bindTexture(gl.TEXTURE_2D, countTex); gl.uniform1i(pHeat.u.u_count, 0); gl.uniform1i(pHeat.u.u_channel, opt.heat - 1); gl.uniform1f(pHeat.u.u_unit, UNIT); }
      else {
        gl.useProgram(pPost.p); gl.bindTexture(gl.TEXTURE_2D, lit); gl.uniform1i(pPost.u.u_tex, 0); gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bloom[0]); gl.uniform1i(pPost.u.u_bloom, 1);
        gl.uniform2f(pPost.u.u_size, iw, ih); gl.uniform2f(pPost.u.u_k, opt.bloom ? 0.55 + 0.75 * env.glow : 0, 0.22);
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
    return E;
  }

  // What the characters' draw functions call: queues slices of a figure standing at world scale `scale`.
  // lift: the height of the ground the figure stands on.
  function figureWriter(list, scale, lift) {
    const put = function (st, i, x, y, z, rot) { list.push({ stack: st, x: x * scale, y: y * scale, z: z * scale + (lift || 0), rot: rot, scale: scale, only: i }); };
    return {
      slice: function (st, i, x, y, z, rot) { put(st, i, x, y, z, rot); },
      stack: function (st, x, y, z, rot) { for (let i = 0; i < st.slices.length; i++) put(st, i, x, y, z + st.slices[i].z, rot); },
      // (as many slices as it takes to keep them less than a layer apart, so a limb is solid from the side too)
      limb: function (st, a, b, n) { n = Math.max(n, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.8)); for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; put(st, 0, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t - 0.5, 0); } }
    };
  }

  global.Engine = { create: create, figureWriter: figureWriter, cameraMatrices: cameraMatrices, HMAX: HMAX };
})(window);
