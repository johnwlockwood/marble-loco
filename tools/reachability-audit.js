/**
 * Reachability audit -- can the marble actually get from spawn to goal?
 *
 * Written after shipping Pinball with its goal sealed behind an unbroken wall.
 * The original check only confirmed that a goal existed and fired when touched,
 * which it verified by teleporting the marble onto it. That proves nothing
 * about whether a player can get there.
 *
 * Usage: run the game (`npm run dev`), open the console, paste this file, then:
 *
 *     await audit.all()          // table for every level
 *     await audit.level(7)       // one level, 0-indexed
 *     await audit.map(7)         // ASCII map of what is reachable
 *
 * How it works:
 *   1. Height field, by raycasting down onto every collider. A real OBB test,
 *      so ramps read as slopes rather than as steps.
 *   2. Moving platforms are expanded into samples along their path -- you can
 *      wait for a platform, so its whole sweep counts as standable.
 *   3. Width filter: a surface only counts if the marble fits on it in both
 *      axes. Rails are 0.9 wide and the marble is 1.16, so wall tops are not
 *      a route. Without this the audit "solved" Pinball by balancing along a
 *      44-unit rail.
 *   4. Flood fill, then ballistic gap jumps whose arc must clear whatever it
 *      flies over. Repeated to a fixpoint -- each round only advances the
 *      frontier by one jump, and Clockwork needs eight.
 *
 * It is deliberately generous: it should never call a beatable level broken.
 * A FAIL is worth investigating; an OK is not proof the level is fun.
 */
