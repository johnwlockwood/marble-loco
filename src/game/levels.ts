import { SurfaceType } from '../render/SurfaceMaterial';

/** Terse alias -- level data reads better without the full enum name. */
const S = SurfaceType;

export interface BlockDef {
  /** Centre position. */
  p: [number, number, number];
  /** Full size. */
  s: [number, number, number];
  /** Euler angles in degrees, applied in YXZ order. */
  rot?: [number, number, number];
  type?: SurfaceType;
  color?: number;
  /** Ping-pongs between `p` and `to` over `period` seconds. */
  move?: { to: [number, number, number]; period: number; phase?: number };
  /** Impulse applied on contact. Direction is not normalised -- scale it yourself. */
  boost?: { dir: [number, number, number]; power: number };
  /** Conveyor belt surface velocity, world units/s. The block itself stays put. */
  belt?: [number, number, number];
  /**
   * Turns about the block's own centre, around world Y, at `rate` degrees/s.
   * `phase` is a starting angle in degrees.
   */
  spin?: { rate: number; phase?: number };
}

export interface LevelDef {
  id: number;
  name: string;
  hint: string;
  theme: string;
  /** Time limit in seconds. */
  par: number;
  /** Fixed camera yaw in degrees. */
  camYaw: number;
  camDistance?: number;
  camHeight?: number;
  spawn: [number, number, number];
  blocks: BlockDef[];
}

/* ------------------------------------------------------------------ helpers */

const DECK = 1.2;

/** A floor slab. `y` is the *top* surface height. */
function plat(
  x: number, z: number, w: number, d: number, y = 0,
  opts: Partial<BlockDef> = {},
): BlockDef {
  return { p: [x, y - DECK / 2, z], s: [w, DECK, d], ...opts };
}

/** A wall running along X, centred on (x, z). */
function wallX(x: number, z: number, len: number, y = 0, h = 2.2): BlockDef {
  return { p: [x, y + h / 2, z], s: [len, h, 0.9], type: S.Wall };
}

/** A wall running along Z, centred on (x, z). */
function wallZ(x: number, z: number, len: number, y = 0, h = 2.2): BlockDef {
  return { p: [x, y + h / 2, z], s: [0.9, h, len], type: S.Wall };
}

/** Which edge of a deck a rail sits on. 'near' is +z, towards the camera. */
type Side = 'left' | 'right' | 'far' | 'near';

/**
 * Perimeter rails around a rectangular deck.
 *
 * `open` omits sides. A closed ring around a deck the player has to enter or
 * leave is a trap: the rails are 0.9 wide and up to 2.6 tall, and the marble
 * is 1.16 across, so it can neither pass through them nor balance on top.
 * Every deck that is part of the route needs its entry and exit opened.
 */
function rails(
  x: number, z: number, w: number, d: number, y = 0, h = 2.0, open: Side[] = [],
): BlockDef[] {
  const out: BlockDef[] = [];
  // Side rails stop short of the end rails. Running both the full length
  // overlapped them at every corner, and coplanar tops z-fight.
  const farTrim = open.includes('far') ? 0 : 0.9;
  const nearTrim = open.includes('near') ? 0 : 0.9;
  const sideLen = d - farTrim - nearTrim;
  const sideZ = z + (farTrim - nearTrim) / 2;
  if (!open.includes('left')) out.push(wallZ(x - w / 2 + 0.45, sideZ, sideLen, y, h));
  if (!open.includes('right')) out.push(wallZ(x + w / 2 - 0.45, sideZ, sideLen, y, h));
  if (!open.includes('far')) out.push(wallX(x, z - d / 2 + 0.45, w, y, h));
  if (!open.includes('near')) out.push(wallX(x, z + d / 2 - 0.45, w, y, h));
  return out;
}

/**
 * A rail with a doorway in it: two segments flanking a gap of `gapWidth`
 * centred on `gapX`. Used where a wide deck funnels into a narrow exit.
 */
function railWithGap(
  x: number, z: number, w: number, gapX: number, gapWidth: number, y = 0, h = 2.0,
): BlockDef[] {
  const leftEnd = gapX - gapWidth / 2;
  const rightStart = gapX + gapWidth / 2;
  const out: BlockDef[] = [];
  const leftLen = leftEnd - (x - w / 2);
  const rightLen = (x + w / 2) - rightStart;
  if (leftLen > 0.1) out.push(wallX(x - w / 2 + leftLen / 2, z, leftLen, y, h));
  if (rightLen > 0.1) out.push(wallX(rightStart + rightLen / 2, z, rightLen, y, h));
  return out;
}

