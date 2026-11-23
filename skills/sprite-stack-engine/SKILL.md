---
name: sprite-stack-engine
description: Render large sprite-stacked scenes (pseudo-3D pixel art built from stacks of flat slices) in WebGL2 with a free camera and controlled overdraw. Use when a sprite-stack scene must rotate, tilt, zoom or use a perspective camera; when slices show gaps or break apart; when overdraw or fill rate at high resolution is the problem; when a stacked scene needs dynamic lights and shadows; or when someone needs measured overdraw numbers rather than estimates. Covers instanced slice quads, thickness fill, the edge-on guard, height-sorted painter order, front-to-back hidden-surface removal, shell stacks, a G-buffer with deferred lighting, height-map shadows, internal resolution, and an exact overdraw count pass.
---

# Sprite stack engine

A sprite stack is an object stored as flat horizontal slices and drawn by placing them one above another.
This skill is about doing that at scene scale: many stacks, any camera, real lighting, and a fill cost that
stays near one fragment per pixel.

The reference implementation is the repository this file ships in (`js/engine.js`, about 300 lines, plus
`js/art.js` for building stacks). Read `engine.js` before writing your own.

## The pipeline

1. **Slices are instanced quads.** One quad per slice copy: world position, rotation, atlas rectangle, offset
   from the stack's axis, scale. The four corners come from `gl_VertexID`; one draw call draws everything.
2. **A slice pass writes a G-buffer, not colour.** Per pixel: palette index, facing (a normal baked per slice
   pixel and rotated with the slice), and height.