(function () {
  const RES = 0.5;
  const STEP_UP = 2.15;   // measured standing-jump clearance under the ball
  const JUMP_V = 12.5;    // must match JUMP_SPEED in Game.ts
  const GRAV = 34;        // must match GRAVITY in Game.ts
  const MAX_GAP = 8.0;    // generous horizontal jump reach

  function build(g) {
    const L = g.level;
    const DIAM = 2 * g.body.radius;

    // Expand movers into their swept positions.
    const cols = [];
    for (const c of L.colliders) {
      if (!c.active) continue;
      const def = L.defByCollider.get(c);
      if (def && def.move) {
        for (let s = 0; s <= 6; s++) {
          const t = s / 6;
          const cx = def.p[0] + (def.move.to[0] - def.p[0]) * t;
          const cy = def.p[1] + (def.move.to[1] - def.p[1]) * t;
          const cz = def.p[2] + (def.move.to[2] - def.p[2]) * t;
          cols.push({
            center: { x: cx, y: cy, z: cz }, half: c.half, invQuat: c.invQuat,
            min: { x: cx - c.half.x, y: cy - c.half.y, z: cz - c.half.z },
            max: { x: cx + c.half.x, y: cy + c.half.y, z: cz + c.half.z },
          });
        }
      } else cols.push(c);
    }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const c of cols) {
      minX = Math.min(minX, c.min.x); maxX = Math.max(maxX, c.max.x);
      minZ = Math.min(minZ, c.min.z); maxZ = Math.max(maxZ, c.max.z);
    }
    minX -= 1; maxX += 1; minZ -= 1; maxZ += 1;

    const W = Math.ceil((maxX - minX) / RES);
    const H = Math.ceil((maxZ - minZ) / RES);
    const idx = (i, j) => j * W + i;

    const TOP = 500;
    const V3 = g.body.position.constructor;
    const p = new V3(), d = new V3();
    const AX = ['x', 'y', 'z'];

    function hitY(c, x, z) {
      if (x < c.min.x || x > c.max.x || z < c.min.z || z > c.max.z) return null;
      p.set(x - c.center.x, TOP - c.center.y, z - c.center.z).applyQuaternion(c.invQuat);
      d.set(0, -1, 0).applyQuaternion(c.invQuat);
      let t0 = -Infinity, t1 = Infinity;
      for (const ax of AX) {
        const o = p[ax], dir = d[ax], h = c.half[ax];
        if (Math.abs(dir) < 1e-9) { if (o < -h || o > h) return null; continue; }
        let ta = (-h - o) / dir, tb = (h - o) / dir;
        if (ta > tb) { const s = ta; ta = tb; tb = s; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) return null;
      }
      return t0 < 0 ? null : TOP - t0;
    }

    const floor = new Float32Array(W * H).fill(NaN);
    for (let j = 0; j < H; j++) {
      const z = minZ + (j + 0.5) * RES;
      for (let i = 0; i < W; i++) {
        const x = minX + (i + 0.5) * RES;
        let best = NaN;
        for (const c of cols) {
          const y = hitY(c, x, z);
          if (y !== null && (isNaN(best) || y > best)) best = y;
        }
        floor[j * W + i] = best;
      }
    }

    // Width filter: the marble must fit, in both axes.
    const stable = new Uint8Array(W * H);
    const TOL = 0.45, CAP = 6;
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = idx(i, j), y = floor[k];
      if (isNaN(y)) continue;
      let ex = 1, ez = 1;
      for (const [di, dj, ax] of [[1,0,0],[-1,0,0],[0,1,1],[0,-1,1]]) {
        let n = 0;
        for (let s = 1; s <= CAP; s++) {
          const ni = i + di * s, nj = j + dj * s;
          if (ni < 0 || ni >= W || nj < 0 || nj >= H) break;
          const ny = floor[idx(ni, nj)];
          if (isNaN(ny) || Math.abs(ny - y) > TOL) break;
          n++;
        }
        if (ax === 0) ex += n; else ez += n;
      }
      if (Math.min(ex, ez) * RES >= DIAM) stable[k] = 1;
    }

    const cellOf = (x, z) => [
      Math.min(W - 1, Math.max(0, Math.floor((x - minX) / RES))),
      Math.min(H - 1, Math.max(0, Math.floor((z - minZ) / RES))),
    ];

    const seen = new Uint8Array(W * H);
    const queue = [];
    const [si, sj] = cellOf(L.spawn.x, L.spawn.z);
    for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
      const i = si + di, j = sj + dj;
      if (i < 0 || i >= W || j < 0 || j >= H) continue;
      const k = idx(i, j);
      if (stable[k] && floor[k] <= L.spawn.y + 0.5 && !seen[k]) { seen[k] = 1; queue.push([i, j]); }
    }

    function walk() {
      while (queue.length) {
        const [i, j] = queue.pop(), y = floor[idx(i, j)];
        for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue;
          const k = idx(ni, nj);
          if (seen[k] || !stable[k]) continue;
          if (floor[k] - y > STEP_UP) continue;
          seen[k] = 1; queue.push([ni, nj]);
        }
      }
    }
    walk();

    const reach = Math.ceil(MAX_GAP / RES);
    function tryJumps() {
      let added = 0;
      const front = [];
      for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
        if (!seen[idx(i, j)]) continue;
        for (const [di, dj] of [[1,0],[-1,0],[0,1],[0,-1]]) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue;
          if (!seen[idx(ni, nj)]) { front.push([i, j]); break; }
        }
      }
      for (const [i, j] of front) {
        const y0 = floor[idx(i, j)];
        for (let dj = -reach; dj <= reach; dj++) for (let di = -reach; di <= reach; di++) {
          const ni = i + di, nj = j + dj;
          if (ni < 0 || ni >= W || nj < 0 || nj >= H) continue;
          const k = idx(ni, nj);
          if (seen[k] || !stable[k]) continue;
          const y1 = floor[k];
          const dist = Math.hypot(di, dj) * RES;
          if (dist < 1e-6 || dist > MAX_GAP) continue;
          if (y1 - y0 > STEP_UP) continue;
          const disc = JUMP_V * JUMP_V + 2 * GRAV * (y0 - y1);
          if (disc < 0) continue;
          const T = (JUMP_V + Math.sqrt(disc)) / GRAV;
          let blocked = false;
          const steps = Math.max(2, Math.ceil(dist / RES));
          for (let s = 1; s < steps; s++) {
            const f = s / steps;
            const cx = minX + (i + 0.5 + di * f) * RES;
            const cz = minZ + (j + 0.5 + dj * f) * RES;
            const t = f * T;
            const arcY = y0 + JUMP_V * t - 0.5 * GRAV * t * t;
            let obst = -Infinity;
            for (const c of cols) {
              const y = hitY(c, cx, cz);
              if (y !== null && y > obst) obst = y;
            }
            if (obst > arcY) { blocked = true; break; }
          }
          if (blocked) continue;
          seen[k] = 1; queue.push([ni, nj]); added++;
        }
      }
      walk();
      return added;
    }

    // To a fixpoint: one round advances the frontier by a single jump.
    let rounds = 0;
    for (let pass = 0; pass < 30; pass++) { rounds++; if (tryJumps() === 0) break; }

    const near = (x, z) => {
      const [ci, cj] = cellOf(x, z);
      for (let dj = -3; dj <= 3; dj++) for (let di = -3; di <= 3; di++) {
        const i = ci + di, j = cj + dj;
        if (i >= 0 && i < W && j >= 0 && j < H && seen[idx(i, j)]) return true;
      }
      return false;
    };

    return { L, W, H, idx, floor, stable, seen, near, minX, minZ, rounds };
  }

  async function load(levelIndex) {
    const g = window.game;
    if (!g) throw new Error('window.game not found -- run a dev build');
    g.beginLevel(levelIndex);
    await new Promise((r) => setTimeout(r, 250));
    return g;
  }

  window.audit = {
    async level(levelIndex) {
      const g = await load(levelIndex);
      const s = build(g);
      let st = 0, rc = 0;
      for (let k = 0; k < s.W * s.H; k++) { if (s.stable[k]) st++; if (s.seen[k]) rc++; }
      return {
        level: levelIndex + 1,
        name: s.L.def.name,
        goal: s.near(s.L.goalPosition.x, s.L.goalPosition.z),
        checkpoints: s.L.checkpoints.map((cp) => s.near(cp.collider.center.x, cp.collider.center.z)),
        coverage: Math.round((100 * rc) / st) + '%',
        rounds: s.rounds,
      };
    },

    async all() {
      const n = 10;
      const rows = [];
      for (let i = 0; i < n; i++) rows.push(await this.level(i));
      const bad = rows.filter((r) => !r.goal || r.checkpoints.some((c) => !c));
      console.table(rows);
      console.log(bad.length ? `FAIL: ${bad.map((r) => r.name).join(', ')}` : 'All levels reachable.');
      return rows;
    },

    /** '#' reached, '-' stable but unreached, '.' too narrow, ' ' void. */
    async map(levelIndex) {
      const g = await load(levelIndex);
      const s = build(g);
      let out = '';
      for (let j = 0; j < s.H; j++) {
        let row = '';
        for (let i = 0; i < s.W; i++) {
          const k = s.idx(i, j);
          row += s.seen[k] ? '#' : s.stable[k] ? '-' : isNaN(s.floor[k]) ? ' ' : '.';
        }
        out += `${(s.minZ + (j + 0.5) * RES).toFixed(0).padStart(5)} |${row}|\n`;
      }
      console.log(out);
      return out;
    },
  };

  console.log('audit ready: await audit.all() / audit.level(i) / audit.map(i)');
})();
