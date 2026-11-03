// Spell effects played the way the 1.29 client plays them: the spell SWF's own ActionScript places and moves
// its pieces. tools/swf/fxanim.cjs exports, per spell sprite, the clips that run a script (their timeline and raw
// AS1 bytecode) and pre-renders everything static into "bands" (assets/fx/anim/<sprite>.json + atlas pages).
// Here a small AS1 interpreter runs those scripts on a tree of clips, and VisualEffectHandler.onLoadInit
// (ank.battlefield, modules/core.swf) is ported as it is: it sets angle / level / params / cellFrom / cellTo
// and, for display types 20-41, places the "rotate", "move", "shoot" and "duplicate" clips itself.
import { image, json } from './assets.js';

const FPS = 60;              // the client runs with dofus.Constants.DOUBLEFRAMERATE (sprites authored at 60 fps)
const MAX_FRAMES = 8 * FPS;  // safety net: no effect lives longer than this
const TL = -16384;           // timeline instances live below the depths used by attachMovie (Flash)

let INDEX = null;
const indexReady = json('/assets/fx/anim/index.json').then((m) => { INDEX = m || {}; });
const metas = new Map();

export function hasFx(sprite) { return !!(INDEX && INDEX[sprite]); }
export const fxReady = indexReady;

// Loads the meta and the atlas pages of one spell sprite (null if it was not exported).
export function loadFx(sprite) {
  if (!metas.has(sprite)) {
    metas.set(sprite, indexReady.then(async () => {
      if (!INDEX[sprite]) return null;
      const meta = await json(`/assets/fx/anim/${sprite}.json`);
      if (!meta) return null;
      meta.img = await Promise.all(Array.from({ length: meta.pages }, (_, i) => image(`/assets/fx/anim/${sprite}-${i}.webp`)));
      meta.code = new Map();
      // does a script place the pieces itself from cellFrom / cellTo?
      const scripts = [];
      for (const c of Object.values(meta.clips)) for (const f of c.f || []) for (const o of f) { if (o.b) scripts.push(o.b); for (const e of o.ev || []) scripts.push(e.b); }
      meta.cells = scripts.some((b) => { const t = atob(b); return t.includes('cellTo') || t.includes('cellFrom'); });
      return meta;
    }));
  }
  return metas.get(sprite);
}

function bytes(meta, b64) {
  let u = meta.code.get(b64);
  if (!u) { const s = atob(b64); u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); meta.code.set(b64, u); }
  return u;
}

// ---------------------------------------------------------------- matrices
const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
const DEG = 180 / Math.PI;
const num = (v) => (typeof v === 'number' ? v : v === true ? 1 : v === false || v === null ? 0 : v === undefined ? NaN : Number(v));
// SWF 7: a non-empty string is true, NaN is false
const bool = (v) => (typeof v === 'string' ? v.length > 0 : typeof v === 'number' ? v !== 0 && !Number.isNaN(v) : !!v);

class VMFunction {
  constructor(o) { Object.assign(this, o); }
}

// ---------------------------------------------------------------- clips
class Clip {
  constructor(fx, charId, parent, key, name) {
    this.fx = fx; this.charId = charId; this.def = charId == null ? null : fx.meta.clips[charId] || null;
    this.parent = parent; this.key = key; this.name = name || '';
    this.children = new Map(); // key ("t<depth>" timeline, "s<depth>" script) -> clip
    this.m = [1, 0, 0, 1, 0, 0]; this.cx = null; this.alpha = 100; this.visible = true;
    this.vars = Object.create(null);
    this.frame = 1; this.playing = true; this.age = 0; this.bandT = 0;
    this.scripted = false; this.removed = false; this.events = []; this.sc = null;
  }
  get total() { return this.def ? this.def.t : 1; }
  z() { const d = Number(this.key.slice(1)); return this.key[0] === 't' ? TL + d : d; }

  // scale / rotation as Flash keeps them (the sign of a mirrored axis survives a read)
  decomp() {
    if (!this.sc) {
      const [a, b, c, d] = this.m;
      const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
      this.sc = { sx: a * d - b * c < 0 ? -sx : sx, sy, rot: Math.atan2(b, a) };
      if (this.sc.sx < 0) this.sc.rot = Math.atan2(-b, -a);
    }
    return this.sc;
  }
  compose() {
    const { sx, sy, rot } = this.sc;
    const c = Math.cos(rot), s = Math.sin(rot);
    this.m = [sx * c, sx * s, -sy * s, sy * c, this.m[4], this.m[5]];
  }
  get(p) {
    switch (p) {
      case '_x': return this.m[4];
      case '_y': return this.m[5];
      case '_xscale': return this.decomp().sx * 100;
      case '_yscale': return this.decomp().sy * 100;
      case '_rotation': return this.decomp().rot * DEG;
      case '_alpha': return this.alpha;
      case '_visible': return this.visible;
      case '_currentframe': return this.frame;
      case '_totalframes': case '_framesloaded': return this.total;
      case '_name': return this.name;
      case '_parent': return this.parent;
      case '_width': case '_height': { const b = this.def?.b?.[0]; return b ? (p === '_width' ? b.w : b.h) / 2 * Math.abs(this.decomp()[p === '_width' ? 'sx' : 'sy']) : 0; }
      case '_target': return '/' + this.name;
      case '_xmouse': case '_ymouse': return 0;
    }
    return undefined;
  }
  set(p, v) {
    v = num(v);
    if (Number.isNaN(v) && p !== '_visible') return; // Flash ignores NaN for display properties
    switch (p) {
      case '_x': this.m[4] = v; this.scripted = true; return;
      case '_y': this.m[5] = v; this.scripted = true; return;
      case '_xscale': this.decomp().sx = v / 100; this.compose(); this.scripted = true; return;
      case '_yscale': this.decomp().sy = v / 100; this.compose(); this.scripted = true; return;
      case '_rotation': { let r = v % 360; if (r > 180) r -= 360; if (r < -180) r += 360; this.decomp().rot = r / DEG; this.compose(); this.scripted = true; return; }
      case '_alpha': this.alpha = v; this.scripted = true; return;
      case '_visible': this.visible = bool(v); return;
    }
  }
  child(name) { for (const c of this.children.values()) if (c.name === name) return c; return undefined; }

