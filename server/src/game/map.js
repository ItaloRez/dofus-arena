// Isometric fight map. Cells use rotated coordinates (x, y): the 4 neighbours of a cell are
// (x±1, y) and (x, y±1), like the Dofus fight grid (screen diagonals).
// The map is the set of cells with |x - y| <= W and 0 <= x + y <= H (a rectangle on screen).

export const BASE64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_';
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];


// Real Dofus 1.29 fight maps (cells, line of sight, placement) exported by tools/swf/export.cjs.
// Shared with the browser: no Node imports here (the loader lives in maps.js).

// Dofus cell id -> rotated grid coordinates (same formula as the 1.29 client)
export function cellCoord(id, W) {
  const row = Math.floor(id / (W * 2 - 1));
  const r = id - row * (W * 2 - 1);
  const y = row - (r % W);
  const x = (id - (W - 1) * y) / W;
  return [x, y];
}

export class FightMap {
  // def: an entry of data/maps.json: { id, name, w, h, places, cells: [active, los, movement, groundLevel, slope], objs, img }
  constructor(def) {
    this.def = def;
    this.id = def.id;
    this.name = String(def.name).replace(/^\/+/, '');
    this.W = def.w;
    this.cells = [];
    this.byKey = new Map();
    def.cells.forEach(([active, los, movement], id) => {
      const [x, y] = cellCoord(id, def.w);
      const cell = { id, x, y, active: !!active, walk: !!active && movement > 1, los: !active || !!los };
      this.cells.push(cell);
      if (active) this.byKey.set(x + ',' + y, cell);
    });
    // keep only placement cells that are walkable
    this.placement = def.places.map(t => t.filter(id => this.cells[id] && this.cells[id].walk));
  }

  at(x, y) { return this.byKey.get(x + ',' + y); }
  cell(id) { return this.cells[id]; }

  neighbors(id) {
    const c = this.cells[id];
    const out = [];
    for (const [dx, dy] of DIRS) {
      const n = this.at(c.x + dx, c.y + dy);
      if (n) out.push(n.id);
    }
    return out;
  }

  dist(a, b) {
    const A = this.cells[a], B = this.cells[b];
    return Math.abs(A.x - B.x) + Math.abs(A.y - B.y);
  }

  inLine(a, b) {
    const A = this.cells[a], B = this.cells[b];
    return A.x === B.x || A.y === B.y;
  }

  // Direction (dx, dy) from a to b. 8 directions: diagonals of the grid are allowed when |dx| == |dy|
  direction(a, b) {
    const A = this.cells[a], B = this.cells[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    if (dx === 0 && dy === 0) return [1, 0];
    if (Math.abs(dx) === Math.abs(dy)) return [Math.sign(dx), Math.sign(dy)];
    if (Math.abs(dx) > Math.abs(dy)) return [Math.sign(dx), 0];
    return [0, Math.sign(dy)];
  }

  next(id, [dx, dy], n = 1) {
    const c = this.cells[id];
    const r = this.at(c.x + dx * n, c.y + dy * n);
    return r ? r.id : -1;
  }

  // Line of sight from a to b. isBlocking(cellId) tells if a cell (other than a and b) blocks the view.
  lineOfSight(a, b, isBlocking) {
    if (a === b) return true;
    const A = this.cells[a], B = this.cells[b];
    const dx = B.x - A.x, dy = B.y - A.y;
    const steps = (Math.abs(dx) + Math.abs(dy)) * 8;
    const eps = 1e-6;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = A.x + dx * t, py = A.y + dy * t;
      const xs = Math.abs(px - Math.floor(px) - 0.5) < eps ? [Math.floor(px), Math.ceil(px)] : [Math.round(px)];
      const ys = Math.abs(py - Math.floor(py) - 0.5) < eps ? [Math.floor(py), Math.ceil(py)] : [Math.round(py)];
      let free = false, any = false;
      for (const x of xs) for (const y of ys) {
        const c = this.at(x, y);
        if (!c) continue;
        if (c.id === a || c.id === b) { free = true; continue; }
        any = true;
        if (!isBlocking(c.id)) free = true;
      }
      if (any && !free) return false;
    }
    return true;
  }

  // Cells of a spell area ('Pa', 'Cb', 'Lc'...) centered on target, oriented from origin to target
  area(zone, origin, target) {
    const shape = zone[0];
    const size = Math.max(BASE64.indexOf(zone[1] || 'a'), 0);
    const T = this.cells[target];
    const out = [];
    const add = (x, y) => { const c = this.at(x, y); if (c) out.push(c.id); };
    let [dx, dy] = this.direction(origin, target);
    if (origin === target) [dx, dy] = [1, 0];
    // lines only follow the 4 grid axes; off-axis, the client (Pathfinding.getDirection) takes the x axis
    // whenever x differs, so the zone shown and the zone hit are the same
    if (dx !== 0 && dy !== 0) dy = 0;
    switch (shape) {
      case 'C':
      case 'D':
      case 'O':
        for (const c of this.cells) {
          if (!c.active) continue;
          const d = Math.abs(c.x - T.x) + Math.abs(c.y - T.y);
          if (d > size) continue;
          if (shape === 'O' && d !== size) continue;
          if (shape === 'D' && d % 2 !== size % 2) continue;
          out.push(c.id);
        }
        out.sort((p, q) => this.dist(p, target) - this.dist(q, target));
        break;
      case 'X':
        add(T.x, T.y);
        for (let i = 1; i <= size; i++) for (const [ax, ay] of DIRS) add(T.x + ax * i, T.y + ay * i);
        break;
      case 'L':
        for (let i = 0; i <= size; i++) add(T.x + dx * i, T.y + dy * i);
        break;
      case 'T':
        add(T.x, T.y);
        for (let i = 1; i <= size; i++) { add(T.x + dy * i, T.y + dx * i); add(T.x - dy * i, T.y - dx * i); }
        break;
      default:
        out.push(target);
    }
    return out;
  }

  // Same shape as a data/maps.json entry, so the browser can rebuild the map with new FightMap(json)
  toJSON() {
    const d = this.def;
    return { id: d.id, name: this.name, area: d.area, w: d.w, h: d.h, img: d.img, objs: d.objs, places: d.places,
      cells: d.cells.map(c => [c[0], c[1], c[2], c[3]]) };
  }
}
