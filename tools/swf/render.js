// In-page helpers built on swf.js: load SWFs, render symbols/animations to trimmed images.
import { SWF } from './swf.js';

const cache = new Map();
export async function load(url) {
  if (!cache.has(url)) {
    cache.set(url, (async () => {
      const r = await fetch('/client/' + url);
      if (!r.ok) return null;
      const s = await SWF.load(await r.arrayBuffer());
      s.url = url;
      for (const im of s.imports) if (!cache.has(im.url)) await load(im.url).catch(() => null);
      return s;
    })());
  }
  return cache.get(url);
}
export function unload(url) { cache.delete(url); }

function resolver() {
  return (swf, id) => {
    const im = swf.imports.find((i) => i.id === id);
    if (!im) return null;
    const p = cache.get(im.url);
    if (!p || !p.done) return null;
    const lib = p.value; if (!lib) return null;
    const lid = lib.exports.get(im.name);
    return lid ? { swf: lib, id: lid } : null;
  };
}
// mark promises as settled so the sync resolver can read them
const _load = load;
export async function ready(url) {
  const s = await _load(url);
  for (const [u, p] of cache) { if (!p.done) { const v = await p; p.done = true; p.value = v; } }
  return s;
}

export function symbolId(swf, name) {
  if (typeof name === 'number') return name;
  return swf.exports.get(name) ?? null;
}

// Length (frames) of an animation export: exports are usually 1-frame wrappers around one animated sprite.
export function animLength(swf, id) {
  const def = swf.dict.get(id);
  if (!def || def.type !== 'sprite') return 1;
  let n = def.stop >= 0 ? def.stop + 1 : def.frames.length;
  if (def.frames.length === 1 && def.frames[0].length >= 1) {
    for (const e of def.frames[0]) {
      const c = swf.dict.get(e.id);
      if (c && c.type === 'sprite') n = Math.max(n, c.stop >= 0 ? c.stop + 1 : c.frames.length);
    }
  }
  return n;
}

export async function prep(swf, id) {
  await swf.prepare(id);
  // imported symbols
  for (const im of swf.imports) { const p = cache.get(im.url); if (p && p.value) { const lid = p.value.exports.get(im.name); if (lid) await p.value.prepare(lid); } }
}

let big = null;
function canvas(size) {
  if (!big || big.width !== size) { big = new OffscreenCanvas(size, size); }
  const ctx = big.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, size, size);
  return ctx;
}

function trim(ctx) {
  const { width: W, height: H } = ctx.canvas;
  const d = ctx.getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W * 4;
    for (let x = 0; x < W; x++) if (d[row + x * 4 + 3] > 2) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 };
}

// Render a symbol to a canvas. Returns {cv, ox, oy}: (ox,oy) is the registration point inside the image.
export function renderFrame(swf, id, { t = 0, scale = 1, flip = false, size = 1024, cx } = {}) {
  const ctx = canvas(size);
  const s = scale / 20;
  const m = [flip ? -s : s, 0, 0, s, size / 2, size / 2];
  swf.draw(ctx, id, m, cx, t, 0, resolver());
  return ctx;
}

async function toUrl(cv, type = 'image/png', q = 0.92) {
  const b = await cv.convertToBlob({ type, quality: q });
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
}