  // ---- timeline
  applyOps(n, runActions) {
    const ops = this.def?.f?.[n - 1];
    if (!ops) return;
    for (const o of ops) {
      if (o.o === 'p') this.place(o);
      else if (o.o === 'm') { const c = this.children.get('t' + o.d); if (c && !c.scripted) { if (o.m) { c.m = o.m.slice(); c.sc = null; } if (o.cx) c.cx = o.cx; } }
      else if (o.o === 'r') this.removeChild('t' + o.d);
      else if (o.o === 'a' && runActions) this.fx.queue.push(() => this.fx.run(bytes(this.fx.meta, o.b), this));
    }
  }
  place(o) {
    this.removeChild('t' + o.d);
    const c = new Clip(this.fx, o.c, this, 't' + o.d, o.n);
    c.m = o.m.slice(); if (o.cx) c.cx = o.cx;
    c.events = (o.ev || []).map((e) => ({ f: e.f, code: bytes(this.fx.meta, e.b) }));
    this.children.set(c.key, c);
    c.init();
    return c;
  }
  // a new instance shows its first frame and runs its load event, then its first frame script
  init() {
    this.applyOps(1, false);
    for (const e of this.events) if (e.f & 0x1) this.fx.queue.push(() => this.fx.run(e.code, this));
    const ops = this.def?.f?.[0] || [];
    for (const o of ops) if (o.o === 'a') this.fx.queue.push(() => this.fx.run(bytes(this.fx.meta, o.b), this));
    this.fx.born.add(this);
  }
  removeChild(key) { const c = this.children.get(key); if (c) { c.removed = true; this.children.delete(key); } }
  remove() {
    if (this.parent) { for (const [k, c] of this.parent.children) if (c === this) this.parent.children.delete(k); }
    this.removed = true;
    if (this === this.fx.root || this === this.fx.container) this.fx.done = true;
  }

  label(v) { if (typeof v === 'number') return v; const n = Number(v); if (!Number.isNaN(n) && String(v).trim() !== '') return n; const l = this.def?.l?.[v]; return l == null ? null : l + 1; }
  goto(f, play) {
    f = this.label(f);
    this.playing = play;
    if (f == null || Number.isNaN(f)) return; // gotoAndPlay(NaN) leaves the playhead where it is
    f = Math.max(1, Math.min(this.total, Math.floor(f)));
    if (f === this.frame) return;
    if (f > this.frame) { for (let i = this.frame + 1; i < f; i++) this.applyOps(i, false); }
    else {
      // going back: rebuild the timeline instances from frame 1 (instances created by scripts stay)
      for (const k of [...this.children.keys()]) if (k[0] === 't') this.removeChild(k);
      for (let i = 1; i < f; i++) this.applyOps(i, false);
    }
    this.applyOps(f, true);
    this.frame = f;
    this.bandT = f - 1;
  }
  advance() {
    if (!this.playing || this.total <= 1) return;
    if (this.frame >= this.total) { this.goto(1, true); return; }
    this.frame++;
    this.applyOps(this.frame, true);
  }

  // ---- scripted children
  attach(exportName, name, depth, init) {
    const id = this.fx.meta.ex?.[exportName];
    if (id == null || !this.fx.meta.clips[id]) return undefined;
    const key = 's' + num(depth);
    this.removeChild(key);
    const c = new Clip(this.fx, id, this, key, String(name));
    this.children.set(key, c);
    if (init && typeof init === 'object') for (const [k, v] of Object.entries(init)) this.fx.setMember(c, k, v);
    c.init();
    return c;
  }
  duplicate(name, depth, init) {
    if (!this.parent) return undefined;
    const key = 's' + num(depth);
    this.parent.removeChild(key);
    const c = new Clip(this.fx, this.charId, this.parent, key, String(name));
    c.m = this.m.slice(); c.cx = this.cx; c.alpha = this.alpha; c.events = this.events;
    this.parent.children.set(key, c);
    if (init && typeof init === 'object') for (const [k, v] of Object.entries(init)) this.fx.setMember(c, k, v);
    c.init();
    return c;
  }
}