/** A pad that sits proud of the deck. */
function pad(x: number, z: number, size: number, y: number, type: SurfaceType, extra: Partial<BlockDef> = {}): BlockDef {
  return { p: [x, y + 0.16, z], s: [size, 0.32, size], type, ...extra };
}

const goal = (x: number, z: number, y = 0, size = 4.2) => pad(x, z, size, y, S.Goal);
const checkpoint = (x: number, z: number, y = 0) => pad(x, z, 2.6, y, S.Checkpoint);

/** A boost strip. `dir` is the impulse direction; it is applied as given. */
function boost(
  x: number, z: number, w: number, d: number, y: number,
  dir: [number, number, number], power = 15,
): BlockDef {
  return { p: [x, y + 0.14, z], s: [w, 0.28, d], type: S.Boost, boost: { dir, power } };
}

/**
 * A sloped slab connecting two points.
 *
 * Both ends are given as the *surface* position, so ramps line up with the
 * decks they join without hand-solving the trigonometry.
 */
function ramp(
  from: [number, number, number],
  to: [number, number, number],
  width: number,
  opts: Partial<BlockDef> = {},
): BlockDef {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz);

  const yaw = Math.atan2(dx, dz);
  const pitch = -Math.asin(dy / len);

  // Push the slab down along its own normal so its top face is the surface.
  const nx = Math.sin(yaw) * Math.sin(pitch);
  const ny = Math.cos(pitch);
  const nz = Math.cos(yaw) * Math.sin(pitch);
  const h = DECK / 2;

  return {
    p: [
      (from[0] + to[0]) / 2 - nx * h,
      (from[1] + to[1]) / 2 - ny * h,
      (from[2] + to[2]) / 2 - nz * h,
    ],
    s: [width, DECK, len],
    rot: [(pitch * 180) / Math.PI, (yaw * 180) / Math.PI, 0],
    ...opts,
  };
}

/** A platform that shuttles between two positions. */
function mover(
  x: number, z: number, w: number, d: number, y: number,
  to: [number, number, number], period: number, phase = 0,
  opts: Partial<BlockDef> = {},
): BlockDef {
  return {
    p: [x, y - DECK / 2, z],
    s: [w, DECK, d],
    move: { to: [to[0], to[1] - DECK / 2, to[2]], period, phase },
    ...opts,
  };
}

/**
 * A conveyor belt. `vel` is the belt's surface velocity on the XZ plane; the
 * block never moves, the physics just solves contacts relative to it.
 */
function conveyor(
  x: number, z: number, w: number, d: number, y: number,
  vel: [number, number], opts: Partial<BlockDef> = {},
): BlockDef {
  return plat(x, z, w, d, y, { type: S.Conveyor, belt: [vel[0], 0, vel[1]], ...opts });
}

/**
 * A belt laid on a ramp -- an escalator. The belt velocity follows the slope,
 * so `speed` is along the surface, from `from` towards `to`.
 */
function escalator(
  from: [number, number, number], to: [number, number, number], width: number, speed: number,
): BlockDef {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  const len = Math.hypot(dx, dy, dz);
  return ramp(from, to, width, {
    type: S.Conveyor,
    belt: [(dx / len) * speed, (dy / len) * speed, (dz / len) * speed],
  });
}

/**
 * A turnstile: a plus of two bridges, `len` tip to tip, turning about (x, z).
 * At phase 0 its arms lie along X and Z, which is how the routes are built to
 * meet it -- leave ~0.4 between an arm tip and the deck it meets, so the
 * sweeping tip clears the deck corner.
 */
function turnstile(
  x: number, z: number, len: number, width: number, y: number, rate: number,
): BlockDef[] {
  return [
    plat(x, z, width, len, y, { spin: { rate } }),
    // A hair lower, so the hub's two coincident tops do not z-fight.
    plat(x, z, len, width, y - 0.03, { spin: { rate } }),
  ];
}

/**
 * A rotating bar that sweeps a deck. 1.3 tall -- under the 2.15 jump
 * clearance, so it is always an obstacle you can hop rather than a wall.
 */
function sweeper(x: number, z: number, len: number, y: number, rate: number, phase = 0): BlockDef {
  return { p: [x, y + 0.65, z], s: [len, 1.3, 0.8], type: S.Wall, spin: { rate, phase } };
}

const CHAR_TYPES: Record<string, SurfaceType> = {
  '.': S.Normal, '#': S.Wall, 'I': S.Ice, '~': S.Sticky, 'X': S.Crumble,
  'K': S.Kill, 'B': S.Boost, 'S': S.Normal, 'G': S.Normal, 'C': S.Normal,
  '^': S.Conveyor, 'v': S.Conveyor, '<': S.Conveyor, '>': S.Conveyor,
};