// Single image, trimmed.
export async function image(url, name, opts = {}) {
  const swf = await ready(url); if (!swf) return null;
  const id = symbolId(swf, name); if (id == null) return null;
  const size = opts.size || 1024;
  await prep(swf, id);
  const ctx = renderFrame(swf, id, opts);
  const b = trim(ctx); if (!b) return { empty: true };
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const out = new OffscreenCanvas(w, h); out.getContext('2d').drawImage(ctx.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
  return { data: await toUrl(out, opts.type, opts.q), w, h, ox: size / 2 - b.x0, oy: size / 2 - b.y0 };
}

// Animation -> horizontal sprite sheet with a shared frame box.
export async function sheet(url, name, opts = {}) {
  const swf = await ready(url); if (!swf) return null;
  const id = symbolId(swf, name); if (id == null) return null;
  const size = opts.size || 1024;
  const n = Math.min(animLength(swf, id), opts.maxFrames || 120);
  await prep(swf, id);
  const frames = [], nonEmpty = [];
  let U = null;
  const marks = [];
  for (let t = 0; t < n; t++) {
    globalThis.__carryMarks = [];
    const ctx = renderFrame(swf, id, { ...opts, t });
    const mk = globalThis.__carryMarks[0]; globalThis.__carryMarks = null;
    marks.push(mk ? [Math.round(mk[0] - size / 2), Math.round(mk[1] - size / 2)] : null);
    const b = trim(ctx);
    const snap = new OffscreenCanvas(size, size); snap.getContext('2d').drawImage(ctx.canvas, 0, 0);
    frames.push(snap); nonEmpty.push(!!b);
    if (b) U = U ? { x0: Math.min(U.x0, b.x0), y0: Math.min(U.y0, b.y0), x1: Math.max(U.x1, b.x1), y1: Math.max(U.y1, b.y1) } : b;
  }
  if (!U) return { empty: true, frames: n };
  if (opts.trimEnd) { let last = frames.length - 1; while (last > 0 && !nonEmpty[last]) last--; frames.length = last + 1; }
  const w = U.x1 - U.x0, h = U.y1 - U.y0;
  const nn = frames.length;
  // lay frames out in rows (WebP max 16383px wide)
  const cols = Math.max(1, Math.min(nn, Math.floor(16000 / w)));
  const rows = Math.ceil(nn / cols);
  const out = new OffscreenCanvas(w * cols, h * rows); const oc = out.getContext('2d');
  frames.forEach((f, i) => oc.drawImage(f, U.x0, U.y0, w, h, (i % cols) * w, Math.floor(i / cols) * h, w, h));
  const res = { data: await toUrl(out, opts.type || 'image/webp', opts.q || 0.9), w, h, frames: nn, cols, ox: size / 2 - U.x0, oy: size / 2 - U.y0 };
  // where a carried sprite is held, per frame, relative to the registration point
  if (marks.some(Boolean)) res.carry = marks.slice(0, nn);
  return res;
}

export function info(url) {
  const p = cache.get(url);
  return p;
}

export async function describe(url) {
  const swf = await ready(url); if (!swf) return null;
  const ex = {};
  for (const [k, id] of swf.exports) ex[k] = animLength(swf, id);
  const errs = [...swf.dict.values()].filter((d) => d.err).map((d) => d.err).slice(0, 5);
  return { exports: ex, imports: swf.imports, bitmapErrors: errs, frames: swf.frameCount };
}

// ---------- maps ----------
export const CELL_W = 53, CELL_H = 27, LEVEL_H = 20;
let gfx = null;
export async function gfxIndex() {
  if (gfx) return gfx;
  gfx = { g: new Map(), o: new Map() };
  for (const f of ['g1', 'g2']) { const s = await ready(`clips/gfx/${f}.swf`); if (s) for (const [k, id] of s.exports) if (!gfx.g.has(+k)) gfx.g.set(+k, [s, id]); }
  for (let i = 1; i <= 12; i++) { const s = await ready(`clips/gfx/o${i}.swf`); if (s) for (const [k, id] of s.exports) if (!gfx.o.has(+k)) gfx.o.set(+k, [s, id]); }
  return { g: gfx.g.size, o: gfx.o.size };
}

export function cellXY(i, W) {
  const per = 2 * W - 1;
  const pair = Math.floor(i / per); let col = i - pair * per; let row = pair * 2;
  let x;
  if (col >= W) { col -= W; row += 1; x = col * CELL_W + CELL_W; } else x = col * CELL_W + CELL_W / 2;
  return { x, y: row * (CELL_H / 2) + CELL_H / 2, row, col };
}

function groundMatrix(c, x, y, s, flipKey, rotKey) {
  let m = [1, 0, 0, 1, 0, 0];
  const rot = c[rotKey] || 0;
  let sx = 1, sy = 1;
  if (rot % 2) { sx = 0.5185; sy = 1.9286; }
  if (c[flipKey]) sx = -sx;
  const a = rot * Math.PI / 2, co = Math.cos(a), si = Math.sin(a);
  // M = T * R * S
  m = [co * sx, si * sx, -si * sy, co * sy, 0, 0];
  const k = s / 20;
  return [m[0] * k, m[1] * k, m[2] * k, m[3] * k, x * s, y * s];
}

// Renders ground + layer-1 objects into one image; layer-2 objects are returned as separate images
export async function renderMap(map, { scale = 2, pad = 0 } = {}) {
  await gfxIndex();
  const W = map.w;
  const width = Math.round(((W - 1) * CELL_W + CELL_W) * scale), height = Math.round(((map.h * 2 - 1) * CELL_H / 2 + CELL_H) * scale);
  const PADY = 140 * scale; // room for things above the top row
  const cv = new OffscreenCanvas(width, height + PADY); const ctx = cv.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
  const objs = [], missing = new Set();
  const pos = map.cells.map((c, i) => { const p = cellXY(i, W); return { x: p.x, y: p.y - (c.groundLevel - 7) * LEVEL_H + PADY / scale }; });
  const drawG = async (table, id, m) => {
    const e = table.get(id); if (!e) { missing.add(id); return; }
    await e[0].prepare(e[1]); e[0].draw(ctx, e[1], m);
  };
  if (map.bg) { const e = gfx.g.get(map.bg); if (e) { await e[0].prepare(e[1]); e[0].draw(ctx, e[1], [scale / 20, 0, 0, scale / 20, 0, PADY]); } else missing.add('bg' + map.bg); }
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < map.cells.length; i++) {
      const c = map.cells[i]; const p = pos[i];
      if (pass === 0 && c.ground) await drawG(gfx.g, c.ground, groundMatrix(c, p.x, p.y, scale, 'groundFlip', 'groundRot'));
      if (pass === 1 && c.obj1) await drawG(gfx.o, c.obj1, groundMatrix(c, p.x, p.y, scale, 'obj1Flip', 'obj1Rot'));
    }
  }
  for (let i = 0; i < map.cells.length; i++) {
    const c = map.cells[i]; if (!c.obj2) continue;
    objs.push({ cell: i, id: c.obj2, flip: c.obj2Flip, x: pos[i].x, y: pos[i].y - PADY / scale });
  }
  const b = await cv.convertToBlob({ type: 'image/webp', quality: 0.9 });
  const data = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
  return { data, w: cv.width, h: cv.height, padY: PADY, objs, missing: [...missing] };
}