// ---------------------------------------------------------------- effect (one spell clip on the battlefield)
class Effect {
  constructor(meta) {
    this.meta = meta;
    this.queue = []; this.born = new Set();
    this.tick = 0; this.done = false; this.t0 = 0;
    this.ended = new Promise((res) => { this.endRes = res; });
    this.container = new Clip(this, null, null, 's0', 'container');
    this.global = makeGlobal(this);
    this.warned = new Set();
  }
  end() { if (this.endRes) { this.endRes(); this.endRes = null; } }
  flush() { let n = 0; while (this.queue.length && n++ < 5000) { const f = this.queue.shift(); try { f(); } catch (e) { this.warn('script error: ' + e.message); } } }
  warn(msg) { if (!this.warned.has(msg)) { this.warned.add(msg); console.debug('[fx]', this.sprite, msg); } }

  all() { const out = []; const walk = (c) => { out.push(c); for (const k of [...c.children.values()]) walk(k); }; if (this.root && !this.root.removed) walk(this.root); return out; }

  step() {
    this.tick++;
    const list = this.all();
    // 1. playheads move on and the timelines place / move / remove their instances (queues the frame scripts)
    this.born.clear();
    const scripts = this.queue; this.queue = [];
    for (const c of list) if (!c.removed) { c.age++; c.bandT++; c.advance(); }
    const frameScripts = this.queue; this.queue = scripts;
    // 2. enterFrame of the clips that were already there
    for (const c of list) {
      if (c.removed || this.born.has(c)) continue;
      for (const e of c.events) if (e.f & 0x2) this.queue.push(() => this.run(e.code, c));
      const f = c.vars.onEnterFrame;
      if (f) this.queue.push(() => this.call(f, c, []));
    }
    this.flush();
    // 3. frame scripts (and load events of the new instances)
    this.queue.push(...frameScripts);
    this.flush();
    if (this.tick > MAX_FRAMES) this.done = true;
    if (!this.done && this.tick > 2 && !this.live()) this.done = true;
  }

  // still something to show or to do: a band with frames left, a script running every frame, a playhead moving
  // (a clip faded out or hidden no longer counts, nor anything inside it)
  live() {
    const walk = (c, alpha) => {
      let a = alpha * (c.alpha / 100);
      if (c.cx) a = a * c.cx[3] + c.cx[7] / 255;
      if (!c.visible || a <= 0.003) return false;
      if ((c.vars.onEnterFrame || c.events.some((e) => e.f & 0x2)) && c.age < 3 * FPS) return true;
      if (c.playing && c.def?.x && c.frame < c.total && c.age < c.total) return true;
      for (const b of c.def?.b || []) if (c.bandT < b.n && c.age < MAX_FRAMES / 2) return true;
      for (const k of c.children.values()) if (walk(k, a)) return true;
      return false;
    };
    return !!this.root && !this.root.removed && walk(this.root, 1);
  }

  draw(ctx) {
    if (!this.root || this.root.removed) return;
    const pages = this.meta.img;
    const drawClip = (c, M, alpha) => {
      if (!c.visible) return;
      const m = mul(M, c.m);
      let a = alpha * (c.alpha / 100);
      if (c.cx) a = a * c.cx[3] + c.cx[7] / 255;
      if (a <= 0.003) return;
      const items = [];
      for (const b of c.def?.b || []) items.push({ z: TL + b.z, b });
      for (const k of c.children.values()) items.push({ z: k.z(), k });
      items.sort((p, q) => p.z - q.z);
      for (const it of items) {
        if (it.k) { drawClip(it.k, m, a); continue; }
        const b = it.b;
        // frame of the band: a clip that has no stop() loops (a scripted clip loops through its own playhead)
        let i = c.bandT;
        if (i >= b.t) i = b.s >= 0 ? b.t - 1 : c.def?.x ? b.t - 1 : i % b.t;
        if (i >= b.n) continue; // the empty frames at the end were not stored
        const img = pages[b.p]; if (!img) continue;
        ctx.save();
        ctx.globalAlpha = Math.min(1, a);
        ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
        ctx.drawImage(img, b.x + (i % b.c) * b.w, b.y + Math.floor(i / b.c) * b.h, b.w, b.h, -b.ox / 2, -b.oy / 2, b.w / 2, b.h / 2);
        ctx.restore();
      }
    };
    drawClip(this.root, [1, 0, 0, 1, 0, 0], 1);
  }

