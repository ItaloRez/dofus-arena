// Symmetry of a fight map, so neither team starts with an advantage.
// Cells use the rotated grid of map.js (screen x ~ x - y, screen y ~ x + y). The candidate symmetries of the screen
// rectangle are the half turn (point) and the mirrors about the vertical and horizontal screen axes.
// A map is symmetric for a transform T when:
//   - T sends every walkable cell onto a walkable cell (same obstacles and holes on both sides),
//   - line of sight between any two walkable cells a, b equals line of sight between T(a) and T(b),
//   - T sends the start cells of one team exactly onto the start cells of the other.
// Non-walkable cells only matter through the lines of sight they block, so decoration outside the arena is ignored.
import { FightMap } from './map.js';

const TRANSFORMS = {
  point: (x, y, k) => [k[0] - x, k[1] - y],
  mirrorV: (x, y, k) => [y + k[0], x - k[0]],
  mirrorH: (x, y, k) => [k[0] - y, k[0] - x],
};

function offsets(cells) {
  const xs = cells.map(c => c.x), ys = cells.map(c => c.y), d = cells.map(c => c.x - c.y), s = cells.map(c => c.x + c.y);
  const span = (a) => Math.min(...a) + Math.max(...a);
  const out = { point: [span(xs), span(ys)] };
  if (span(d) % 2 === 0) out.mirrorV = [span(d) / 2];
  if (span(s) % 2 === 0) out.mirrorH = [span(s) / 2];
  return out;
}

// def: an entry of data/maps.json ({ w, h, cells: [[active, los, movement, ...]], places })
export function checkSymmetry(def) {
  const map = new FightMap({ ...def, places: def.places || [[], []] });
  const key = new Map(map.cells.filter(c => c.active).map(c => [c.x + ',' + c.y, c]));
  const walk = map.cells.filter(c => c.walk);
  const blocks = (id) => !map.cells[id].los;
  const ks = offsets(map.cells.filter(c => c.active));
  const results = [];
  for (const [name, T] of Object.entries(TRANSFORMS)) {
    if (!ks[name]) continue;
    const img = (c) => { const [x, y] = T(c.x, c.y, ks[name]); return key.get(x + ',' + y); };
    const r = { name, walkMismatch: 0, losMismatch: 0, placesOk: false, fixedPlaces: null };
    for (const c of walk) if (!img(c)?.walk) r.walkMismatch++;
    if (!r.walkMismatch) {
      for (let a = 0; a < walk.length; a++) {
        for (let b = a + 1; b < walk.length; b++) {
          if (map.lineOfSight(walk[a].id, walk[b].id, blocks) !== map.lineOfSight(img(walk[a]).id, img(walk[b]).id, blocks)) r.losMismatch++;
        }
      }
      const p0 = def.places?.[0] || [], p1 = new Set(def.places?.[1] || []);
      const mapped = p0.map(id => img(map.cells[id])?.id);
      r.placesOk = mapped.length > 0 && mapped.length === p1.size && mapped.every(id => p1.has(id));
      // team 2's start cells rebuilt as the image of team 1's
      if (!r.placesOk && mapped.length && mapped.every(id => id != null && map.cells[id].walk && !p0.includes(id))) r.fixedPlaces = [p0, mapped];
    }
    r.terrainOk = !r.walkMismatch && !r.losMismatch;
    results.push(r);
  }
  const best = results.find(r => r.terrainOk && r.placesOk) || results.find(r => r.terrainOk && r.fixedPlaces) || null;
  return { ok: !!best, best, results };
}