/** Belt direction for each conveyor glyph. Up the map is -z. */
const BELT_DIRS: Record<string, [number, number]> = {
  '^': [0, -1], 'v': [0, 1], '<': [-1, 0], '>': [1, 0],
};

interface GridOptions {
  cell?: number;
  y?: number;
  /** Extra z offset applied to every tile. */
  zOffset?: number;
  wallHeight?: number;
  /** Surface speed of `^ v < >` belt tiles. */
  beltSpeed?: number;
}

/**
 * Builds a level from an ASCII map.
 *
 * `^ v < >` are conveyor belts running that way across the map.
 *
 * The last row is nearest the camera, so maps read the way you play them:
 * bottom of the string is where you start, top is where you are going.
 * Runs of identical tiles are merged along X, which keeps both the vertex
 * count and the number of colliders down.
 */
function fromGrid(rows: string[], opts: GridOptions = {}): {
  blocks: BlockDef[];
  spawn: [number, number, number];
} {
  const cell = opts.cell ?? 3;
  const y = opts.y ?? 0;
  const wallHeight = opts.wallHeight ?? 2.4;
  const beltSpeed = opts.beltSpeed ?? 6;
  const cols = Math.max(...rows.map((r) => r.length));
  const originX = -((cols - 1) * cell) / 2;
  const originZ = -((rows.length - 1) * cell) + (opts.zOffset ?? 6);

  const blocks: BlockDef[] = [];
  let spawn: [number, number, number] = [0, y + 2, 0];

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r].padEnd(cols, ' ');
    const z = originZ + r * cell;

    let runStart = -1;
    let runChar = ' ';

    const flush = (end: number) => {
      if (runStart < 0) return;
      const count = end - runStart;
      const cx = originX + (runStart + count / 2 - 0.5) * cell;
      const width = count * cell;

      if (runChar === '#') {
        blocks.push({ p: [cx, y + wallHeight / 2, z], s: [width, wallHeight, cell], type: S.Wall });
      } else if (BELT_DIRS[runChar]) {
        const [dx, dz] = BELT_DIRS[runChar];
        blocks.push(conveyor(cx, z, width, cell, y, [dx * beltSpeed, dz * beltSpeed]));
      } else {
        const type = CHAR_TYPES[runChar] ?? S.Normal;
        blocks.push(plat(cx, z, width, cell, y, { type }));
      }
      runStart = -1;
    };

    for (let c = 0; c < cols; c++) {
      const ch = row[c];
      if (ch === ' ') { flush(c); continue; }

      // Markers sit on top of an ordinary tile.
      const x = originX + c * cell;
      if (ch === 'S') spawn = [x, y + 2, z];
      // Sized to the cell so the pad does not poke through the maze walls.
      if (ch === 'G') blocks.push(goal(x, z, y, cell * 0.9));
      if (ch === 'C') blocks.push(checkpoint(x, z, y));
      if (ch === 'B') blocks.push(boost(x, z, cell * 0.8, cell * 0.8, y, [0, 0, -1], 16));
      // A bumper post, pushed into one corner of its tile. It used to be a
      // bumper-typed *floor* tile: nothing to hit, and it beeped on every
      // substep you rolled across it. Off-centre leaves a lane either way
      // (1.5 against a 1.16 marble), however the corridor runs.
      if (ch === 'O') {
        const off = 0.5, post = 1.2, h = 2.8;
        blocks.push({ p: [x - off, y + h / 2, z - off], s: [post, h, post], type: S.Bumper });
      }

      // Normalise markers to plain floor for the run-merge.
      const merged = ch === 'S' || ch === 'G' || ch === 'C' || ch === 'B' || ch === 'O' ? '.' : ch;
      if (merged !== runChar) { flush(c); runStart = c; runChar = merged; }
    }
    flush(cols);
  }

  return { blocks, spawn };
}

/* ------------------------------------------------------------------- levels */

const l1Deck: BlockDef[] = [
  plat(0, -12, 15, 50),
  ...rails(0, -12, 15, 50),
  // Slalom: two staggered baffles, wide enough to be a hint rather than a wall.
  wallX(-3.2, -2, 9),
  wallX(3.2, -12, 9),
  checkpoint(0, -18),
  // Rise to the finish.
  ramp([0, 0, -26], [0, 2.4, -31], 9),
  plat(0, -35.5, 11, 9, 2.4),
  ...rails(0, -35.5, 11, 9, 2.4, 1.6, ['near']),
  goal(0, -35.5, 2.4),
];