  // ---------------------------------------------------------------- AS1 interpreter
  resolvePath(path, ctx) {
    if (path === '' || path === undefined) return ctx.target;
    if (path instanceof Clip) return path;
    let p = String(path).replace(/:/g, '.').replace(/\//g, '.');
    let cur;
    if (p.startsWith('.')) { cur = this.root; p = p.slice(1); } else cur = ctx.target;
    for (const part of p.split('.').filter(Boolean)) {
      if (part === '..') cur = cur?.parent;
      else cur = part === 'this' ? cur : this.getMember(cur, part, ctx);
      if (cur == null) return undefined;
    }
    return cur;
  }
  getVar(name, ctx) {
    name = String(name);
    if (name.includes('.') || name.includes('/') || name.includes(':')) {
      const i = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'));
      const head = name.slice(0, i), tail = name.slice(i + 1);
      if (i < 0) return this.resolvePath(name, ctx);
      const o = this.resolvePath(head, ctx);
      return o == null ? undefined : this.getMember(o, tail, ctx);
    }
    for (let s = ctx.scope; s; s = s.up) if (Object.prototype.hasOwnProperty.call(s.v, name)) return s.v[name];
    for (const w of ctx.withs) { const v = this.getMember(w, name, ctx); if (v !== undefined) return v; }
    if (name === 'this') return ctx.self;
    if (name === '_root') return this.root;
    if (name === '_global') return this.global;
    const t = ctx.target;
    if (t) { const v = this.getMember(t, name, ctx); if (v !== undefined) return v; }
    return this.global[name];
  }
  setVar(name, v, ctx) {
    name = String(name);
    const i = Math.max(name.lastIndexOf('.'), name.lastIndexOf(':'));
    if (i > 0) { const o = this.resolvePath(name.slice(0, i), ctx); if (o != null) this.setMember(o, name.slice(i + 1), v); return; }
    for (let s = ctx.scope; s; s = s.up) if (Object.prototype.hasOwnProperty.call(s.v, name)) { s.v[name] = v; return; }
    if (ctx.target) this.setMember(ctx.target, name, v);
  }
  getMember(o, k, ctx) {
    if (o == null) return undefined;
    if (o instanceof Clip) {
      if (typeof k === 'string' && k[0] === '_') { const p = o.get(k); if (p !== undefined || k === '_parent') return p; }
      if (k in o.vars) return o.vars[k];
      const c = o.child(k); if (c) return c;
      const m = CLIP_METHODS[k];
      if (m) return m;
      if (k === 'this') return o;
      if (o === this.container) return undefined;
      return undefined;
    }
    if (typeof o === 'string') { if (k === 'length') return o.length; const f = String.prototype[k]; return typeof f === 'function' ? f.bind(o) : undefined; }
    if (Array.isArray(o) && k === 'length') return o.length;
    const v = o[k];
    if (typeof v === 'function' && !(v instanceof VMFunction) && !o.__native) return v.bind(o);
    return v;
  }
  setMember(o, k, v) {
    if (o == null) return;
    if (o instanceof Clip) {
      if (typeof k === 'string' && k[0] === '_' && o.get(k) !== undefined && k !== '_parent' && k !== '_name') { o.set(k, v); return; }
      if (k === '_name') { o.name = String(v); return; }
      o.vars[k] = v; return;
    }
    if (typeof o === 'object' || typeof o === 'function') o[k] = v;
  }
  call(f, self, args) {
    if (f instanceof VMFunction) return this.invoke(f, self, args);
    if (f && f.__clip) return self instanceof Clip ? f(this, self, args) : undefined;
    if (typeof f === 'function') { try { return f.call(self, ...args); } catch (e) { this.warn('native error ' + e.message); return undefined; } }
    return undefined;
  }
  invoke(f, self, args) {
    const scope = { v: Object.create(null), up: f.scope };
    const regs = [];
    if (f.v2) {
      let k = 1; const fl = f.flags;
      if (fl & 1) regs[k++] = self;
      if (fl & 4) regs[k++] = args;
      if (fl & 16) regs[k++] = undefined;
      if (fl & 64) regs[k++] = this.root;
      if (fl & 128) regs[k++] = (self instanceof Clip ? self : f.target)?.parent;
      if (fl & 256) regs[k++] = this.global;
      f.params.forEach(([r, n], i) => { if (r) regs[r] = args[i]; else scope.v[n] = args[i]; });
      if (!(fl & 2)) scope.v.this = self;
    } else {
      f.params.forEach((n, i) => { scope.v[n] = args[i]; });
      scope.v.this = self;
      scope.v.arguments = args;
    }
    const target = self instanceof Clip ? self : f.target;
    // the function body reads the constant pool of the script that defined it
    return this.exec(f.code, f.start, f.end, { target, self, scope, regs, withs: [], pool: f.pool });
  }
  run(code, clip) {
    if (!clip || clip.removed) return;
    this.exec(code, 0, code.length, { target: clip, self: clip, scope: null, regs: [], withs: [] });
  }

  exec(u8, start, end, ctx) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const st = [];
    const pop = () => st.pop();
    let pool = ctx.pool || [];
    let p = start, guard = 0;
    const str = (q) => { let e = q; while (u8[e]) e++; let s = ''; for (let i = q; i < e; i++) s += String.fromCharCode(u8[i]); return [s, e + 1]; };
    const popN = () => { const n = num(pop()) | 0; const a = []; for (let i = 0; i < n; i++) a.push(pop()); return a; };
    while (p < end) {
      if (++guard > 200000) { this.warn('script too long'); return undefined; }
      const op = u8[p++];
      if (op === 0) break;
      let len = 0;
      if (op >= 0x80) { len = dv.getUint16(p, true); p += 2; }
      const b = p; p += len;
      switch (op) {
        case 0x04: ctx.target?.goto(ctx.target.frame + 1, false); break;
        case 0x05: ctx.target?.goto(ctx.target.frame - 1, false); break;
        case 0x06: if (ctx.target) ctx.target.playing = true; break;
        case 0x07: if (ctx.target) ctx.target.playing = false; break;
        case 0x08: case 0x09: break;
        case 0x0A: { const y = pop(), x = pop(); st.push(num(x) + num(y)); break; }
        case 0x0B: { const y = pop(), x = pop(); st.push(num(x) - num(y)); break; }
        case 0x0C: { const y = pop(), x = pop(); st.push(num(x) * num(y)); break; }
        case 0x0D: { const y = pop(), x = pop(); st.push(num(x) / num(y)); break; }
        case 0x0E: { const y = pop(), x = pop(); st.push(num(x) === num(y)); break; }
        case 0x0F: { const y = pop(), x = pop(); st.push(num(x) < num(y)); break; }
        case 0x10: { const y = pop(), x = pop(); st.push(bool(x) && bool(y)); break; }
        case 0x11: { const y = pop(), x = pop(); st.push(bool(x) || bool(y)); break; }
        case 0x12: st.push(!bool(pop())); break;
        case 0x13: { const y = pop(), x = pop(); st.push(String(x) === String(y)); break; }
        case 0x14: case 0x31: st.push(String(pop()).length); break;
        case 0x15: case 0x35: { const n = num(pop()), i = num(pop()), s = String(pop()); st.push(s.substr(i - 1, n)); break; }
        case 0x17: pop(); break;
        case 0x18: st.push(Math.trunc(num(pop())) || 0); break;
        case 0x1C: st.push(this.getVar(pop(), ctx)); break;
        case 0x1D: { const v = pop(), n = pop(); this.setVar(n, v, ctx); break; }
        case 0x20: { const t = pop(); ctx.target = t === '' ? ctx.self : (this.resolvePath(t, ctx) || ctx.target); break; }
        case 0x21: { const y = pop(), x = pop(); st.push(String(x) + String(y)); break; }
        case 0x22: { const i = num(pop()), t = this.resolvePath(pop(), ctx); st.push(t instanceof Clip ? t.get(PROPS[i]) : undefined); break; }
        case 0x23: { const v = pop(), i = num(pop()), t = this.resolvePath(pop(), ctx); if (t instanceof Clip) t.set(PROPS[i], v); break; }
        case 0x24: { const d = num(pop()), n = pop(), t = this.resolvePath(pop(), ctx); if (t instanceof Clip) t.duplicate(n, d + 16384 >= 0 ? d + 16384 : d); break; }
        case 0x25: { const t = this.resolvePath(pop(), ctx); if (t instanceof Clip) t.remove(); break; }
        case 0x26: pop(); break;
        case 0x27: pop(); pop(); if (bool(pop())) { pop(); pop(); pop(); pop(); } break;
        case 0x28: break;
        case 0x29: { const y = pop(), x = pop(); st.push(String(x) < String(y)); break; }
        case 0x30: { const n = num(pop()); st.push(Math.floor(Math.random() * n) || 0); break; }
        case 0x32: case 0x36: st.push(String(pop()).charCodeAt(0) || 0); break;
        case 0x33: case 0x37: st.push(String.fromCharCode(num(pop()))); break;
        case 0x34: st.push(Math.round(this.tick * 1000 / FPS)); break;
        case 0x3A: { const k = pop(), o = pop(); if (o instanceof Clip) delete o.vars[k]; else if (o && typeof o === 'object') delete o[k]; st.push(true); break; }
        case 0x3B: { const n = pop(); for (let s = ctx.scope; s; s = s.up) if (n in s.v) delete s.v[n]; if (ctx.target) delete ctx.target.vars[n]; st.push(true); break; }
        case 0x3C: { const v = pop(), n = pop(); if (ctx.scope) ctx.scope.v[n] = v; else this.setVar(n, v, ctx); break; }
        case 0x41: { const n = pop(); if (ctx.scope) { if (!(n in ctx.scope.v)) ctx.scope.v[n] = undefined; } break; }
        case 0x3D: { const n = pop(); const a = popN(); const f = this.getVar(n, ctx); st.push(this.call(f, ctx.self, a)); break; }
        case 0x3E: return pop();
        case 0x3F: { const y = pop(), x = pop(); st.push(num(x) % num(y)); break; }
        case 0x40: { const n = String(pop()); const a = popN(); const C = this.global[n]; st.push(C && C.__ctor ? C.__ctor(...a) : n === 'Array' ? (a.length === 1 ? new Array(num(a[0])) : a) : {}); break; }
        case 0x42: st.push(popN()); break;
        case 0x43: { const n = num(pop()) | 0; const o = {}; for (let i = 0; i < n; i++) { const v = pop(), k = pop(); o[k] = v; } st.push(o); break; }
        case 0x44: { const v = pop(); st.push(v instanceof Clip ? 'movieclip' : v instanceof VMFunction ? 'function' : v === null ? 'null' : typeof v); break; }
        case 0x45: { const v = pop(); st.push(v instanceof Clip ? '/' + v.name : undefined); break; }
        case 0x46: { const n = pop(); const o = typeof n === 'string' ? this.getVar(n, ctx) : n; st.push(null); if (o instanceof Clip) { for (const k of Object.keys(o.vars)) st.push(k); } else if (o && typeof o === 'object') for (const k of Object.keys(o)) st.push(k); break; }
        case 0x55: { const o = pop(); st.push(null); if (o instanceof Clip) { for (const k of Object.keys(o.vars)) st.push(k); } else if (o && typeof o === 'object') for (const k of Object.keys(o)) st.push(k); break; }
        case 0x47: { const y = pop(), x = pop(); st.push(typeof x === 'string' || typeof y === 'string' ? String(x) + String(y) : num(x) + num(y)); break; }
        case 0x48: { const y = pop(), x = pop(); st.push(typeof x === 'string' && typeof y === 'string' ? x < y : num(x) < num(y)); break; }
        case 0x49: { const y = pop(), x = pop(); st.push(x == y); break; } // eslint-disable-line eqeqeq
        case 0x4A: st.push(num(pop())); break;
        case 0x4B: st.push(String(pop())); break;
        case 0x4C: st.push(st[st.length - 1]); break;
        case 0x4D: { const y = pop(), x = pop(); st.push(y, x); break; }
        case 0x4E: { const k = pop(), o = pop(); st.push(this.getMember(o, k, ctx)); break; }
        case 0x4F: { const v = pop(), k = pop(), o = pop(); this.setMember(o, k, v); break; }
        case 0x50: st.push(num(pop()) + 1); break;
        case 0x51: st.push(num(pop()) - 1); break;
        case 0x52: {
          const k = pop(), o = pop(); const a = popN();
          if (k === undefined || k === null || k === '') { st.push(this.call(o, ctx.self, a)); break; }
          const f = this.getMember(o, k, ctx);
          if (f && f.__clip) st.push(o instanceof Clip ? f(this, o, a, ctx) : undefined);
          else st.push(this.call(f, o, a));
          break;
        }
        case 0x53: { pop(); pop(); popN(); st.push({}); break; }
        case 0x54: { pop(); pop(); st.push(false); break; }
        case 0x60: { const y = pop(), x = pop(); st.push(num(x) & num(y)); break; }
        case 0x61: { const y = pop(), x = pop(); st.push(num(x) | num(y)); break; }
        case 0x62: { const y = pop(), x = pop(); st.push(num(x) ^ num(y)); break; }
        case 0x63: { const y = pop(), x = pop(); st.push(num(x) << num(y)); break; }
        case 0x64: { const y = pop(), x = pop(); st.push(num(x) >> num(y)); break; }
        case 0x65: { const y = pop(), x = pop(); st.push(num(x) >>> num(y)); break; }
        case 0x66: { const y = pop(), x = pop(); st.push(x === y); break; }
        case 0x67: { const y = pop(), x = pop(); st.push(typeof x === 'string' && typeof y === 'string' ? x > y : num(x) > num(y)); break; }
        case 0x68: { const y = pop(), x = pop(); st.push(String(x) > String(y)); break; }
        case 0x69: case 0x2B: case 0x2C: pop(); pop(); if (op !== 0x69) st.push(undefined); break;
        case 0x81: ctx.target?.goto(dv.getUint16(b, true) + 1, false); break;
        case 0x83: break;
        case 0x87: ctx.regs[u8[b]] = st[st.length - 1]; break;
        case 0x88: { const n = dv.getUint16(b, true); let q = b + 2; pool = []; for (let i = 0; i < n; i++) { const [s, nq] = str(q); pool.push(s); q = nq; } ctx.pool = pool; break; }
        case 0x8A: case 0x8D: break;
        case 0x8B: { const [t] = str(b); ctx.target = t === '' ? ctx.self : (this.resolvePath(t, ctx) || ctx.target); break; }
        case 0x8C: { const [l] = str(b); ctx.target?.goto(l, false); break; }
        case 0x9F: { const f = pop(); ctx.target?.goto(f, !!(u8[b] & 1)); break; }
        case 0x9A: pop(); pop(); break;
        case 0x96: {
          let q = b;
          while (q < b + len) {
            const t = u8[q++];
            if (t === 0) { const [s, nq] = str(q); st.push(s); q = nq; }
            else if (t === 1) { st.push(dv.getFloat32(q, true)); q += 4; }
            else if (t === 2) st.push(null);
            else if (t === 3) st.push(undefined);
            else if (t === 4) st.push(ctx.regs[u8[q++]]);
            else if (t === 5) st.push(!!u8[q++]);
            else if (t === 6) { const hi = dv.getUint32(q, true), lo = dv.getUint32(q + 4, true); const tmp = new DataView(new ArrayBuffer(8)); tmp.setUint32(0, lo, true); tmp.setUint32(4, hi, true); st.push(tmp.getFloat64(0, true)); q += 8; }
            else if (t === 7) { st.push(dv.getInt32(q, true)); q += 4; }
            else if (t === 8) st.push(pool[u8[q++]]);
            else if (t === 9) { st.push(pool[dv.getUint16(q, true)]); q += 2; }
            else break;
          }
          break;
        }
        case 0x99: p = p + dv.getInt16(b, true); break;
        case 0x9D: { const c = pop(); if (bool(c)) p = p + dv.getInt16(b, true); break; }
        case 0x9B: case 0x8E: {
          let [name, q] = str(b);
          const np = dv.getUint16(q, true); q += 2;
          const params = []; let flags = 0;
          if (op === 0x8E) {
            q++; flags = dv.getUint16(q, true); q += 2;
            for (let i = 0; i < np; i++) { const r = u8[q++]; const [n, nq] = str(q); params.push([r, n]); q = nq; }
          } else for (let i = 0; i < np; i++) { const [n, nq] = str(q); params.push(n); q = nq; }
          const size = dv.getUint16(q, true); q += 2;
          const f = new VMFunction({ code: u8, start: q, end: q + size, params, flags, v2: op === 0x8E, scope: ctx.scope, target: ctx.target, pool });
          p = q + size;
          if (name) this.setVar(name, f, ctx); else st.push(f);
          break;
        }
        case 0x94: {
          const size = dv.getUint16(b, true); const o = pop();
          ctx.withs.unshift(o instanceof Clip ? o : o);
          this.exec(u8, p, p + size, ctx);
          ctx.withs.shift();
          p += size;
          break;
        }
        case 0x8F: return undefined; // try/catch: not used by the spell clips
        case 0x9E: pop(); break;
        default: this.warn('opcode 0x' + op.toString(16));
      }
    }
    return undefined;
  }
}

