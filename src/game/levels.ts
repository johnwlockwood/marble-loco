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

/** Perimeter rails around a rectangular deck. */
function rails(x: number, z: number, w: number, d: number, y = 0, h = 2.0): BlockDef[] {
  return [
    wallZ(x - w / 2 + 0.45, z, d, y, h),
    wallZ(x + w / 2 - 0.45, z, d, y, h),
    wallX(x, z - d / 2 + 0.45, w, y, h),
    wallX(x, z + d / 2 - 0.45, w, y, h),
  ];
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

const CHAR_TYPES: Record<string, SurfaceType> = {
  '.': S.Normal, '#': S.Wall, 'I': S.Ice, '~': S.Sticky, 'X': S.Crumble,
  'K': S.Kill, 'O': S.Bumper, 'B': S.Boost, 'S': S.Normal, 'G': S.Normal, 'C': S.Normal,
};

interface GridOptions {
  cell?: number;
  y?: number;
  /** Extra z offset applied to every tile. */
  zOffset?: number;
  wallHeight?: number;
}

/**
 * Builds a level from an ASCII map.
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

      // Normalise markers to plain floor for the run-merge.
      const merged = ch === 'S' || ch === 'G' || ch === 'C' || ch === 'B' ? '.' : ch;
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
  ...rails(0, -35.5, 11, 9, 2.4, 1.6),
  goal(0, -35.5, 2.4),
];

const l2Deck: BlockDef[] = [
  plat(0, 8, 13, 14),
  ...rails(0, 8, 13, 14, 0, 1.6),
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
  plat(2, -44, 3.4, 14),
  plat(2, -55, 12, 10),
  ...rails(2, -55, 12, 10, 0, 1.6),
  goal(2, -56),
];

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
], { cell: 3.2, wallHeight: 1.8 });

const l4Deck: BlockDef[] = (() => {
  const b: BlockDef[] = [];
  // A descending square spiral. Four legs per revolution, dropping 3 each leg.
  const legs: Array<[number, number, number, number]> = [];
  let x = 0, z = 6, y = 0;
  const size = 9;
  const dirs: Array<[number, number]> = [[0, -1], [-1, 0], [0, 1], [1, 0]];

  b.push(plat(0, 8, 12, 12, 0));
  b.push(...rails(0, 8, 12, 12, 0, 1.6));

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
      b.push(pad(lx + 2.6, lz + 2.6, 2.4, ly, S.Kill));
      b.push(pad(lx - 2.6, lz - 2.6, 2.4, ly, S.Kill));
    }
  }

  b.push(goal(x, z, y));
  return b;
})();

const l5Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6),
  // Long ice straight with a kink -- carry too much speed and you overshoot.
  plat(0, -8, 9, 22, 0, { type: S.Ice }),
  wallZ(-4.9, -8, 22),
  wallZ(4.9, -8, 22),
  plat(0, -22, 16, 8, 0, { type: S.Ice }),
  wallX(0, -26.5, 16),
  checkpoint(-6, -22),
  // Sticky landing to bleed the speed off.
  plat(-9, -30, 7, 12, 0, { type: S.Sticky }),
  plat(-9, -42, 7, 14, 0, { type: S.Ice }),
  wallZ(-12.9, -42, 14),
  // Narrow ice bridge over nothing.
  plat(-9, -54, 3.6, 12, 0, { type: S.Ice }),
  plat(-9, -64, 12, 10),
  ...rails(-9, -64, 12, 10, 0, 1.6),
  goal(-9, -65),
];

const l6Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6),
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
  ...rails(0, -64, 14, 10, -6, 1.6),
  goal(0, -65, -6),
];

const l7Deck: BlockDef[] = (() => {
  const b: BlockDef[] = [
    plat(0, 8, 12, 12),
    ...rails(0, 8, 12, 12, 0, 1.6),
  ];
  // A path of crumbling tiles: stop moving and you go through the floor.
  const path: Array<[number, number]> = [
    [0, -2], [0, -6], [-3, -10], [-3, -14], [0, -18], [3, -22], [3, -26],
    [0, -30], [-3, -34], [-3, -38], [0, -42], [3, -46], [0, -50], [0, -54],
  ];
  for (const [x, z] of path) {
    b.push(plat(x, z, 4.4, 4.4, 0, { type: S.Crumble }));
  }
  b.push(plat(3, -22, 4.4, 4.4, 0, { type: S.Normal }));
  b.push(checkpoint(3, -22));
  b.push(plat(0, -62, 13, 11));
  b.push(...rails(0, -62, 13, 11, 0, 1.6));
  b.push(goal(0, -63));
  return b;
})();

const l8Deck: BlockDef[] = [
  plat(0, 8, 12, 12),
  ...rails(0, 8, 12, 12, 0, 1.6),
  // Pinball table: bumpers scattered on a wide bowl with walls.
  plat(0, -20, 30, 44),
  ...rails(0, -20, 30, 44, 0, 2.6),
  { p: [-7, 1.4, -8], s: [3, 2.8, 3], type: S.Bumper },
  { p: [6, 1.4, -14], s: [3, 2.8, 3], type: S.Bumper },
  { p: [-4, 1.4, -22], s: [3, 2.8, 3], type: S.Bumper },
  { p: [9, 1.4, -26], s: [3, 2.8, 3], type: S.Bumper },
  { p: [-10, 1.4, -30], s: [3, 2.8, 3], type: S.Bumper },
  { p: [2, 1.4, -34], s: [3, 2.8, 3], type: S.Bumper },
  boost(-12, -18, 4, 8, 0, [1, 0, -0.6], 17),
  boost(12, -30, 4, 8, 0, [-1, 0, -0.6], 17),
  pad(0, -12, 5, 0, S.Kill),
  pad(-12, -38, 5, 0, S.Kill),
  checkpoint(12, -12),
  // Exit chute behind the table.
  plat(0, -46, 6, 10),
  goal(0, -48),
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
], { cell: 3.2, wallHeight: 1.8 });

const l10Deck: BlockDef[] = (() => {
  const b: BlockDef[] = [
    plat(0, 8, 12, 12, 40),
    ...rails(0, 8, 12, 12, 40, 1.6),
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
  b.push(...rails(x, z - 8, 16, 14, y, 2.0));
  b.push(goal(x, z - 9, y));
  return b;
})();

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
    hint: 'No grip. Brake early on the brown patches.',
    theme: 'ice', par: 100, camYaw: 22, spawn: [0, 2.5, 11],
    blocks: l5Deck,
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
    hint: 'Bumpers throw you. Use them.',
    theme: 'neon', par: 105, camYaw: 24, camDistance: 16.5, camHeight: 13.5,
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
];