const l2Deck: BlockDef[] = [
  plat(0, 8, 13, 14),
  ...rails(0, 8, 13, 14, 0, 1.6, ['far']),
  // Gap 1: short, take it at a roll.
  plat(0, -5, 11, 10),
  // Gap 2: wider -- the boost strip is the answer.
  boost(0, -2, 6, 3.5, 0, [0, 0.35, -1], 19),
  plat(-4, -19, 9, 9),
  plat(6, -19, 7, 7),
  checkpoint(-4, -19),
  // Staggered islands across a long drop.
  plat(-6, -30, 6, 6),
  plat(2, -34, 6, 6),
  plat(8, -28, 5.5, 5.5),
  // Narrow catwalk to the finish.
  plat(2, -43.5, 3.4, 13),
  plat(2, -55, 12, 10),
  ...rails(2, -55, 12, 10, 0, 1.6, ['near']),
  goal(2, -56),
];

/**
 * Maze wall height. It has to beat the jump: the ball's underside clears 2.15
 * at the top of a standing jump, and at the old 1.8 you could hop any wall and
 * skip the maze. Wall tops are also wide enough to land on, so a wall you can
 * reach is a road.
 */
const MAZE_WALL = 2.6;

// Generated with a recursive-backtracker plus light braiding, then verified by
// flood fill: 41 tiles from S to G, checkpoint at the halfway point.
const l3 = fromGrid([
  '###########',
  '#........G#',
  '#.###.###.#',
  '#.....#...#',
  '###.#.#.###',
  '#.#.#.#...#',
  '#.#.#.#####',
  '#...#.#...#',
  '#.###.#.#.#',
  '#...#...#C#',
  '###.#####.#',
  '#.......#.#',
  '#########.#',
  '#...#.....#',
  '#.#.#.###.#',
  '#.#...#...#',
  '#.#####.###',
  '#S#.......#',
  '###########',
], { cell: 3.2, wallHeight: MAZE_WALL });

const l4Deck: BlockDef[] = (() => {
  const b: BlockDef[] = [];
  // A descending square spiral. Four legs per revolution, dropping 3 each leg.
  const legs: Array<[number, number, number, number]> = [];
  let x = 0, z = 6, y = 0;
  const size = 9;
  const dirs: Array<[number, number]> = [[0, -1], [-1, 0], [0, 1], [1, 0]];

  b.push(plat(0, 8, 12, 12, 0));
  b.push(...rails(0, 8, 12, 12, 0, 1.6, ['far']));

  for (let i = 0; i < 8; i++) {
    const [dx, dz] = dirs[i % 4];
    const run = 13;
    const nx = x + dx * run;
    const nz = z + dz * run;
    const ny = y - 3.2;
    b.push(ramp([x, y, z], [nx, ny, nz], 6.5));
    // Landing pad with a low lip on the outside of the turn.
    b.push(plat(nx, nz, size, size, ny));
    legs.push([nx, nz, ny, i]);
    x = nx; z = nz; y = ny;
  }

  for (const [lx, lz, ly, i] of legs) {
    if (i === 3) b.push(checkpoint(lx, lz, ly));
    // Hazard rings on the lower turns.
    if (i >= 4) {
      // Pushed out on the goal landing, where 2.6 overlapped the goal pad.
      const off = i === 7 ? 3.3 : 2.6;
      b.push(pad(lx + off, lz + off, 2.4, ly, S.Kill));
      b.push(pad(lx - off, lz - off, 2.4, ly, S.Kill));
    }
  }

  b.push(goal(x, z, y));
  return b;
})();

// Rebuilt as a grid so it is all holes: gaps in the floor to steer round,
// gaps in the walls to slide out of, and almost nothing to brake on. Laid
// out as slabs it also had every piece overlapping the next, which z-fought.
const l5 = fromGrid([
  '  #####  ',
  '  #.G.#  ',
  '  #...#  ',
  '   I I   ',
  ' IIIIIII ',
  ' I  I  I ',
  ' IIIIIII ',
  '  II II  ',
  ' ~~~C~~~ ',
  ' III III ',
  ' II   II ',
  ' I  I  I ',
  '#IIIIIII#',
  '#II I II ',
  '#IIIIIII#',
  ' II I II#',
  '#IIIIIII#',
  '#II...II#',
  '#...S...#',
  '#########',
], { cell: 3.2, wallHeight: 1.6 });

