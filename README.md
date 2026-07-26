# Marble Loco

A Marble Madness–style arcade game for the iPhone, built on Three.js with a
hand-written shader pipeline. Ten courses, tilt or thumbstick controls, no
asset files — every surface, sound and particle is generated at runtime.

```bash
npm install
npm run dev          # stick controls; plain http
npm run dev:https    # required if you want TILT on a real phone
npm run build
```

The dev server binds to `0.0.0.0`, so the "Network" URL it prints is reachable
from a phone on the same Wi-Fi. On iOS, add it to your home screen to get a
fullscreen, chrome-free window.

## Controls

| | Tilt | Stick |
|---|---|---|
| Steer | tilt the phone | drag the left pad |
| Jump | JUMP button | JUMP button |

Pick one under **Steering** on the title screen. Keyboard (WASD/arrows + space)
works everywhere for desktop testing.

### Tilt requires HTTPS

iOS will not release the motion sensors outside a **secure context**, and a LAN
`http://192.168.x.x` origin is not one. Over plain http the sensors are not
merely denied — Chrome and Safari hide `DeviceOrientationEvent` altogether, so
there is nothing to prompt for.

```bash
npm run dev:https
```

This serves over TLS with a self-signed certificate, so the phone shows a
warning the first time: **Show Details → visit this website** on Safari,
**Advanced → Proceed** on Chrome. After that, tap **Tilt** on the title screen
and accept the iOS motion prompt.

If your phone refuses to accept the self-signed certificate, use a tunnel with
a real one instead — any of these gives a trusted `https://` URL:

```bash
npx cloudflared tunnel --url http://localhost:5173
npx localtunnel --port 5173
```

Whatever attitude you are holding when tilt is enabled becomes "level", and
**Pause → Re-centre tilt** resets it. Axes are rotated by the current screen
orientation, so landscape does not swap or invert the controls, and rotating
the phone re-centres automatically.

If enabling tilt fails, the title screen says exactly why — insecure origin,
permission denied, no sensor, or permission granted but no readings arriving.
That last case matters: permission is not the same as data, so the game waits
1.5s for a real reading and falls back to the stick if none comes, rather than
leaving you holding a phone that steers nothing.

Steering is camera-relative: tilting right always moves the marble right *on
screen*, whatever yaw the current course uses.

## The courses

| # | Name | Introduces |
|---|---|---|
| 1 | First Roll | rolling, momentum |
| 2 | Mind the Gap | gaps, jumping, boost strips |
| 3 | The Labyrinth | a maze with one way through |
| 4 | Descent | a spiral of ramps, hazard tiles |
| 5 | Black Ice | near-zero friction, sticky brake zones |
| 6 | Clockwork | moving platforms that carry you |
| 7 | Collapse | tiles that fall as you touch them |
| 8 | Pinball | bumpers, crossing boost strips |
| 9 | The Gauntlet | an 89-tile maze with everything in it |
| 10 | Freefall | a 40-unit descent, movers and hazards |

Each has a time limit rather than lives; falling costs you seconds, not a run.
Checkpoints move your respawn. Progress and best times persist in
`localStorage`.

## Rendering

There is no `MeshStandardMaterial` anywhere. Every draw is a `ShaderMaterial`
written for this game.

- **Sky** (`render/Environment.ts`) — a procedural gradient with a sun disc,
  atmospheric scattering, a twinkling star field and an fbm nebula, evaluated
  per-pixel from a reconstructed view ray on a single clip-space quad.
- **Marble** (`render/MarbleMaterial.ts`) — domain-warped fbm veining evaluated
  in *object* space, so the pattern turns with the ball and you can read its
  spin. Reflections call the same `skyColor()` the sky uses, with the reflection
  vector instead of the view vector — the ball genuinely mirrors the live sky
  (sun, stars, nebula) with **no cubemap render target anywhere**. Plus
  fresnel-weighted reflectivity, thin-film iridescence, metallic flake
  sparkle, and friction heat at speed.
