# Marble Loco

A Marble Madness–style arcade game for the iPhone, built on Three.js with a
hand-written shader pipeline. Sixteen courses, tilt or thumbstick controls, no
asset files — every surface, sound and particle is generated at runtime.

There is no `MeshStandardMaterial` anywhere, no cubemap render target, no
`EffectComposer`, no physics library, and not a single image or audio file.
The marble mirrors the live sky by evaluating the same procedural `skyColor()`
the skybox uses, with the reflection vector instead of the view vector.

**▶ [Play it](https://johnwlockwood.github.io/marble-loco/)** — best on a phone.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Deploy](https://github.com/johnwlockwood/marble-loco/actions/workflows/deploy.yml/badge.svg)](https://github.com/johnwlockwood/marble-loco/actions/workflows/deploy.yml)

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

Your choice is remembered. Tilt cannot be switched back on at page load — the
permission API requires a user gesture — so the game restores it on the tap
that starts your next run, and falls back to the stick (clearing the
preference) if that fails.

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
| 11 | Assembly Line | conveyor belts — with you, across you, against you |
| 12 | Turnstile | rotating bridges over the void |
| 13 | Sweepers | spinning arms to time or jump, then on ice |
| 14 | Factory Floor | a belt-driven serpentine maze |
| 15 | Slipstream | launch, ice, crumble, turnstile, shuttles |
| 16 | Overdrive | an escalator and everything else, in one run |

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

- **Two friction coefficients, and the difference is the whole feel.** A sphere
  rolling without slipping has a contact point with no relative velocity, so
  kinetic friction does no work on it — what slows a real marble is *rolling
  resistance*, one to two orders of magnitude smaller. Spin here is derived
  from linear velocity rather than integrated as angular momentum, so the
  marble is rolling by construction. Contacts blend between `rolling` and
  Coulomb `friction` by impact speed: resting contact coasts, real collisions
  scrub. Applying Coulomb friction to everything made the marble decelerate at
  μg ≈ 21 u/s² — a sliding block — and no ramp in the game was climbable.
  It now loses ~4 u/s² at speed, and momentum is something you manage.
- Contacts are solved in the *surface's* frame, so moving platforms carry the
  marble exactly (measured: ball velocity matches platform velocity to 0.01).
- Restitution is suppressed below 1.6 u/s, which is what stops a resting ball
  buzzing on a flat floor. The rolling/Coulomb blend starts above 0.6 u/s so
  the gravity a resting ball accumulates between substeps does not read as an
  impact — that alone was trebling the rolling resistance.
- Steering acceleration is projected onto the ground plane so you drive *up* a
  ramp instead of into it; air control is cut to 32%.
- Coyote time (0.12s) on jumps.
- Colliders carry an angular velocity as well as a linear one, and contacts
  use the surface velocity *at the contact point* (v + ω × r). That one change
  is what lets turnstiles carry you and sweepers bat you away. Conveyor belts
  need nothing new at all: a belt is a static box with a non-zero `velocity`,
  and the surface-frame solve does the rest. Belts get a much higher rolling
  coefficient than plain floor, or they take seconds to pick the ball up.
- Rolling spin is integrated from ω = (n × v)/r for the visual only. Verified
  by deriving ω back out of the orientation each frame and checking the contact
  point is stationary — which is what "rolling without slipping" means.

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

### Checking a level is beatable

`tools/reachability-audit.js` answers the only question that matters: can the
marble get from spawn to goal? Run a dev build, open the console, paste the
file, then `await audit.all()`. `audit.map(i)` prints an ASCII map of what is
reachable, which is how you find where a route breaks.

Run it after touching level geometry. It builds a height field by raycasting
onto every collider, sweeps moving platforms along their paths, discards
surfaces narrower than the marble, and flood-fills with ballistic gap jumps
that have to clear whatever they fly over.

Two traps it exists to catch, both of which shipped:

- `rails()` builds a **closed** ring. Around a deck on the route that is a
  cage — rails are 0.9 wide and the marble is 1.16, so it can neither pass
  through nor balance on top. Pass `open` sides, or use `railWithGap()`.
- Jump clearance is only **2.15** under the ball. Anything taller than that is
  a wall, not an obstacle, and bumpers do not help — they throw you sideways,
  reaching barely 1.0 of lift even at full speed.

Levels are data. `game/levels.ts` has helpers (`plat`, `ramp`, `mover`,
`boost`, `rails`, `railWithGap`, `conveyor`, `escalator`, `turnstile`,
`sweeper`) plus `fromGrid()`, which compiles an ASCII map — `#` wall, `I` ice,
`X` crumble, `O` bumper, `~` sticky, `^ v < >` belts, `S`/`G`/`C`
spawn/goal/checkpoint — run-merging identical tiles along X to keep both
vertices and colliders down.

Spinners turn on the global clock, so the audit sees them at whatever angle
they happen to be at. Build routes to meet a turnstile's arms at phase 0 (arms
along X and Z) with ~0.4 of clearance at each tip, so the sweeping tip clears
the deck corner.
The two mazes were machine-generated (recursive backtracker + braiding) and
flood-fill verified solvable.

## Deployment

Every push to `main` typechecks, builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. Live at
**https://johnwlockwood.github.io/marble-loco/**.

Two things make that work, and both are easy to break:

- `base: './'` in the Vite config. A Pages *project* site is served from
  `/marble-loco/`, and an absolute base would 404 every asset there.
- HTTPS, which Pages provides automatically. This is not cosmetic — iOS
  refuses the motion sensors outside a secure context, so tilt controls do not
  exist without it.

Production sourcemaps are off; the map is ~2.9MB against a 604KB bundle. Build
with `SOURCEMAP=1 npm run build` when you need a readable stack trace from a
real device.

To put it on your own domain: add the domain in the repo's Pages settings, then
point DNS at GitHub — an `ALIAS`/`ANAME` at the apex, or a `CNAME` to
`johnwlockwood.github.io` for a subdomain. Pages provisions the certificate.
Nothing in the build needs changing; `base: './'` works at the root too.

## License

[MIT](LICENSE) © John Lockwood.

Three.js is BSD-3-Clause and is the only runtime dependency.