const l6Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  // Shuttle across the first void.
  mover(0, -2, 7, 7, 0, [0, 0, -14], 5.0),
  plat(0, -22, 12, 8),
  checkpoint(0, -22),
  // Two platforms sliding sideways in opposite phase.
  mover(-8, -32, 6, 6, 0, [8, 0, -32], 4.2, 0),
  mover(8, -42, 6, 6, 0, [-8, 0, -42], 4.2, 0.5),
  // A lift that drops you to a lower shelf.
  mover(0, -52, 7, 7, 0, [0, -6, -52], 6.0, 0.25),
  plat(0, -64, 14, 10, -6),
  ...rails(0, -64, 14, 10, -6, 1.6, ['near']),
  goal(0, -65, -6),
];

const l7Deck: BlockDef[] = (() => {
  const b: BlockDef[] = [
    plat(0, 8, 12, 12),
    ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  ];
  // A path of crumbling tiles: stop moving and you go through the floor.
  const path: Array<[number, number]> = [
    [0, -2], [0, -6], [-3, -10], [-3, -14], [0, -18], [3, -26],
    [0, -30], [-3, -34], [-3, -38], [0, -42], [3, -46], [0, -50], [0, -54],
  ];
  // 4 deep on a 4 pitch: neighbours meet edge to edge. At 4.4 they overlapped
  // and the coplanar tops z-fought.
  for (const [x, z] of path) {
    b.push(plat(x, z, 4.4, 4, 0, { type: S.Crumble }));
  }
  // The one solid tile on the path.
  b.push(plat(3, -22, 4.4, 4, 0, { type: S.Normal }));
  b.push(checkpoint(3, -22));
  b.push(plat(0, -62, 13, 11));
  b.push(...rails(0, -62, 13, 11, 0, 1.6, ['near']));
  b.push(goal(0, -63));
  return b;
})();

const l8Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  // Pinball table: bumpers scattered on a wide bowl with walls.
  plat(0, -20, 30, 44),
  // Table walls with a doorway at each end -- in from the start deck, out to
  // the exit chute. A closed ring here walled the goal off entirely.
  ...rails(0, -20, 30, 44, 0, 2.6, ['near', 'far']),
  // 28.2, not 30: the side rails already fill the corners.
  ...railWithGap(0, 1.55, 28.2, 0, 12, 0, 2.6),
  // The far end is sealed except for a notch the kicker ramp fires through.
  ...railWithGap(0, -41.55, 28.2, 0, 7, 0, 2.6),
  { p: [-7, 1.4, -8], s: [3, 2.8, 3], type: S.Bumper },
  { p: [6, 1.4, -14], s: [3, 2.8, 3], type: S.Bumper },
  { p: [-4, 1.4, -22], s: [3, 2.8, 3], type: S.Bumper },
  { p: [9, 1.4, -26], s: [3, 2.8, 3], type: S.Bumper },
  { p: [-10, 1.4, -30], s: [3, 2.8, 3], type: S.Bumper },
  // Moved off the launch corridor -- it used to sit squarely on the run-up.
  { p: [7, 1.4, -34], s: [3, 2.8, 3], type: S.Bumper },
  boost(-12, -18, 4, 8, 0, [1, 0, -0.6], 17),
  boost(12, -30, 4, 8, 0, [-1, 0, -0.6], 17),
  pad(0, -12, 5, 0, S.Kill),
  pad(-12, -38, 5, 0, S.Kill),
  checkpoint(12, -12),

  // --- the exit: a kicker over a chasm ------------------------------------
  // Feeder strip pointing straight down the launch corridor.
  boost(0, -27, 7, 5, 0, [0, 0, -1], 24),
  // Deliberately shallow. Hitting an inclined face costs a normal impulse and
  // Coulomb friction takes a cut of it, so a steep ramp simply eats the
  // momentum you arrive with -- a 26 degree version of this ate 43% of it and
  // nothing could climb the thing. At 18 degrees enough survives to matter.
  //
  // Rolling off the lip clears the chasm only at real speed. Anyone short of
  // that has the other option: a jump timed at the lip, which adds a fixed
  // 12.5 upward regardless of how slow the approach was.
  ramp([0, 0, -34.5], [0, 1.0, -41], 6),
  // The chasm is 11 wide, which sits deliberately between the two ranges:
  // rolling off the lip at a good 24 carries about 8.8 and drops you in, while
  // a jump timed at the lip carries about 19. Pure speed still works, but it
  // takes roughly 28 off the boost and the bumpers -- the expert line.
  plat(0, -59, 14, 14),
  ...rails(0, -59, 14, 14, 0, 1.6, ['near']),
  goal(0, -60),
];