- **Surfaces** (`render/SurfaceMaterial.ts`) — one material for the entire
  level. Per-block variation rides on vertex attributes (`aType`, `aState`,
  `aFaceUv`, `aFaceSize`), so the whole static course renders in **one draw
  call** while each block still gets its own look: ice crackle, scrolling boost
  chevrons, crumble fractures that glow as the tile dies, goal rings, hazard
  hatching. `aFaceSize` lets the shader inset a panel outline by a constant
  *world* distance, so a huge platform and a small tile get identical trim.
- **Shadows** (`render/ShadowPass.ts`) — our own orthographic depth pass,
  RGBA8-packed, texel-snapped to stop edge shimmer, with 3×3 PCF and
  normal-offset bias. Three's shadow system is deliberately unused: it would
  couple every material to three's internal lighting chunks.
- **Post** (`render/Post.ts`) — a hand-rolled chain rather than
  `EffectComposer`, for exact control over how many half-res passes run:
  threshold → 5-step downsample pyramid (13-tap) → 5-step tent upsample →
  composite (radial speed blur, lateral chromatic aberration, bloom, ACES,
  sRGB, vignette, grain) → optional FXAA.
- **Sparks** (`render/Sparks.ts`) — particles simulated entirely in the vertex
  shader from spawn state; emitting costs one buffer write and the CPU never
  touches a particle again.

### Performance

Aimed at a 60fps budget on A-series hardware:

- Device pixel ratio is capped at 2, and an adaptive scaler walks the render
  scale between 0.55 and 1.0 based on a smoothed frame time. Its thresholds
  straddle the vsync interval (22ms down / 18ms up) — a step-up threshold
  *below* 16.7ms would strand the scaler at whatever value it first dropped to
  and never recover on a 60Hz panel.
- FXAA only runs when the effective pixel ratio drops under 1.6 — which is both
  when aliasing actually shows and when the pass is cheapest.
- Surfaces use a cheap `skyAmbient()` gradient; only the marble (a small
  fraction of the screen) pays for the full `skyColor()` with its noise.
- The static level is merged into a single buffer at load; only movers,
  crumbling tiles and animated pads get their own meshes.

## Physics

Custom, in `physics/Physics.ts` — a sphere against oriented boxes, stepped at a
fixed 120Hz with an accumulator.

- Impulse resolution with Coulomb friction and per-surface restitution.
- Contacts are solved in the *surface's* frame, so moving platforms carry the
  marble exactly (measured: ball velocity matches platform velocity to 0.01).
- Restitution is suppressed below 1.6 u/s, which is what stops a resting ball
  buzzing on a flat floor.
- Steering acceleration is projected onto the ground plane so you drive *up* a
  ramp instead of into it; air control is cut to 32%.
- Coyote time (0.12s) on jumps.
- Rolling spin is integrated from ω = (n × v)/r for the visual only.

Ramps are authored as two surface endpoints and the tilt is solved for
(`ramp()` in `game/levels.ts`); a 2.4-over-5 ramp measures back as a 25.6°
contact normal in game.

## Camera

Fixed-yaw follow camera for the isometric feel, with occlusion avoidance: since
every course is walled, the camera searches each frame for the least extra
pitch that gives a clear line to the marble, then eases toward it — fast to
uncover, slow to settle. Without it the ball vanishes behind rails constantly.

## Layout

```
src/
  core/       Engine (loop, sizing, adaptive resolution), Input, Audio
  physics/    sphere-vs-OBB solver
  render/     glsl chunks, Environment, ShadowPass, materials, Post, Sparks
  game/       Game (state machine), Level (block compiler), levels, Progress
  ui/         screens, HUD, touch pads
```

Levels are data. `game/levels.ts` has helpers (`plat`, `ramp`, `mover`,
`boost`, `rails`) plus `fromGrid()`, which compiles an ASCII map — `#` wall,
`I` ice, `X` crumble, `O` bumper, `~` sticky, `S`/`G`/`C` spawn/goal/checkpoint
— run-merging identical tiles along X to keep both vertices and colliders down.
The two mazes were machine-generated (recursive backtracker + braiding) and
flood-fill verified solvable.