// Preview: ground + obj1 + obj2 composited (for choosing maps)
export async function previewMap(map, scale = 1) {
  const r = await renderMap(map, { scale });
  const img = await createImageBitmap(await (await fetch(r.data)).blob());
  const cv = new OffscreenCanvas(r.w, r.h); const ctx = cv.getContext('2d'); ctx.drawImage(img, 0, 0);
  for (const o of r.objs) {
    const e = gfx.o.get(o.id); if (!e) continue;
    await e[0].prepare(e[1]);
    const k = scale / 20;
    e[0].draw(ctx, e[1], [o.flip ? -k : k, 0, 0, k, o.x * scale, (o.y * scale + r.padY)]);
  }
  for (const [t, col] of [[0, 'rgba(255,0,0,.6)'], [1, 'rgba(0,80,255,.6)']]) for (const c of map.places[t] || []) {
    const p = cellXY(c, map.w); const lv = map.cells[c].groundLevel;
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x * scale, (p.y - (lv - 7) * LEVEL_H) * scale + r.padY, 6 * scale, 0, 7); ctx.fill();
  }
  const b = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
}

// One layer-2 object, trimmed, with its registration point (ox, oy)
export async function objImage(gid, scale = 2) {
  await gfxIndex();
  const e = gfx.o.get(gid); if (!e) return null;
  const [swf, id] = e;
  await swf.prepare(id);
  const size = 2048;
  const ctx = canvas(size);
  swf.draw(ctx, id, [scale / 20, 0, 0, scale / 20, size / 2, size * 0.75], undefined, 0, 0, resolver());
  const b = trim(ctx); if (!b) return { empty: true };
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  const out = new OffscreenCanvas(w, h); out.getContext('2d').drawImage(ctx.canvas, b.x0, b.y0, w, h, 0, 0, w, h);
  return { data: await toUrl(out, 'image/webp', 0.9), w, h, ox: size / 2 - b.x0, oy: size * 0.75 - b.y0 };
}