// The long one: an 89-tile solution with ice, crumble, sticky, a bumper and a
// boost strip seeded onto the solution path so none of them can be dodged.
const l9 = fromGrid([
  '#############',
  '#..........G#',
  '#.#.#########',
  '#.......#.X.#',
  '###.###.#.#.#',
  '#.......#.#.#',
  '#.#####.#.#.#',
  '#B..#...#.#.#',
  '#.#.#####.#.#',
  '#......O..#I#',
  '#.#########.#',
  '#...#I....#.#',
  '#.###.###I#.#',
  '#.#...#.#.#C#',
  '###.###.#.#.#',
  '#...#.....#.#',
  '#.###.#####.#',
  '#...#X#...~.#',
  '###.#.#.#.#.#',
  '#S..#.......#',
  '#############',
], { cell: 3.2, wallHeight: MAZE_WALL });

const l10Deck: BlockDef[] = (() => {
  const b: BlockDef[] = [
    plat(0, 8, 12, 12, 40),
    ...rails(0, 8, 12, 12, 40, 1.6, ['far']),
  ];
  // A long descent: alternating ramps, hazards and a couple of movers.
  let y = 40;
  let z = 2;
  let x = 0;
  for (let i = 0; i < 7; i++) {
    const nx = i % 2 === 0 ? x - 8 : x + 8;
    const nz = z - 15;
    const ny = y - 5.5;
    b.push(ramp([x, y, z], [nx, ny, nz], 6.0, i % 3 === 1 ? { type: S.Ice } : {}));
    b.push(plat(nx, nz - 4, 10, 9, ny));
    if (i === 2) b.push(checkpoint(nx, nz - 4, ny));
    if (i === 4) b.push(checkpoint(nx, nz - 4, ny));
    if (i >= 2) {
      b.push(pad(nx + 3, nz - 6, 2.6, ny, S.Kill));
      b.push({ p: [nx - 3, ny + 1.4, nz - 2], s: [2.6, 2.8, 2.6], type: S.Bumper });
    }
    if (i === 3 || i === 5) {
      b.push(mover(nx, nz - 11, 6, 6, ny, [nx + 9, ny, nz - 11], 4.4, i * 0.3));
    }
    x = nx; y = ny; z = nz - 8.5;
  }
  b.push(plat(x, z - 8, 16, 14, y));
  b.push(...rails(x, z - 8, 16, 14, y, 2.0, ['near']));
  b.push(goal(x, z - 9, y));
  return b;
})();

/* -------------------------------------------------------- 11 and beyond */

// Belts, introduced gently: one carries you, three shove you sideways over the
// void, and the last runs straight at you with nothing either side.
const l11Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  conveyor(0, -9, 6, 22, 0, [0, -7]),
  wallZ(-3.45, -9, 22, 0, 1.6),
  wallZ(3.45, -9, 22, 0, 1.6),
  plat(0, -23.5, 12, 7),
  ...rails(0, -23.5, 12, 7, 0, 1.6, ['near', 'far']),
  // Cross-lanes, alternating. Open at both ends: dawdle and you are tipped off.
  conveyor(0, -30, 16, 6, 0, [6, 0]),
  conveyor(0, -36, 16, 6, 0, [-6, 0]),
  conveyor(0, -42, 16, 6, 0, [6, 0]),
  plat(0, -49, 10, 8),
  checkpoint(0, -49),
  // The up-current: narrow, unrailed, running back towards the camera.
  conveyor(0, -63, 4.5, 20, 0, [0, 5]),
  plat(0, -78, 12, 10),
  ...rails(0, -78, 12, 10, 0, 1.6, ['near']),
  goal(0, -79),
];

// Turnstiles over the void. Every arm lines up with a bridge four times a
// revolution; ride to the hub and step off when the next one comes round.
const l12Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  plat(0, -1.3, 4, 6.6),
  ...turnstile(0, -12, 14, 3.2, 0, 24),
  plat(0, -23, 4, 7.2),
  // Second wheel turns the route left.
  ...turnstile(0, -34, 14, 3.2, 0, -28),
  plat(-10.7, -34, 6.6, 4),
  plat(-18, -34, 8, 8),
  checkpoint(-18, -34),
  plat(-18, -41.3, 4, 6.6),
  // The big one. Longer arms, so the tips move faster for the same rate.
  ...turnstile(-18, -54, 18, 3.4, 0, 20),
  plat(-18, -69, 12, 11.2),
  ...rails(-18, -69, 12, 11.2, 0, 1.6, ['near']),
  goal(-18, -70),
];