3. **A light pass runs once per screen pixel.** Colour comes from the palette; the world position is rebuilt
   from the stored height (intersect the pixel's view ray with the plane at that height); sun, shadow, fill,
   occlusion and lamps are computed there. Lighting cost no longer depends on overdraw.
4. **Bloom** (optional): what glows, at a quarter of the size, blurred and added back.
5. **Blit** to the canvas, without smoothing if the internal resolution is lower.

## Keeping stacks solid under a free camera

- **Thickness fill.** A layer is a slab, a slice is a plane. Draw each slice once for every screen row its
  layer is tall: `copies = ceil(pixelsPerUnit * cos(pitch) * layerThickness)`, at heights `z + k / copies`.
  In perspective compute it per stack from its distance. Without this, layers separate as soon as you zoom in
  or tilt down.
- **Edge-on guard.** Near the horizon a slice has almost no height on screen and falls between pixel rows.
  In the vertex shader push each corner half a pixel away from the slice's centre line in clip space, so every
  slice covers at least one row.
- **Draw order.** With a camera above the scene, the higher of two points on one view ray is always the nearer.
  So sorting by height is an exact depth sort, for a parallel and for a perspective camera, as long as every
  view ray points downward: keep `pitch > fov / 2` in perspective. Use a counting sort into height buckets;
  it is linear and runs every frame.

## Voxel mode: below the tilt where flat slices hold

Flat slices have a floor. Measure it instead of guessing: draw a view once with flat slices and once as
solid boxes, read both height buffers back, and count the pixels where the flat picture shows something more
than a layer lower. Here gaps lift off under 15 degrees with a parallel camera; a perspective camera fails
where its highest ray stops pointing down (tilt under half the field of view), because height order is no
longer depth order. Zooming in until a layer is taller than the fill's copy cap fails the same way.

Below the limit, draw each slice as a box one layer tall (top, sides, bottom; cull back faces) and let the
fragment shader walk the view ray through the slice's texels from where it enters the box to the first filled
texel, writing that point's depth with the depth test on. Stacks are then solid from any angle. Say on
screen when the mode is on (a badge), and give a key to force it, so nobody mistakes one mode for the other.

Limbs made of single slices along a bone need fill too, and slices less than a layer apart, or they read as
rows of discs from the front at any tilt.

## Keeping overdraw down

Measure first (see below). Then, in order of payoff:

1. **Hidden-surface removal.** Sort highest first, enable the depth test, write depth. A pixel that already
   has a slice rejects everything below it. Fragments written drop to about one per pixel. Quads are still
   rasterised and depth-tested, which is cheap but not free.
2. **Shell stacks.** A slice pixel deep inside a solid is always covered by the layer above. Drop every pixel
   further than two pixels from empty space when building the atlas. This cuts written fragments several
   times over even in painter order, and costs nothing at run time.
3. **Crop slices** to their filled rectangle and skip empty layers.
4. **Cull** stacks outside the view before building instances: a bounding sphere against the view's edges.
5. **Ground with no sides.** If the ground is a stack (a height field in tiles), a layer none of whose pixels
   lies on its outline has a top but no side. Draw it once, at the top of its layer, with no fill copies.
6. **Internal resolution.** Rendering at half size quarters the pixels and also halves the copies needed per
   layer, so the fill drops by about eight.

## The art is the constant; the renderer is a choice

Flat quads per slice are the simplest renderer for stack-authored art, not the only one.

- **Voxel mode as a speed switch.** The box drawing above is also the fastest way to draw the stacks at any
  tilt: no fill copies, and the rasteriser covers each slice once (here 138 covered fragments per pixel
  became 9, and the frame 2.3 ms became 0.8). Say plainly that it is a voxel-style renderer for the same art.
  Merge layers that repeat into one taller box. Cost: `gl_FragDepth` gives up the early depth test.
- **Impostors.** For a stack that never changes and is placed many times, render it ahead of time from N
  directions into an atlas holding the G-buffer's channels (material, normal, height), then draw one
  camera-facing quad and rebuild depth from the stored height. Catches: rotation in steps, one tilt of a
  parallel camera per bake, one sharp zoom, and the atlas's memory.
- **Skip thin layers.** When a layer is under a pixel tall on screen, keep one layer in every few.

## Slice effects

Give a list item a function called once per slice that moves the slice or leaves it out. Three uses:
build (slices drop in, lowest first), dismantle (slices fly off the top, spin and shrink), and cutting a
building open (leave out every slice above a sliding height, so the room inside shows). Patch the height map
as the object changes so shadows and occlusion follow. Nothing can fade: the G-buffer is opaque, so shrink.

## Weak GPUs: draw small, show large

A stack scene is bound by fill long before it is bound by lighting. Default to a pixel-art internal
resolution (360 lines) at a whole-number scale with nearest sampling, and offer native as a choice: from 1080
to 360 lines the flat quads here cover about 25 times fewer fragments, because there are a ninth of the
pixels and each layer needs a third of the copies. Offer a low preset (small, voxel mode, short shadow walk,
few occlusion samples, no bloom). Splitting hollow slices into strips cuts covered fragments but adds quads:
measure before keeping it; here it did not pay.

## Measuring overdraw (never estimate it)

Draw the same instances again into a float target with additive blending, adding 1 per fragment, then read it
back: average and maximum per pixel. Count two things separately:

- **written**: fragments that pass the alpha test (and the depth test, when it is on);
- **covered**: every fragment the quads cover, with no tests.

Show the count texture through a colour ramp for a heat map. Use `RGBA16F` (`EXT_color_buffer_float`); an
8-bit target saturates at 255.

Honesty note for reports: with a depth test and `discard`, "written" is exact, but whether the GPU ran the
fragment shader for a rejected fragment depends on its early depth test. Report "written" and "covered", not
"shaded".

## Lighting and shadows

Flat lighting (one ambient colour plus a sun) is what makes a stacked scene look like cardboard. All of the
following run in the one light pass, from the G-buffer and a height map of the static scene (tallest solid per
ground cell, one byte, read with linear filtering):

- **Normals.** Bake one per slice pixel at build time: the sum of the directions towards empty space within two
  pixels, nearer space counting more, with extra weight upward for tops. Two pixels rather than one rounds
  corners and turns roof steps into a slope. Store it beside the palette index in the atlas. Let a stack tilt
  its normals with a function (furrows, cobbles) and soften them towards "up" (grass, wheat, smoke).
- **Key and fill.** A warm low sun. No flat ambient: blend a cool sky colour and a warm earth colour by the
  normal's `z`, and add a level warm bounce on faces turned away from the sun.
- **Ambient occlusion.** Sample the height map in eight directions at two radii round the pixel; land above the
  pixel occludes. Offset the samples along the normal for walls, and darken walls towards their foot.
- **Soft shadows.** March from the pixel towards the sun in growing steps and keep the smallest
  `clearance / (softness * distance)`. Jitter the step length per art pixel to turn banding into dither. Cap the
  march and fade the shadow out at the cap. Start a few pixels off the surface along the normal to clear eaves.
- **Moving things** are not in the map: test the sun ray against a cylinder (figures, vehicles) or a blob with
  a bottom and a top (smoke, birds).
- **Rim.** If the pixel two screen pixels towards the sun is much lower, add sun colour.
- **Haze, tone, grade.** Mix towards an air colour with depth; fade the map's edge into it; roll highlights off
  with a curve rather than clipping; add a little saturation and a warm/cool split.
- **Glow and bloom.** Keep a glow value per material. Write it to alpha, blur `colour * alpha` at quarter size,
  add it back. Scale the glow of lamps and windows by the time of day; leave fire at full.
- A height map has no overhangs: a lamp head, a pole's cross-arm or a balcony casts the shadow of a full
  pillar. Leave such parts out of the map.

## When a mesh is the better tool

- Views from below or level with the horizon: height order stops being depth order, and slices are edge-on.
- Large smooth or sloped surfaces seen close up: a stack shows stair-steps at one layer per row.
- Thin overhanging detail and anything that must cast an exact shadow.
- Scenes where rasterised (covered) area itself is the limit: a mesh draws the surface only.

## Pitfalls

| Symptom | Cause | Fix |
| --- | --- | --- |
| Layers separate when zooming or tilting | one quad per slice | thickness fill |
| Slices flicker or vanish near the horizon | edge-on quads miss pixel rows | edge-on guard |
| Far objects draw over near ones in perspective | a view ray points upward | keep `pitch > fov / 2`, or use the depth test |
| Lighting cost explodes with scene height | lighting per slice fragment | G-buffer and one light pass |
| Count pass shows 255 everywhere | 8-bit count target | float target, or scale the unit |
| Shell stacks show holes | shell thinner than one layer step on screen | keep at least two pixels of shell |
| Pillar shadows under lamps | overhang in the height map | leave overhanging parts out |
| Walls always in shadow | the shadow march starts under the eaves | start it further out along the normal |
| Striped shadows far from the caster | march steps wider than the caster | cap the step, jitter it per art pixel |
| Shadow holes under turned or scaled stacks | one height-map cell stamped per pixel | stamp the neighbouring cells too |
| Grid lines on tiled ground | tile edges treated as surfaces | let the tile's function answer outside its box (padding) |
| Black screen on Windows (ANGLE, D3D11) | `gl_VertexID` tricks, texture reads in vertex shaders | plain float attributes for the quad corners |
