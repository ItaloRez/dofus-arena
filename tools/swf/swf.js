// Minimal SWF (Flash 8) parser + canvas renderer, enough for Dofus 1.29 gfx.
// Runs in a browser (uses canvas, createImageBitmap, DecompressionStream).

class Bits {
  constructor(u8, pos = 0) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.pos = pos; this.bit = 0; this.cur = 0; }
  align() { this.bit = 0; }
  u8_() { this.align(); return this.u8[this.pos++]; }
  u16() { this.align(); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  s16() { this.align(); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.align(); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  ub(n) {
    let v = 0;
    while (n > 0) {
      if (this.bit === 0) { this.cur = this.u8[this.pos++]; this.bit = 8; }
      const take = Math.min(n, this.bit);
      v = v * (1 << take) + ((this.cur >> (this.bit - take)) & ((1 << take) - 1));
      this.bit -= take; n -= take;
    }
    return v;
  }
  sb(n) { if (!n) return 0; const v = this.ub(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  fb(n) { return this.sb(n) / 65536; }
  str() { this.align(); let e = this.pos; while (this.u8[e]) e++; const s = new TextDecoder('latin1').decode(this.u8.subarray(this.pos, e)); this.pos = e + 1; return s; }
  rect() { this.align(); const n = this.ub(5); const r = { xmin: this.sb(n), xmax: this.sb(n), ymin: this.sb(n), ymax: this.sb(n) }; this.align(); return r; }
  matrix() {
    this.align();
    const m = [1, 0, 0, 1, 0, 0];
    if (this.ub(1)) { const n = this.ub(5); m[0] = this.fb(n); m[3] = this.fb(n); }
    if (this.ub(1)) { const n = this.ub(5); m[1] = this.fb(n); m[2] = this.fb(n); }
    const n = this.ub(5); m[4] = this.sb(n); m[5] = this.sb(n);
    this.align();
    return m;
  }
  cxform(alpha) {
    this.align();
    const hasAdd = this.ub(1), hasMult = this.ub(1), n = this.ub(4);
    const c = [1, 1, 1, 1, 0, 0, 0, 0];
    if (hasMult) { c[0] = this.sb(n) / 256; c[1] = this.sb(n) / 256; c[2] = this.sb(n) / 256; if (alpha) c[3] = this.sb(n) / 256; }
    if (hasAdd) { c[4] = this.sb(n); c[5] = this.sb(n); c[6] = this.sb(n); if (alpha) c[7] = this.sb(n); }
    this.align();
    return c;
  }
  rgb() { return [this.u8_(), this.u8_(), this.u8_(), 255]; }
  rgba() { return [this.u8_(), this.u8_(), this.u8_(), this.u8_()]; }
}

const ID_CX = [1, 1, 1, 1, 0, 0, 0, 0];
export const mulM = (a, b) => [ // a ∘ b (apply b then a)
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const invM = (m) => {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
};
const mulCx = (a, b) => [ // parent a applied after child b
  a[0] * b[0], a[1] * b[1], a[2] * b[2], a[3] * b[3],
  a[0] * b[4] + a[4], a[1] * b[5] + a[5], a[2] * b[6] + a[6], a[3] * b[7] + a[7]];
const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
const applyCx = (c, cx) => [clamp(c[0] * cx[0] + cx[4]), clamp(c[1] * cx[1] + cx[5]), clamp(c[2] * cx[2] + cx[6]), clamp(c[3] * cx[3] + cx[7])];
const css = (c) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${(c[3] / 255).toFixed(4)})`;

async function inflate(u8) {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(u8); w.close();
  return new Uint8Array(await new Response(ds.readable).arrayBuffer());
}

export class SWF {
  static async load(buf) {
    let u8 = new Uint8Array(buf);
    const sig = String.fromCharCode(u8[0], u8[1], u8[2]);
    if (sig === 'CWS') {
      const body = await inflate(u8.subarray(8));
      const full = new Uint8Array(8 + body.length); full.set(u8.subarray(0, 8)); full.set(body, 8); u8 = full;
    } else if (sig !== 'FWS') throw new Error('not a swf: ' + sig);
    return new SWF(u8);
  }

  constructor(u8) {
    this.u8 = u8;
    this.version = u8[3];
    this.dict = new Map();
    this.exports = new Map();
    this.imports = [];
    this.jpegTables = null;
    const r = new Bits(u8, 8);
    this.bounds = r.rect();
    this.fps = r.u16() / 256; this.frameCount = r.u16();
    this.root = this.parseTimeline(r.pos, u8.length, 0);
    this.dict.set(0, { type: 'sprite', frameCount: this.frameCount, ...this.root });
    // Spiritia costume selector: empty placeholder sprites whose art lives in "_costumeFallback<id>"
    this.fallback = new Map();
    for (const [k, v] of this.exports) { const m = /^_costumeFallback(\d+)$/.exec(k); if (m) this.fallback.set(+m[1], v); }
    // the carry marker comes with a placeholder drawing (a disc) placed on the same spot: never draw those
    if (this.carryMarkers) {
      this.carryHide = new Set();
      for (const def of this.dict.values()) if (def.type === 'sprite') for (const f of def.frames) {
        const mk = f.find((e) => this.carryMarkers.has(e.id)); if (!mk) continue;
        // it sits 10 depths below the marker and is a sprite wrapping a single shape
        for (const e of f) {
          if (e.depth !== mk.depth - 10) continue;
          const d = this.dict.get(e.id);
          if (d && d.type === 'sprite' && d.frames.length === 1 && d.frames[0].length === 1 && this.dict.get(d.frames[0][0].id)?.type === 'shape') this.carryHide.add(e.id);
        }
      }
    }
  }

  *tags(pos, end) {
    const dv = new DataView(this.u8.buffer, this.u8.byteOffset);
    while (pos + 2 <= end) {
      const h = dv.getUint16(pos, true); pos += 2;
      const code = h >> 6; let len = h & 63;
      if (len === 63) { len = dv.getUint32(pos, true); pos += 4; }
      yield [code, pos, len];
      pos += len;
      if (code === 0) return;
    }
  }

  parseTimeline(pos, end, id) {
    const frames = []; const list = new Map(); let fi = 0; const stops = [];
    const snapshot = () => frames.push([...list.entries()].sort((a, b) => a[0] - b[0]).map(([d, e]) => ({ depth: d, ...e })));
    for (const [code, p, len] of this.tags(pos, end)) {
      const r = new Bits(this.u8, p);
      switch (code) {
        case 1: snapshot(); fi++; break;
        case 2: case 22: case 32: case 83: case 46: case 84: { const sid = r.u16(); this.dict.set(sid, { type: 'shape', code, pos: p, end: p + len }); break; }
        case 6: { const cid = r.u16(); this.dict.set(cid, { type: 'bitmap', kind: 'jpeg1', data: this.u8.subarray(r.pos, p + len) }); break; }
        case 8: this.jpegTables = this.u8.subarray(p, p + len); break;
        case 21: { const cid = r.u16(); this.dict.set(cid, { type: 'bitmap', kind: 'jpeg2', data: this.u8.subarray(r.pos, p + len) }); break; }
        case 35: { const cid = r.u16(); const off = r.u32(); this.dict.set(cid, { type: 'bitmap', kind: 'jpeg3', data: this.u8.subarray(r.pos, r.pos + off), alpha: this.u8.subarray(r.pos + off, p + len) }); break; }
        case 20: case 36: {
          const cid = r.u16(); const fmt = r.u8_(); const w = r.u16(); const h = r.u16();
          const ct = fmt === 3 ? r.u8_() + 1 : 0;
          this.dict.set(cid, { type: 'bitmap', kind: code === 20 ? 'll1' : 'll2', fmt, w, h, ct, data: this.u8.subarray(r.pos, p + len) });
          break;
        }
        case 39: { const sid = r.u16(); const fc = r.u16(); const tl = this.parseTimeline(r.pos, p + len, sid); this.dict.set(sid, { type: 'sprite', frameCount: fc, ...tl }); break; }
        case 4: { // PlaceObject
          const cid = r.u16(), depth = r.u16(), m = r.matrix();
          const cx = r.pos < p + len ? r.cxform(false) : ID_CX;
          list.set(depth, { id: cid, m, cx, born: fi, clip: 0 }); break;
        }
        case 26: case 70: {
          const f = r.u8_(); const f2 = code === 70 ? r.u8_() : 0; const depth = r.u16();
          if (code === 70 && ((f2 & 8) || ((f2 & 16) && (f & 2)))) r.str();
          const prev = list.get(depth);
          const e = prev && (f & 1) ? { ...prev } : { id: 0, m: [1, 0, 0, 1, 0, 0], cx: ID_CX, born: fi, clip: 0, ratio: 0 };
          if (f & 2) { const cid = r.u16(); if (!prev || prev.id !== cid || !(f & 1)) e.born = fi; e.id = cid; }
          if (f & 4) e.m = r.matrix();
          if (f & 8) e.cx = r.cxform(true);
          if (f & 16) e.ratio = r.u16() / 65535;
          if (f & 32) e.name = r.str();
          if (f & 64) e.clip = r.u16();
          if (e.id) list.set(depth, e);
          break;
        }
        case 5: { r.u16(); list.delete(r.u16()); break; }
        case 28: list.delete(r.u16()); break;
        case 12: { // DoAction: detect a bare stop()
          const a = this.u8.subarray(p, p + len);
          if (a[0] === 0x07 || (a.includes(0x07) && len <= 3)) stops.push(fi);
          // the clip that marks where a carried sprite is held calls registerCarried(this)
          if (len > 15 && new TextDecoder('latin1').decode(a).includes('registerCarried')) (this.carryMarkers ||= new Set()).add(id);
          break;
        }
        case 56: { const n = r.u16(); for (let i = 0; i < n; i++) { const cid = r.u16(); this.exports.set(r.str(), cid); } break; }
        case 57: case 71: {
          const url = r.str(); if (code === 71) r.u16();
          const n = r.u16(); for (let i = 0; i < n; i++) { const cid = r.u16(); this.imports.push({ url, id: cid, name: r.str() }); }
          break;
        }
      }
    }
    if (!frames.length) snapshot();
    return { frames, stop: stops.length ? stops[0] : -1 };
  }

  readFills(r, shape, morph) {
    let n = r.u8_(); if (n === 255 && shape >= 2) n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.readFill(r, shape, morph));
    return out;
  }

  readFill(r, shape, morph) {
    const t = r.u8_();
    const col = () => (shape >= 3 ? r.rgba() : r.rgb());
    if (t === 0) { const c = col(); if (morph) col(); return { t: 's', c }; }
    if (t === 0x10 || t === 0x12 || t === 0x13) {
      const m = r.matrix(); if (morph) r.matrix();
      const b = r.u8_(); const n = b & 15; const stops = [];
      for (let i = 0; i < n; i++) { const ratio = r.u8_(); const c = col(); if (morph) { r.u8_(); col(); } stops.push([ratio / 255, c]); }
      let focal = 0; if (t === 0x13) focal = r.s16() / 256;
      return { t: t === 0x10 ? 'lg' : 'rg', m, stops, focal, spread: b >> 6 };
    }
    if (t >= 0x40 && t <= 0x43) { const id = r.u16(); const m = r.matrix(); if (morph) r.matrix(); return { t: 'b', id, m, repeat: !(t & 1), smooth: !(t & 2) }; }
    throw new Error('fill type ' + t);
  }

  readLines(r, shape, morph) {
    let n = r.u8_(); if (n === 255) n = r.u16();
    const out = [];
    for (let i = 0; i < n; i++) {
      const w = r.u16(); if (morph) r.u16();
      if (shape === 4) {
        r.align(); const sc = r.ub(2), join = r.ub(2), hasFill = r.ub(1); r.ub(3); r.ub(5); r.ub(1); r.ub(2);
        if (join === 2) r.u16();
        if (hasFill) { const f = this.readFill(r, 4, morph); out.push({ w, c: f.c || (f.stops ? f.stops[0][1] : [0, 0, 0, 255]), cap: sc }); }
        else { const c = r.rgba(); if (morph) r.rgba(); out.push({ w, c, cap: sc }); }
      } else {
        const c = shape >= 3 ? r.rgba() : r.rgb(); if (morph) shape >= 3 ? r.rgba() : r.rgb();
        out.push({ w, c });
      }
    }
    return out;
  }

  // Parse SHAPE records into groups of {fills, lines, edges}
  readRecords(r, shape, fills, lines, styles) {
    let fb = r.ub(4), lb = r.ub(4);
    const groups = [];
    let g = { fills, lines, edges: [] }; groups.push(g);
    let x = 0, y = 0, f0 = 0, f1 = 0, ln = 0;
    for (;;) {
      if (r.ub(1) === 0) {
        const fl = r.ub(5);
        if (!fl) break;
        if (fl & 1) { const n = r.ub(5); x = r.sb(n); y = r.sb(n); }
        if (fl & 2) f0 = r.ub(fb);
        if (fl & 4) f1 = r.ub(fb);
        if (fl & 8) ln = r.ub(lb);
        if (fl & 16) {
          if (!styles) break;
          const nf = this.readFills(r, shape, false), nl = this.readLines(r, shape, false);
          fb = r.ub(4); lb = r.ub(4);
          g = { fills: nf, lines: nl, edges: [] }; groups.push(g);
          // style changes in the same record are relative to the new arrays
        }
      } else if (r.ub(1)) { // straight
        const n = r.ub(4) + 2;
        let dx = 0, dy = 0;
        if (r.ub(1)) { dx = r.sb(n); dy = r.sb(n); } else if (r.ub(1)) dy = r.sb(n); else dx = r.sb(n);
        g.edges.push({ x0: x, y0: y, x1: x + dx, y1: y + dy, f0, f1, ln }); x += dx; y += dy;
      } else {
        const n = r.ub(4) + 2;
        const cx = x + r.sb(n), cy = y + r.sb(n), ax = cx + r.sb(n), ay = cy + r.sb(n);
        g.edges.push({ x0: x, y0: y, cx, cy, x1: ax, y1: ay, f0, f1, ln }); x = ax; y = ay;
      }
    }
    return groups;
  }

  compileShape(def) {
    if (def.layers) return def;
    const r = new Bits(this.u8, def.pos);
    if (def.code === 46 || def.code === 84) return this.defineMorph(r, def.code, def);
    const shape = { 2: 1, 22: 2, 32: 3, 83: 4 }[def.code];
    const id = r.u16(); const bounds = r.rect();
    if (shape === 4) { r.rect(); r.u8_(); }
    const fills = this.readFills(r, shape, false), lines = this.readLines(r, shape, false);
    const groups = this.readRecords(r, shape, fills, lines, true);
    def.bounds = bounds; def.layers = compile(groups);
    return def;
  }

  defineMorph(r, code, def) {
    const id = r.u16(); const bounds = r.rect(); r.rect();
    if (code === 84) { r.rect(); r.rect(); r.u8_(); }
    r.u32();
    const shape = code === 84 ? 4 : 3;
    const fills = this.readFills(r, 3, true), lines = this.readLines(r, shape, true);
    r.align();
    const groups = this.readRecords(r, 3, fills, lines, false);
    def.bounds = bounds; def.layers = compile(groups);
    return def;
  }

  // Decode every bitmap reachable from a character (must be awaited before draw()).
  async prepare(id, seen = new Set()) {
    if (seen.has(id)) return; seen.add(id);
    if (this.fallback && this.fallback.has(id)) await this.prepare(this.fallback.get(id), seen);
    const d = this.dict.get(id); if (!d) return;
    if (d.type === 'sprite') { for (const f of d.frames) for (const e of f) await this.prepare(e.id, seen); }
    else if (d.type === 'shape') {
      try { this.compileShape(d); } catch (e) { d.layers = []; d.err = String(e); return; }
      for (const L of d.layers) if (L.style && L.style.t === 'b') await this.prepare(L.style.id, seen);
    } else if (d.type === 'bitmap' && d.img === undefined) {
      try { d.img = await this.decodeBitmap(d); } catch (e) { d.img = null; d.err = String(e); }
    }
  }

  async decodeBitmap(d) {
    if (d.kind.startsWith('jpeg')) {
      let data = d.data;
      if (d.kind === 'jpeg1' && this.jpegTables) {
        const t = this.jpegTables; const tEnd = t[t.length - 2] === 0xff && t[t.length - 1] === 0xd9 ? t.length - 2 : t.length;
        const dStart = data[0] === 0xff && data[1] === 0xd8 ? 2 : 0;
        const m = new Uint8Array(tEnd + data.length - dStart); m.set(t.subarray(0, tEnd)); m.set(data.subarray(dStart), tEnd); data = m;
      }
      data = fixJpeg(data);
      const img = await createImageBitmap(new Blob([data]));
      const cv = new OffscreenCanvas(img.width, img.height); const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0);
      if (d.kind === 'jpeg3' && d.alpha && d.alpha.length) {
        const a = await inflate(d.alpha);
        const id = cx.getImageData(0, 0, img.width, img.height);
        for (let i = 0, n = img.width * img.height; i < n; i++) {
          const al = a[i]; id.data[i * 4 + 3] = al;
          if (al && al < 255) for (let k = 0; k < 3; k++) id.data[i * 4 + k] = Math.min(255, id.data[i * 4 + k] * 255 / al);
        }
        cx.putImageData(id, 0, 0);
      }
      return cv;
    }
    const raw = await inflate(d.data);
    const { w, h, fmt, ct } = d; const alpha = d.kind === 'll2';
    const out = new ImageData(w, h); const o = out.data;
    let p = 0;
    const put = (i, r, g, b, a) => {
      if (alpha && a && a < 255) { r = r * 255 / a; g = g * 255 / a; b = b * 255 / a; }
      o[i] = r; o[i + 1] = g; o[i + 2] = b; o[i + 3] = a;
    };
    if (fmt === 3) {
      const cs = alpha ? 4 : 3; const table = raw.subarray(0, ct * cs); p = ct * cs;
      const stride = (w + 3) & ~3;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const ci = raw[p + y * stride + x]; const i = (y * w + x) * 4;
        if (ci < ct) put(i, table[ci * cs], table[ci * cs + 1], table[ci * cs + 2], alpha ? table[ci * cs + 3] : 255);
      }
    } else if (fmt === 4) {
      const stride = (w * 2 + 3) & ~3;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const v = (raw[y * stride + x * 2] << 8) | raw[y * stride + x * 2 + 1]; const i = (y * w + x) * 4;
        put(i, ((v >> 10) & 31) * 8.226, ((v >> 5) & 31) * 8.226, (v & 31) * 8.226, 255);
      }
    } else {
      for (let k = 0, n = w * h; k < n; k++) put(k * 4, raw[k * 4 + 1], raw[k * 4 + 2], raw[k * 4 + 3], alpha ? raw[k * 4] : 255);
    }
    const cv = new OffscreenCanvas(w, h); cv.getContext('2d').putImageData(out, 0, 0);
    return cv;
  }

  // ---------- rendering ----------
  // t: frames elapsed since this instance was placed
  frameAt(def, t) {
    const n = def.frames.length;
    if (def.stop >= 0 && t >= def.stop) return def.stop;
    return ((t % n) + n) % n;
  }

  // Render character id into ctx with matrix m (twips→device already included) and color transform cx.
  draw(ctx, id, m, cx = ID_CX, t = 0, ratio = 0, resolve) {
    let def = this.dict.get(id); let swf = this;
    if (!def && resolve) { const r = resolve(this, id); if (r) { swf = r.swf; def = r.swf.dict.get(r.id); id = r.id; } }
    if (!def) return;
    if (swf.fallback && swf.fallback.has(id)) { id = swf.fallback.get(id); def = swf.dict.get(id); if (!def) return; }
    if (def.type === 'shape') { if (!def.layers) return; return swf.drawShape(ctx, def, m, cx); }
    // the carry marker is only a placeholder: the client puts the carried sprite there instead of drawing it
    if (swf.carryHide && swf.carryHide.has(id)) return;
    if (def.type === 'sprite' && swf.carryMarkers && swf.carryMarkers.has(id)) { if (globalThis.__carryMarks) globalThis.__carryMarks.push([m[4], m[5]]); return; }
    if (def.type === 'sprite') return swf.drawList(ctx, def.frames[swf.frameAt(def, t)] || [], m, cx, t, resolve, def);
  }

  // Time elapsed for a child entry: children that are never removed keep playing across parent loops.
  childTime(def, t, e) {
    if (!def) return t - e.born;
    if (def.stop >= 0 && t >= def.stop) return t - e.born;
    if (!def.persist) {
      const last = def.frames[def.frames.length - 1] || [];
      def.persist = new Set(last.filter((x) => x.born === 0).map((x) => x.depth + ':' + x.id));
    }
    if (e.born === 0 && def.persist.has(e.depth + ':' + e.id)) return t;
    return this.frameAt(def, t) - e.born;
  }

  drawList(ctx, list, m, cx, t, resolve, def) {
    let mask = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.clip) {
        // render masked range offscreen
        const W = ctx.canvas.width, H = ctx.canvas.height;
        const content = new OffscreenCanvas(W, H); const cc = content.getContext('2d');
        let j = i + 1;
        const childT = (ee) => this.childTime(def, t, ee);
        for (; j < list.length && list[j].depth <= e.clip; j++) {
          const ee = list[j]; if (ee.clip) continue;
          this.draw(cc, ee.id, mulM(m, ee.m), mulCx(cx, ee.cx), childT(ee), ee.ratio, resolve);
        }
        const mk = new OffscreenCanvas(W, H); const mc = mk.getContext('2d');
        this.draw(mc, e.id, mulM(m, e.m), [0, 0, 0, 1, 0, 0, 0, 255], childT(e), e.ratio, resolve);
        cc.globalCompositeOperation = 'destination-in'; cc.setTransform(1, 0, 0, 1, 0, 0); cc.drawImage(mk, 0, 0);
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(content, 0, 0); ctx.restore();
        i = j - 1;
        continue;
      }
      const ct = this.childTime(def, t, e);
      this.draw(ctx, e.id, mulM(m, e.m), mulCx(cx, e.cx), ct, e.ratio, resolve);
    }
  }

  drawShape(ctx, def, m, cx) {
    for (const L of def.layers) {
      if (L.kind === 'fill') {
        const f = L.style; if (!f) continue;
        ctx.save();
        if (f.t === 's') {
          ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
          ctx.fillStyle = css(applyCx(f.c, cx)); ctx.fill(L.path, 'evenodd');
        } else if (f.t === 'lg' || f.t === 'rg') {
          const gm = f.m, inv = invM(gm);
          if (!inv) { ctx.restore(); continue; }
          const p2 = new Path2D(); p2.addPath(L.path, new DOMMatrix(inv));
          const tm = mulM(m, gm); ctx.setTransform(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]);
          const g = f.t === 'lg' ? ctx.createLinearGradient(-16384, 0, 16384, 0) : ctx.createRadialGradient(f.focal * 16384, 0, 0, 0, 0, 16384);
          for (const [r, c] of f.stops) g.addColorStop(r, css(applyCx(c, cx)));
          ctx.fillStyle = g; ctx.fill(p2, 'evenodd');
        } else if (f.t === 'b') {
          const bm = this.dict.get(f.id);
          if (bm && bm.img) {
            const inv = invM(f.m);
            if (inv) {
              const p2 = new Path2D(); p2.addPath(L.path, new DOMMatrix(inv));
              const tm = mulM(m, f.m); ctx.setTransform(tm[0], tm[1], tm[2], tm[3], tm[4], tm[5]);
              ctx.imageSmoothingEnabled = true;
              const pat = ctx.createPattern(bm.img, f.repeat ? 'repeat' : 'no-repeat');
              ctx.fillStyle = pat; ctx.globalAlpha = Math.max(0, Math.min(1, cx[3] + cx[7] / 255));
              if (cx[0] !== 1 || cx[4] || cx[1] !== 1 || cx[5]) {
                // approximate color transform on bitmap with a filter-free tint pass
                ctx.fill(p2, 'evenodd');
              } else ctx.fill(p2, 'evenodd');
            }
          }
        }
        ctx.restore();
      } else {
        const s = L.style; if (!s) continue;
        ctx.save(); ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
        const sc = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
        ctx.lineWidth = Math.max(s.w, 1 / (sc || 1)); // hairline: 1 device px
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = css(applyCx(s.c, cx)); ctx.stroke(L.path);
        ctx.restore();
      }
    }
  }
}

function fixJpeg(d) {
  // strip erroneous FFD9FFD8 at start, and inner EOI/SOI pairs
  let s = 0;
  if (d[0] === 0xff && d[1] === 0xd9 && d[2] === 0xff && d[3] === 0xd8) s = 4;
  if (s) { const n = new Uint8Array(d.length - s + 2); n[0] = 0xff; n[1] = 0xd8; n.set(d.subarray(s + 2 > d.length ? s : s), 2); d = n.subarray(0, d.length - s + 2); }
  // remove FFD9 FFD8 inside (tables+image concatenated)
  for (let i = 2; i < d.length - 3; i++) {
    if (d[i] === 0xff && d[i + 1] === 0xd9 && d[i + 2] === 0xff && d[i + 3] === 0xd8) {
      const n = new Uint8Array(d.length - 4); n.set(d.subarray(0, i)); n.set(d.subarray(i + 4), i); return n;
    }
    if (d[i] === 0xff && d[i + 1] === 0xda) break; // start of scan; stop looking
  }
  return d;
}

function compile(groups) {
  const layers = [];
  for (const g of groups) {
    const byFill = new Map();
    const add = (f, seg) => { if (!f) return; if (!byFill.has(f)) byFill.set(f, []); byFill.get(f).push(seg); };
    for (const e of g.edges) {
      add(e.f1, e);
      if (e.f0) add(e.f0, { x0: e.x1, y0: e.y1, cx: e.cx, cy: e.cy, x1: e.x0, y1: e.y0 });
    }
    for (const f of [...byFill.keys()].sort((a, b) => a - b)) {
      layers.push({ kind: 'fill', style: g.fills[f - 1], path: chain(byFill.get(f)) });
    }
    const byLine = new Map();
    for (const e of g.edges) if (e.ln) { if (!byLine.has(e.ln)) byLine.set(e.ln, []); byLine.get(e.ln).push(e); }
    for (const [l, segs] of byLine) {
      const p = new Path2D(); let lx = NaN, ly = NaN;
      for (const s of segs) {
        if (s.x0 !== lx || s.y0 !== ly) p.moveTo(s.x0, s.y0);
        if (s.cx !== undefined) p.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1); else p.lineTo(s.x1, s.y1);
        lx = s.x1; ly = s.y1;
      }
      layers.push({ kind: 'line', style: g.lines[l - 1], path: p });
    }
  }
  return layers;
}

function chain(segs) {
  const p = new Path2D();
  const key = (x, y) => x + ',' + y;
  const starts = new Map();
  segs.forEach((s, i) => { const k = key(s.x0, s.y0); if (!starts.has(k)) starts.set(k, []); starts.get(k).push(i); });
  const used = new Uint8Array(segs.length);
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    let s = segs[i]; used[i] = 1;
    const sx = s.x0, sy = s.y0;
    p.moveTo(sx, sy);
    for (;;) {
      if (s.cx !== undefined) p.quadraticCurveTo(s.cx, s.cy, s.x1, s.y1); else p.lineTo(s.x1, s.y1);
      if (s.x1 === sx && s.y1 === sy) break;
      const cand = starts.get(key(s.x1, s.y1));
      let nx = -1;
      if (cand) for (const c of cand) if (!used[c]) { nx = c; break; }
      if (nx < 0) break;
      used[nx] = 1; s = segs[nx];
    }
    p.closePath();
  }
  return p;
}