// Sweepers. The first run is railed, so a hit only costs you time. The second
// is ice with no rails, and a hit there costs you the run.
const l13Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  plat(0, -22, 14, 48),
  ...rails(0, -22, 14, 48, 0, 2.0, ['near', 'far']),
  // Radius 6 clears the rails' inner faces at 6.1.
  sweeper(0, -6, 12, 0, 60),
  sweeper(0, -18, 12, 0, -75, 45),
  checkpoint(0, -28),
  sweeper(0, -37, 12, 0, 90, 90),
  plat(0, -61, 14, 30, 0, { type: S.Ice }),
  sweeper(0, -53, 13, 0, 50),
  sweeper(0, -68, 13, 0, -50, 90),
  plat(0, -82, 12, 12),
  ...rails(0, -82, 12, 12, 0, 1.6, ['near']),
  goal(0, -83),
];

// A serpentine factory floor. Belts with you, belts against you, and the
// sticky patches are where you have to turn. The ice row's exit is two tiles
// short of its end, and the end is a hazard: overshoot and you are done.
const l14 = fromGrid([
  '#############',
  '#G..<<<<<<..#',
  '###########^#',
  '#...X.X.>>>.#',
  '#.###########',
  '#~~..<<<<C..#',
  '#########.###',
  '#.IIIIIIIIIK#',
  '#.###########',
  '#..O...>>>..#',
  '###########.#',
  '#..<<<<<....#',
  '#.###########',
  '#...X.>>>>..#',
  '###########.#',
  '#S..>>>>>...#',
  '#############',
], { cell: 3.2, wallHeight: MAZE_WALL, beltSpeed: 6 });

// Remix: a launch onto ice, cracked tiles at speed, a turnstile, then a pair
// of crossing shuttles.
const l15Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  boost(0, 3.5, 6, 3, 0, [0, 0.25, -1], 20),
  plat(0, -14, 6, 20, 0, { type: S.Ice }),
  pad(1.8, -10, 2.2, 0, S.Kill),
  pad(-1.8, -18, 2.2, 0, S.Kill),
  plat(0, -26.2, 4.4, 4.4, 0, { type: S.Crumble }),
  plat(0, -30.6, 4.4, 4.4, 0, { type: S.Crumble }),
  plat(3, -35, 4.4, 4.4, 0, { type: S.Crumble }),
  plat(3, -39.4, 4.4, 4.4, 0, { type: S.Crumble }),
  plat(0, -43.8, 4.4, 4.4, 0, { type: S.Crumble }),
  plat(0, -50.3, 8, 8.6),
  checkpoint(0, -50.3),
  ...turnstile(0, -62, 14, 3.2, 0, 30),
  plat(0, -72.7, 4, 6.6),
  mover(-8, -79.5, 6, 6, 0, [8, 0, -79.5], 4.0, 0),
  mover(8, -85.5, 6, 6, 0, [-8, 0, -85.5], 4.0, 0.5),
  plat(0, -94, 12, 10),
  ...rails(0, -94, 12, 10, 0, 1.6, ['near']),
  goal(0, -95),
];

// The finale. Everything, in order, with checkpoints only where it is fair.
const l16Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6, ['far']),
  // An escalator up to the sweeper gallery.
  escalator([0, 0, 2], [0, 4, -12], 5, 8),
  plat(0, -16, 10, 8, 4),
  ...rails(0, -16, 10, 8, 4, 1.6, ['near', 'far']),
  checkpoint(0, -16, 4),
  plat(0, -30, 12, 20, 4),
  ...rails(0, -30, 12, 20, 4, 1.6, ['near', 'far']),
  sweeper(0, -28, 10.6, 4, 80),
  // Launch off the gallery, down onto cracked tiles.
  boost(0, -38, 6, 3, 4, [0, 0.3, -1], 21),
  plat(0, -50.2, 4.4, 4.4, 2, { type: S.Crumble }),
  plat(2.5, -54.6, 4.4, 4.4, 2, { type: S.Crumble }),
  plat(0, -59, 4.4, 4.4, 2, { type: S.Crumble }),
  plat(0, -65.3, 10, 8.2, 2),
  checkpoint(0, -65.3, 2),
  // Faster cross-lanes than Assembly Line, and narrower.
  conveyor(0, -72.4, 12, 5, 2, [8, 0]),
  conveyor(0, -77.4, 12, 5, 2, [-8, 0]),
  conveyor(0, -82.4, 12, 5, 2, [8, 0]),
  ...turnstile(0, -93.3, 16, 3.2, 2, 28),
  // Ice run down to the goal deck.
  ramp([0, 2, -101.7], [0, -4, -113.7], 6, { type: S.Ice }),
  plat(0, -118.7, 14, 10, -4),
  ...rails(0, -118.7, 14, 10, -4, 2.0, ['near']),
  { p: [-3.5, -2.6, -116.5], s: [2.4, 2.8, 2.4], type: S.Bumper },
  { p: [3.5, -2.6, -116.5], s: [2.4, 2.8, 2.4], type: S.Bumper },
  goal(0, -120.5, -4),
];