const PROPS = ['_x', '_y', '_xscale', '_yscale', '_currentframe', '_totalframes', '_alpha', '_visible', '_width', '_height', '_rotation', '_target', '_framesloaded', '_name', '_droptarget', '_url', '_highquality', '_focusrect', '_soundbuftime', '_quality', '_xmouse', '_ymouse'];

// MovieClip methods: (effect, clip, args, ctx) -> value
const clipMethod = (f) => { f.__clip = true; return f; };
const CLIP_METHODS = {
  play: clipMethod((fx, c) => { c.playing = true; }),
  stop: clipMethod((fx, c) => { c.playing = false; }),
  gotoAndPlay: clipMethod((fx, c, a) => c.goto(a[0], true)),
  gotoAndStop: clipMethod((fx, c, a) => c.goto(a[0], false)),
  nextFrame: clipMethod((fx, c) => c.goto(c.frame + 1, false)),
  prevFrame: clipMethod((fx, c) => c.goto(c.frame - 1, false)),
  attachMovie: clipMethod((fx, c, a) => c.attach(a[0], a[1], a[2], a[3])),
  duplicateMovieClip: clipMethod((fx, c, a) => c.duplicate(a[0], a[1], a[2])),
  createEmptyMovieClip: clipMethod((fx, c, a) => { const k = new Clip(fx, null, c, 's' + num(a[1]), String(a[0])); c.removeChild(k.key); c.children.set(k.key, k); return k; }),
  removeMovieClip: clipMethod((fx, c) => c.remove()),
  swapDepths: clipMethod((fx, c, a) => {
    if (!c.parent) return;
    const key = a[0] instanceof Clip ? a[0].key : 's' + num(a[0]);
    const other = c.parent.children.get(key);
    c.parent.children.delete(c.key);
    if (other) { other.key = c.key; c.parent.children.set(other.key, other); }
    c.key = key; c.parent.children.set(key, c);
  }),
  getDepth: clipMethod((fx, c) => c.z()),
  getNextHighestDepth: clipMethod((fx, c) => { let d = 0; for (const k of c.children.values()) d = Math.max(d, k.z() + 1); return d; }),
  getBounds: clipMethod((fx, c) => { const b = c.def?.b?.[0]; return b ? { xMin: -b.ox / 2, yMin: -b.oy / 2, xMax: (b.w - b.ox) / 2, yMax: (b.h - b.oy) / 2 } : { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }; }),
  localToGlobal: clipMethod((fx, c, a) => { const pt = a[0]; if (!pt) return; let m = [1, 0, 0, 1, 0, 0]; for (let k = c; k; k = k.parent) m = mul(k.m, m); const x = num(pt.x), y = num(pt.y); pt.x = m[0] * x + m[2] * y + m[4]; pt.y = m[1] * x + m[3] * y + m[5]; }),
  globalToLocal: clipMethod((fx, c, a) => { const pt = a[0]; if (!pt) return; let m = [1, 0, 0, 1, 0, 0]; for (let k = c; k; k = k.parent) m = mul(k.m, m); const det = m[0] * m[3] - m[1] * m[2] || 1; const x = num(pt.x) - m[4], y = num(pt.y) - m[5]; pt.x = (m[3] * x - m[2] * y) / det; pt.y = (-m[1] * x + m[0] * y) / det; }),
  hitTest: clipMethod(() => false),
  setMask: clipMethod(() => undefined),
  // the client's hook: the effect reached the moment the action goes on (damage, next effect...)
  end: clipMethod((fx) => fx.end()),
};