// ---------- spell effects played by the client's ActionScript (server/public/js/fxplayer.js) ----------
// A "band" is the static content of one clip between two depths (lo, hi], without the instances that the
// player creates itself (keys "depth:born"). Frame t of the band is the clip t frames after it was placed.
export async function bandFrames(url, id, { lo = -1, hi = 1e9, skip = [], scale = 2, size = 1024, cap = 240 } = {}) {
  const swf = await ready(url); if (!swf) return null;
  await prep(swf, id);
  const def = swf.dict.get(id);
  const skipSet = new Set(skip);
  const keep = (e) => e.depth > lo && e.depth <= hi && !skipSet.has(e.depth + ':' + e.born);
  let n = 1;
  if (def && def.type === 'sprite') {
    n = def.stop >= 0 ? def.stop + 1 : def.frames.length;
    // static children keep playing after the clip stops
    for (const f of def.frames) for (const e of f) if (keep(e)) n = Math.max(n, e.born + animLength(swf, e.id));
  }
  n = Math.min(n, cap);
  const s = scale / 20;
  const m = [s, 0, 0, s, size / 2, size / 2];
  const frames = [];
  let U = null;
  for (let t = 0; t < n; t++) {
    const ctx = canvas(size);
    if (def && def.type === 'sprite') swf.drawList(ctx, (def.frames[swf.frameAt(def, t)] || []).filter(keep), m, [1, 1, 1, 1, 0, 0, 0, 0], t, resolver(), def);
    else swf.draw(ctx, id, m, undefined, t, 0, resolver());
    const b = trim(ctx);
    const snap = new OffscreenCanvas(size, size); snap.getContext('2d').drawImage(ctx.canvas, 0, 0);
    frames.push(b ? snap : null);
    if (b) U = U ? { x0: Math.min(U.x0, b.x0), y0: Math.min(U.y0, b.y0), x1: Math.max(U.x1, b.x1), y1: Math.max(U.y1, b.y1) } : b;
  }
  if (!U) return null;
  const total = frames.length;
  let last = frames.length - 1; while (last > 0 && !frames[last]) last--;
  frames.length = last + 1;
  const w = U.x1 - U.x0, h = U.y1 - U.y0;
  let cols = Math.max(1, Math.min(frames.length, Math.floor(4000 / w)));
  // WebP pages stay under 16383 px: widen the grid, then drop the last frames if it is still too tall
  if (Math.ceil(frames.length / cols) * h > 16000) cols = Math.max(1, Math.min(frames.length, Math.floor(16000 / w)));
  if (Math.ceil(frames.length / cols) * h > 16000) frames.length = Math.max(1, Math.floor(16000 / h) * cols);
  const rows = Math.ceil(frames.length / cols);
  const out = new OffscreenCanvas(w * cols, h * rows); const oc = out.getContext('2d');
  frames.forEach((f, i) => { if (f) oc.drawImage(f, U.x0, U.y0, w, h, (i % cols) * w, Math.floor(i / cols) * h, w, h); });
  return { cv: out, w, h, cols, frames: frames.length, ox: size / 2 - U.x0, oy: size / 2 - U.y0, total, stop: def && def.type === "sprite" ? def.stop : -1 };
}

// Shelf-packs band sheets into atlas pages (each page at most 4096 px, or one oversized sheet alone).
export async function packAtlas(sheets, { max = 4096, q = 0.85 } = {}) {
  const order = sheets.map((s, i) => i).sort((a, b) => sheets[b].cv.height - sheets[a].cv.height);
  const pages = []; const place = [];
  for (const i of order) {
    const { cv } = sheets[i]; const W = cv.width, H = cv.height;
    let done = false;
    if (W <= max && H <= max) for (let p = 0; p < pages.length && !done; p++) {
      const pg = pages[p]; if (pg.big) continue;
      if (pg.x + W <= max && pg.y + H <= max && H <= pg.shelf) { place[i] = [p, pg.x, pg.y]; pg.x += W; pg.w = Math.max(pg.w, pg.x); pg.items.push(i); done = true; }
      else if (pg.y + pg.shelf + H <= max && W <= max) { pg.y += pg.shelf; pg.x = W; pg.shelf = H; place[i] = [p, 0, pg.y]; pg.w = Math.max(pg.w, W); pg.h = pg.y + H; pg.items.push(i); done = true; }
    }
    if (!done) { pages.push({ x: W, y: 0, shelf: H, w: W, h: H, items: [i], big: W > max || H > max }); place[i] = [pages.length - 1, 0, 0]; }
  }
  const data = [];
  for (let p = 0; p < pages.length; p++) {
    const pg = pages[p];
    const out = new OffscreenCanvas(pg.w, pg.h); const oc = out.getContext('2d');
    for (const i of pg.items) oc.drawImage(sheets[i].cv, place[i][1], place[i][2]);
    data.push(await toUrl(out, 'image/webp', q));
  }
  return { pages: data, place };
}