export const LEVELS: LevelDef[] = [
  {
    id: 1, name: 'First Roll',
    hint: 'Tilt to roll. Reach the gold pad.',
    theme: 'dawn', par: 60, camYaw: 22, spawn: [0, 2.5, 10],
    blocks: l1Deck,
  },
  {
    id: 2, name: 'Mind the Gap',
    hint: 'Tap JUMP to clear the drops. Green strips launch you.',
    theme: 'dawn', par: 75, camYaw: 22, spawn: [0, 2.5, 12],
    blocks: l2Deck,
  },
  {
    id: 3, name: 'The Labyrinth',
    hint: 'One way through. The blue ring is a checkpoint.',
    theme: 'void', par: 100, camYaw: 18, camDistance: 16.5, camHeight: 13.5,
    spawn: l3.spawn, blocks: l3.blocks,
  },
  {
    id: 4, name: 'Descent',
    hint: 'Down and around. Red tiles hurt.',
    theme: 'void', par: 95, camYaw: 30, spawn: [0, 2.5, 10],
    blocks: l4Deck,
  },
  {
    id: 5, name: 'Black Ice',
    hint: 'No grip, and holes everywhere. Brake on the brown.',
    theme: 'ice', par: 100, camYaw: 22,
    spawn: l5.spawn, blocks: l5.blocks,
  },
  {
    id: 6, name: 'Clockwork',
    hint: 'Ride the platforms. They carry you.',
    theme: 'ice', par: 110, camYaw: 22, spawn: [0, 2.5, 11],
    blocks: l6Deck,
  },
  {
    id: 7, name: 'Collapse',
    hint: 'Keep moving. Nothing here holds.',
    theme: 'ember', par: 90, camYaw: 22, spawn: [0, 2.5, 11],
    blocks: l7Deck,
  },
  {
    id: 8, name: 'Pinball',
    hint: 'Bumpers throw you. The exit is a jump — tap JUMP at the lip.',
    theme: 'neon', par: 135, camYaw: 24, camDistance: 16.5, camHeight: 13.5,
    spawn: [0, 2.5, 11], blocks: l8Deck,
  },
  {
    id: 9, name: 'The Gauntlet',
    hint: 'Everything at once.',
    theme: 'neon', par: 150, camYaw: 18, camDistance: 16.5, camHeight: 13.5,
    spawn: l9.spawn, blocks: l9.blocks,
  },
  {
    id: 10, name: 'Freefall',
    hint: 'All the way down. Do not stop.',
    theme: 'ember', par: 150, camYaw: 28, spawn: [0, 42.5, 10],
    blocks: l10Deck,
  },
  {
    id: 11, name: 'Assembly Line',
    hint: 'Belts carry you. The last one is against you.',
    theme: 'foundry', par: 75, camYaw: 22, spawn: [0, 2.5, 11],
    blocks: l11Deck,
  },
  {
    id: 12, name: 'Turnstile',
    hint: 'Ride to the hub. Step off when an arm lines up.',
    theme: 'aurora', par: 90, camYaw: 22, camDistance: 16.5, camHeight: 13.5,
    spawn: [0, 2.5, 11], blocks: l12Deck,
  },
  {
    id: 13, name: 'Sweepers',
    hint: 'Time the arms, or jump them.',
    theme: 'void', par: 80, camYaw: 22, spawn: [0, 2.5, 11],
    blocks: l13Deck,
  },
  {
    id: 14, name: 'Factory Floor',
    hint: 'Some belts help. Most do not.',
    theme: 'foundry', par: 140, camYaw: 18, camDistance: 16.5, camHeight: 13.5,
    spawn: l14.spawn, blocks: l14.blocks,
  },
  {
    id: 15, name: 'Slipstream',
    hint: 'Ride the launch. Never stop on the cracks.',
    theme: 'neon', par: 105, camYaw: 22, spawn: [0, 2.5, 11],
    blocks: l15Deck,
  },
  {
    id: 16, name: 'Overdrive',
    hint: 'Everything you have learned. Go.',
    theme: 'solar', par: 120, camYaw: 24, camDistance: 16.5, camHeight: 13.5,
    spawn: [0, 2.5, 11], blocks: l16Deck,
  },
];