function makeGlobal(fx) {
  const M = { __native: true };
  for (const k of Object.getOwnPropertyNames(Math)) M[k] = Math[k];
  return {
    Math: M,
    Number: Object.assign((v) => num(v), { __native: true }),
    String: Object.assign((v) => String(v), { __native: true }),
    parseInt: (v, r) => parseInt(v, r), parseFloat: (v) => parseFloat(v), isNaN: (v) => Number.isNaN(num(v)), isFinite: (v) => Number.isFinite(num(v)),
    int: (v) => Math.trunc(num(v)) || 0,
    random: (n) => Math.floor(Math.random() * num(n)),
    getTimer: () => Math.round(fx.tick * 1000 / FPS),
    trace: () => undefined,
    setInterval: () => 0, clearInterval: () => undefined,
    Object: { __ctor: () => ({}) }, Array: { __ctor: (...a) => (a.length === 1 ? new Array(num(a[0])) : a) },
    Color: { __ctor: () => ({ setRGB() {}, setTransform() {}, getTransform() { return {}; } }) },
    // sounds come from tools/audio.py (played by the fight screen)
    SOMA: { __native: true, playSound: () => undefined },
    dofus: { Constants: { DOUBLEFRAMERATE: true } },
  };
}

// ---------------------------------------------------------------- VisualEffectHandler.onLoadInit
// from / to: caster and target positions in map coordinates (the sprite's position, else the cell's).
export async function playFx(sprite, { type, from, to, level = 1, params } = {}) {
  const meta = await loadFx(sprite);
  if (!meta || !meta.clips[0]) return null;
  // display type 0 is not handled by onLoadInit (the clip would stay in the corner of the map): played on the
  // target, or with cellFrom / cellTo when its scripts place it themselves
  if (!type) type = meta.cells ? 51 : 11;
  const fx = new Effect(meta);
  fx.sprite = sprite;
  const cont = fx.container;
  Object.assign(cont.vars, { displayType: type, level, params });
  const root = new Clip(fx, 0, cont, 's1', 'spell');
  cont.children.set(root.key, root);
  fx.root = root;
  // the loaded clip has run its first frame when onLoadInit is called
  root.init();
  fx.flush();
  const angle = Math.atan2(to.y - from.y, to.x - from.x) * DEG;
  Object.assign(root.vars, { level, angle, params, _ACTION: { x: from.x, y: from.y } });
  const set = (k, v) => root.set(k, v);
  switch (type) {
    case 10: case 12: set('_x', from.x); set('_y', from.y); break;
    case 11: set('_x', to.x); set('_y', to.y); break;
    case 20: case 21: {
      set('_x', from.x); set('_y', from.y);
      const rot = root.child('rotate'); if (rot) rot.set('_rotation', angle);
      const sh = root.attach('shoot', 'shoot', 10); if (sh) { sh.set('_x', to.x - from.x); sh.set('_y', to.y - from.y); }
      break;
    }
    case 30: case 31: case 33: {
      set('_x', from.x); set('_y', from.y - 10);
      const k = type === 31 || type === 33 ? 0.9 : 0.5;
      const speed = (type === 31 || type === 33 ? 0.5 : 0.675) / 3;
      const dx = to.x - from.x, dy = to.y - from.y;
      const start = (Math.atan2(dy, Math.abs(dx)) + Math.PI / 2) * k - Math.PI / 2;
      const xDest = Math.abs(dx); let yDest = dy;
      root.vars.startangle = start;
      if (!(dx > 0)) { if (dx === 0 && dy < 0) { set('_yscale', -root.get('_yscale')); yDest = -yDest; } set('_xscale', -root.get('_xscale')); }
      root.attach('move', 'move', 2);
      const g = 9.81, hg = g / 2;
      let t = 0;
      const vx = Math.sqrt(Math.abs(hg * xDest * xDest / Math.abs(yDest - Math.tan(start) * xDest)));
      const vy = Math.tan(start) * vx;
      root.vars.onEnterFrame = function () {
        const vyi = vy + g * t, x = t * vx, y = hg * t * t + vy * t;
        t += speed;
        const r = Math.atan(vyi / vx) * DEG;
        if ((Math.abs(y) >= Math.abs(yDest) && x >= xDest) || x > xDest) {
          const s = root.attach('shoot', 'shoot', 2);
          if (s) { s.set('_x', xDest); s.set('_y', yDest); s.set('_rotation', r); }
          fx.end();
          delete root.vars.onEnterFrame;
        } else {
          const mv = root.child('move');
          if (mv) { mv.set('_x', x); mv.set('_y', y); mv.set('_rotation', r); }
        }
      };
      break;
    }
    case 40: case 41: {
      set('_x', from.x); set('_y', from.y);
      const step = 20 / 3;
      const rot = Math.atan2(to.y - from.y, to.x - from.x);
      const full = Math.hypot(to.x - from.x, to.y - from.y);
      const interval = full / Math.max(1, Math.floor(full / step));
      let dist = 0, inc = 1, state = 0;
      root.vars.onEnterFrame = function () {
        dist += interval;
        if (state === 0) {
          if (dist > full) {
            fx.end();
            if (type === 41) { const s = root.attach('shoot', 'shoot', 10); if (s) { s.set('_x', to.x - from.x); s.set('_y', to.y - from.y); } }
            delete root.vars.onEnterFrame;
          } else {
            const d = root.attach('duplicate', 'duplicate' + inc, inc);
            if (d) { d.set('_x', dist * Math.cos(rot)); d.set('_y', dist * Math.sin(rot)); }
            inc++;
          }
          state = 2;
        } else state--;
      };
      break;
    }
    case 50: case 51: root.vars.cellFrom = { x: from.x, y: from.y }; root.vars.cellTo = { x: to.x, y: to.y }; break;
  }
  fx.flush();
  return fx;
}

// Runs the effects until now (60 fps, catching up at most a few frames per call).
export function stepFx(list, now) {
  for (const fx of list) {
    if (!fx.t0) fx.t0 = now;
    const want = Math.floor((now - fx.t0) / 1000 * FPS);
    let n = 0;
    while (!fx.done && fx.tick < want && n++ < 6) fx.step();
    if (fx.tick < want - 6) fx.t0 = now - fx.tick * 1000 / FPS;
  }
  return list.filter((fx) => !fx.done);
}
