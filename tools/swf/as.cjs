// Dumps the ActionScript (AS1/AS2 bytecode) of a SWF as readable pseudo-code, with the timeline it lives in.
//   node as.cjs <file.swf> [--json]
// Covers DoAction (frame scripts), DoInitAction and PlaceObject2/3 clip events (onClipEvent), in the root and
// in every DefineSprite. Used to see what the spell effect scripts do with cellFrom / cellTo / angle / level.
const fs = require('fs');
const zlib = require('zlib');

class Bits {
  constructor(u8, pos = 0) { this.u8 = u8; this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength); this.pos = pos; this.bit = 0; this.cur = 0; }
  align() { this.bit = 0; }
  u8_() { this.align(); return this.u8[this.pos++]; }
  u16() { this.align(); const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  s16() { this.align(); const v = this.dv.getInt16(this.pos, true); this.pos += 2; return v; }
  u32() { this.align(); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  ub(n) { let v = 0; while (n > 0) { if (this.bit === 0) { this.cur = this.u8[this.pos++]; this.bit = 8; } const t = Math.min(n, this.bit); v = v * (1 << t) + ((this.cur >> (this.bit - t)) & ((1 << t) - 1)); this.bit -= t; n -= t; } return v; }
  sb(n) { if (!n) return 0; const v = this.ub(n); return v >= 2 ** (n - 1) ? v - 2 ** n : v; }
  fb(n) { return this.sb(n) / 65536; }
  str() { this.align(); let e = this.pos; while (this.u8[e]) e++; const s = Buffer.from(this.u8.subarray(this.pos, e)).toString('latin1'); this.pos = e + 1; return s; }
  rect() { this.align(); const n = this.ub(5); this.sb(n); this.sb(n); this.sb(n); this.sb(n); this.align(); }
  matrix() {
    this.align(); const m = [1, 0, 0, 1, 0, 0];
    if (this.ub(1)) { const n = this.ub(5); m[0] = this.fb(n); m[3] = this.fb(n); }
    if (this.ub(1)) { const n = this.ub(5); m[1] = this.fb(n); m[2] = this.fb(n); }
    const n = this.ub(5); m[4] = this.sb(n) / 20; m[5] = this.sb(n) / 20; this.align(); return m;
  }
  // [rMul, gMul, bMul, aMul, rAdd, gAdd, bAdd, aAdd]
  cxform(alpha) {
    this.align(); const a = this.ub(1), mu = this.ub(1), n = this.ub(4); const c = [1, 1, 1, 1, 0, 0, 0, 0];
    if (mu) { for (let i = 0; i < 3; i++) c[i] = this.sb(n) / 256; if (alpha) c[3] = this.sb(n) / 256; }
    if (a) { for (let i = 0; i < 3; i++) c[4 + i] = this.sb(n); if (alpha) c[7] = this.sb(n); }
    this.align(); return c;
  }
}

const PROPS = ['_x', '_y', '_xscale', '_yscale', '_currentframe', '_totalframes', '_alpha', '_visible', '_width', '_height', '_rotation', '_target', '_framesloaded', '_name', '_droptarget', '_url', '_highquality', '_focusrect', '_soundbuftime', '_quality', '_xmouse', '_ymouse'];
const BIN = { 0x0A: '+', 0x0B: '-', 0x0C: '*', 0x0D: '/', 0x0E: '==', 0x0F: '<', 0x10: '&&', 0x11: '||', 0x13: 'eq', 0x21: 'add', 0x29: 'lt', 0x3F: '%', 0x47: '+', 0x48: '<', 0x49: '==', 0x60: '&', 0x61: '|', 0x62: '^', 0x63: '<<', 0x64: '>>', 0x65: '>>>', 0x66: '===', 0x67: '>', 0x68: 'gt', 0x54: 'instanceof' };
const EVENTS = { 0x1: 'load', 0x2: 'enterFrame', 0x4: 'unload', 0x8: 'mouseMove', 0x10: 'mouseDown', 0x20: 'mouseUp', 0x40: 'keyDown', 0x80: 'keyUp', 0x100: 'data', 0x200: 'initialize', 0x400: 'press', 0x800: 'release', 0x1000: 'releaseOutside', 0x2000: 'rollOver', 0x4000: 'rollOut', 0x8000: 'dragOver', 0x10000: 'dragOut', 0x20000: 'keyPress', 0x40000: 'construct' };

const lit = (v) => typeof v === 'string' ? JSON.stringify(v) : String(v);
const isIdent = (s) => /^[A-Za-z_$][\w$]*$/.test(s);
const member = (o, k) => (k.lit && typeof k.v === 'string' && isIdent(k.v) ? `${o.s}.${k.v}` : `${o.s}[${k.s}]`);

// Decompiles one action block into lines (stack machine -> expressions; branches become `if (...) goto Lx`).
function decompile(u8, start, end, pool, regNames = {}, indent = '') {
  const out = [];
  const st = [];
  const E = (s, extra = {}) => ({ s, ...extra });
  const pop = () => st.pop() || E('undefined');
  const labels = new Map();
  const reg = (n) => regNames[n] || `r${n}`;
  // first pass: branch targets
  const ops = [];
  for (let p = start; p < end;) {
    const op = u8[p]; const at = p; p++;
    if (op === 0) { ops.push({ at, op, len: 0, p }); break; }
    let len = 0; if (op >= 0x80) { len = u8[p] | (u8[p + 1] << 8); p += 2; }
    ops.push({ at, op, body: p, len, next: p + len });
    p += len;
    if (op === 0x99 || op === 0x9D) { const off = new DataView(u8.buffer, u8.byteOffset).getInt16(at + 3, true); { const tg = at + 5 + off; if (!labels.has(tg)) labels.set(tg, 'L' + (labels.size + 1)); } }
  }
  const dv = new DataView(u8.buffer, u8.byteOffset);
  let skipTo = -1;
  for (const o of ops) {
    if (o.at < skipTo) continue;
    if (labels.has(o.at)) { if (st.length) { out.push(indent + `// stack: ${st.map(x => x.s).join(', ')}`); st.length = 0; } out.push(indent.slice(2) + labels.get(o.at) + ':'); }
    const { op } = o;
    const b = o.body;
    switch (op) {
      case 0: break;
      case 0x04: out.push(indent + 'nextFrame();'); break;
      case 0x05: out.push(indent + 'prevFrame();'); break;
      case 0x06: out.push(indent + 'play();'); break;
      case 0x07: out.push(indent + 'stop();'); break;
      case 0x09: out.push(indent + 'stopAllSounds();'); break;
      case 0x12: { const a = pop(); st.push(E(`!(${a.s})`)); break; }
      case 0x14: case 0x31: st.push(E(`length(${pop().s})`)); break;
      case 0x17: { const a = pop(); if (a.call) out.push(indent + a.s + ';'); break; }
      case 0x18: st.push(E(`int(${pop().s})`)); break;
      case 0x1C: { const n = pop(); st.push(E(n.lit && typeof n.v === 'string' ? n.v : `eval(${n.s})`)); break; }
      case 0x1D: { const v = pop(), n = pop(); out.push(indent + `${n.lit ? n.v : `set(${n.s})`} = ${v.s};`); break; }
      case 0x20: out.push(indent + `tellTarget(${pop().s});`); break;
      case 0x22: { const i = pop(), t = pop(); st.push(E(`getProperty(${t.s}, ${PROPS[i.v] || i.s})`)); break; }
      case 0x23: { const v = pop(), i = pop(), t = pop(); out.push(indent + `setProperty(${t.s}, ${PROPS[i.v] || i.s}, ${v.s});`); break; }
      case 0x24: { const d = pop(), t = pop(), s = pop(); out.push(indent + `duplicateMovieClip(${s.s}, ${t.s}, ${d.s});`); break; }
      case 0x25: out.push(indent + `removeMovieClip(${pop().s});`); break;
      case 0x26: out.push(indent + `trace(${pop().s});`); break;
      case 0x30: st.push(E(`random(${pop().s})`)); break;
      case 0x34: st.push(E('getTimer()')); break;
      case 0x3A: { const k = pop(), ob = pop(); st.push(E(`delete ${member(ob, k)}`, { call: true })); break; }
      case 0x3B: st.push(E(`delete ${pop().s}`, { call: true })); break;
      case 0x3C: { const v = pop(), n = pop(); out.push(indent + `var ${n.lit ? n.v : n.s} = ${v.s};`); break; }
      case 0x41: { const n = pop(); out.push(indent + `var ${n.lit ? n.v : n.s};`); break; }
      case 0x3D: { const n = pop(), c = pop(); const a = []; for (let i = 0; i < (c.v | 0); i++) a.push(pop().s); st.push(E(`${n.lit ? n.v : n.s}(${a.join(', ')})`, { call: true })); break; }
      case 0x3E: out.push(indent + `return ${pop().s};`); break;
      case 0x40: { const n = pop(), c = pop(); const a = []; for (let i = 0; i < (c.v | 0); i++) a.push(pop().s); st.push(E(`new ${n.lit ? n.v : n.s}(${a.join(', ')})`, { call: true })); break; }
      case 0x42: { const c = pop(); const a = []; for (let i = 0; i < (c.v | 0); i++) a.push(pop().s); st.push(E(`[${a.join(', ')}]`)); break; }
      case 0x43: { const c = pop(); const a = []; for (let i = 0; i < (c.v | 0); i++) { const v = pop(), k = pop(); a.push(`${k.lit ? k.v : k.s}: ${v.s}`); } st.push(E(`{${a.join(', ')}}`)); break; }
      case 0x44: st.push(E(`typeof ${pop().s}`)); break;
      case 0x45: st.push(E(`targetPath(${pop().s})`)); break;
      case 0x46: case 0x55: { const a = pop(); st.push(E(`enumerate(${a.s})`)); break; }
      case 0x4A: st.push(E(`Number(${pop().s})`)); break;
      case 0x4B: st.push(E(`String(${pop().s})`)); break;
      case 0x4C: { const a = st[st.length - 1] || E('undefined'); st.push(a); break; }
      case 0x4D: { const a = pop(), c = pop(); st.push(a, c); break; }
      case 0x4E: { const k = pop(), ob = pop(); st.push(E(member(ob, k))); break; }
      case 0x4F: { const v = pop(), k = pop(), ob = pop(); out.push(indent + `${member(ob, k)} = ${v.s};`); break; }
      case 0x50: st.push(E(`(${pop().s} + 1)`)); break;
      case 0x51: st.push(E(`(${pop().s} - 1)`)); break;
      case 0x52: { const k = pop(), ob = pop(), c = pop(); const a = []; for (let i = 0; i < (c.v | 0); i++) a.push(pop().s); const f = k.lit && k.v === '' || k.s === 'undefined' ? ob.s : member(ob, k); st.push(E(`${f}(${a.join(', ')})`, { call: true })); break; }
      case 0x53: { const k = pop(), ob = pop(), c = pop(); const a = []; for (let i = 0; i < (c.v | 0); i++) a.push(pop().s); st.push(E(`new ${member(ob, k)}(${a.join(', ')})`, { call: true })); break; }
      case 0x69: { const sup = pop(), sub = pop(); out.push(indent + `${sub.s} extends ${sup.s};`); break; }
      case 0x81: out.push(indent + `gotoFrame(${dv.getUint16(b, true) + 1});`); break;
      case 0x83: out.push(indent + `getURL(...);`); break;
      case 0x87: { const r = u8[b]; const v = st[st.length - 1] || E('undefined'); out.push(indent + `${reg(r)} = ${v.s};`); st[st.length - 1] = E(reg(r)); break; }
      case 0x88: { pool.length = 0; const r = new Bits(u8, b); const n = r.u16(); for (let i = 0; i < n; i++) pool.push(r.str()); break; }
      case 0x8B: out.push(indent + `setTarget(${JSON.stringify(new Bits(u8, b).str())});`); break;
      case 0x8C: out.push(indent + `gotoLabel(${JSON.stringify(new Bits(u8, b).str())});`); break;
      case 0x9F: { const f = u8[b]; out.push(indent + `${f & 1 ? 'gotoAndPlay' : 'gotoAndStop'}(${pop().s});`); break; }
      case 0x9A: { const t = pop(), u = pop(); out.push(indent + `getURL(${u.s}, ${t.s});`); break; }
      case 0x96: {
        const r = new Bits(u8, b);
        while (r.pos < b + o.len) {
          const t = r.u8_();
          if (t === 0) { const s = r.str(); st.push(E(lit(s), { lit: true, v: s })); }
          else if (t === 1) { const v = dv.getFloat32(r.pos, true); r.pos += 4; st.push(E(lit(+v.toFixed(6)), { lit: true, v })); }
          else if (t === 2) st.push(E('null', { lit: true, v: null }));
          else if (t === 3) st.push(E('undefined', { lit: true, v: undefined }));
          else if (t === 4) { st.push(E(reg(r.u8_()))); }
          else if (t === 5) { const v = !!r.u8_(); st.push(E(String(v), { lit: true, v })); }
          else if (t === 6) { const bb = Buffer.alloc(8); for (let i = 0; i < 4; i++) { bb[i] = u8[r.pos + 4 + i]; bb[4 + i] = u8[r.pos + i]; } r.pos += 8; const v = bb.readDoubleLE(0); st.push(E(lit(v), { lit: true, v })); }
          else if (t === 7) { const v = dv.getInt32(r.pos, true); r.pos += 4; st.push(E(String(v), { lit: true, v })); }
          else if (t === 8) { const s = pool[r.u8_()]; st.push(E(lit(s), { lit: true, v: s })); }
          else if (t === 9) { const s = pool[r.u16()]; st.push(E(lit(s), { lit: true, v: s })); }
          else break;
        }
        break;
      }
      case 0x99: { if (st.length) { out.push(indent + `// stack: ${st.map(x => x.s).join(', ')}`); st.length = 0; } const off = dv.getInt16(b, true); out.push(indent + `goto ${labels.get(o.next + off)};`); break; }
      case 0x9D: { const c = pop(); const off = dv.getInt16(b, true); out.push(indent + `if (${c.s}) goto ${labels.get(o.next + off)};`); break; }
      case 0x9B: case 0x8E: {
        const r = new Bits(u8, b); const name = r.str(); const np = r.u16(); const params = []; const rn = {};
        let codeSize;
        if (op === 0x8E) {
          const nregs = r.u8_(); const fl = r.u16();
          for (let i = 0; i < np; i++) { const rr = r.u8_(); const pn = r.str(); params.push(pn); if (rr) rn[rr] = pn; }
          // preloaded registers: this, arguments, super, _root, _parent, _global
          let k = 1;
          if (fl & 1) rn[k++] = 'this'; if (fl & 4) rn[k++] = 'arguments'; if (fl & 16) rn[k++] = 'super';
          if (fl & 64) rn[k++] = '_root'; if (fl & 128) rn[k++] = '_parent'; if (fl & 256) rn[k++] = '_global';
          void nregs;
        } else for (let i = 0; i < np; i++) params.push(r.str());
        codeSize = r.u16();
        const bodyStart = r.pos, bodyEnd = r.pos + codeSize;
        const inner = decompile(u8, bodyStart, bodyEnd, pool, rn, indent + '  ');
        const head = `function ${name}(${params.join(', ')}) {`;
        if (name) out.push(indent + head, ...inner, indent + '}');
        else st.push(E(head + '\n' + inner.join('\n') + '\n' + indent + '}'));
        skipTo = bodyEnd;
        break;
      }
      case 0x94: { const size = dv.getUint16(b, true); const t = pop(); const inner = decompile(u8, o.next, o.next + size, pool, regNames, indent + '  '); out.push(indent + `with (${t.s}) {`, ...inner, indent + '}'); skipTo = o.next + size; break; }
      default:
        if (BIN[op]) { const bb = pop(), a = pop(); st.push(E(`(${a.s} ${BIN[op]} ${bb.s})`)); }
        else out.push(indent + `/* op 0x${op.toString(16)} */`);
    }
  }
  if (st.length) out.push(indent + `// stack: ${st.map(x => x.s).join(', ')}`);
  return out;
}

function parse(file) {
  let buf = fs.readFileSync(file);
  const sig = buf.toString('latin1', 0, 3);
  const version = buf[3];
  if (sig === 'CWS') buf = Buffer.concat([buf.subarray(0, 8), zlib.inflateSync(buf.subarray(8))]);
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
  const r = new Bits(u8, 8); r.rect(); r.u16(); r.u16();
  const res = { version, exports: {}, sprites: {} };
  const pool = [];
  const b64 = (a, b) => Buffer.from(u8.subarray(a, b)).toString('base64');
  function timeline(pos, end, id) {
    const tl = { id, frames: [[]], labels: {} };
    let fi = 0;
    // display list per depth, to give each instance the same `born` frame as swf.js
    const list = new Map();
    const dv = new DataView(u8.buffer, u8.byteOffset);
    while (pos + 2 <= end) {
      const h = dv.getUint16(pos, true); pos += 2; const code = h >> 6; let len = h & 63;
      if (len === 63) { len = dv.getUint32(pos, true); pos += 4; }
      const p = pos; pos += len;
      const fr = () => tl.frames[fi];
      const b = new Bits(u8, p);
      if (code === 0) break;
      if (code === 1) { fi++; tl.frames[fi] = []; continue; }
      if (code === 39) { const sid = b.u16(); b.u16(); res.sprites[sid] = timeline(b.pos, p + len, sid); continue; }
      if (code === 12) { fr().push({ kind: 'action', code: decompile(u8, p, p + len, pool), bytes: b64(p, p + len) }); continue; }
      if (code === 43) { tl.labels[b.str()] = fi; continue; }
      if (code === 59) { const sid = b.u16(); fr().push({ kind: 'init', sprite: sid, code: decompile(u8, b.pos, p + len, pool) }); continue; }
      if (code === 56) { const n = b.u16(); for (let i = 0; i < n; i++) { const cid = b.u16(); res.exports[b.str()] = cid; } continue; }
      if (code === 4) { const cid = b.u16(), depth = b.u16(), m = b.matrix(); const e = { kind: 'place', depth, id: cid, m, born: fi }; list.set(depth, e); fr().push(e); continue; }
      if (code === 5) { b.u16(); const depth = b.u16(); list.delete(depth); fr().push({ kind: 'remove', depth }); continue; }
      if (code === 28) { const depth = b.u16(); list.delete(depth); fr().push({ kind: 'remove', depth }); continue; }
      if (code === 26 || code === 70) {
        const f = b.u8_(); const f2 = code === 70 ? b.u8_() : 0; const depth = b.u16();
        const e = { kind: f & 1 && !(f & 2) ? 'move' : 'place', depth };
        const prev = list.get(depth);
        if (code === 70 && (f2 & 8)) e.className = b.str();
        if (f & 2) e.id = b.u16();
        // same rule as swf.js: a new instance unless it moves the same character
        e.born = prev && (f & 1) && (!(f & 2) || prev.id === e.id) ? prev.born : fi;
        if (e.kind === 'move' && prev) e.id = prev.id;
        if (e.kind === 'place' && (f & 1) && prev && prev.id === e.id) e.kind = 'move';
        if (f & 4) e.m = b.matrix();
        if (f & 8) e.cx = b.cxform(true);
        if (f & 16) e.ratio = b.u16();
        if (f & 32) e.name = b.str();
        if (f & 64) e.clipDepth = b.u16();
        if (code === 70) { if (f2 & 1) { e.filters = true; fr().push(e); continue; } if (f2 & 2) b.u8_(); if (f2 & 4) b.u8_(); }
        if (f & 128) {
          b.u16(); const wide = version >= 6; wide ? b.u32() : b.u16();
          e.events = [];
          for (;;) {
            const ev = wide ? b.u32() : b.u16(); if (!ev) break;
            const size = b.u32(); let s = b.pos; if (ev & 0x20000) s++;
            const names = Object.entries(EVENTS).filter(([k]) => ev & k).map(([, v]) => v);
            e.events.push({ on: names.join(','), flags: ev, code: decompile(u8, s, b.pos + size, pool), bytes: b64(s, b.pos + size) });
            b.pos += size;
          }
        }
        if (e.id) list.set(depth, { id: e.id, born: e.born });
        fr().push(e);
        continue;
      }
    }
    if (!tl.frames[tl.frames.length - 1].length && tl.frames.length > 1) tl.frames.pop();
    return tl;
  }
  res.root = timeline(r.pos, u8.length, 0);
  return res;
}

function print(res) {
  const L = [];
  const names = Object.fromEntries(Object.entries(res.exports).map(([k, v]) => [v, k]));
  L.push(`SWF v${res.version}  exports: ${Object.entries(res.exports).map(([k, v]) => `${k}=#${v}`).join(' ') || '-'}`);
  const show = (tl) => {
    const label = tl.id === 0 ? 'ROOT' : `sprite #${tl.id}${names[tl.id] ? ` "${names[tl.id]}"` : ''}`;
    const interesting = tl.frames.some((f) => f.some((e) => e.kind === 'action' || e.kind === 'init' || e.events || e.name));
    if (!interesting && tl.id !== 0) { L.push(`${label}: ${tl.frames.length} frames`); return; }
    L.push(`${label}: ${tl.frames.length} frames`);
    tl.frames.forEach((f, i) => {
      for (const e of f) {
        if (e.kind === 'place' || e.kind === 'move') {
          if (e.kind === 'move' && !e.events && !e.name) continue;
          const m = e.m ? ` at (${e.m[4]}, ${e.m[5]})${e.m[0] !== 1 || e.m[3] !== 1 || e.m[1] || e.m[2] ? ` m=[${e.m.slice(0, 4).map(v => +v.toFixed(3)).join(',')}]` : ''}` : '';
          L.push(`  f${i + 1} ${e.kind} d${e.depth}${e.id ? ' #' + e.id : ''}${e.name ? ` name="${e.name}"` : ''}${m}`);
          for (const ev of e.events || []) { L.push(`    onClipEvent(${ev.on}) {`); L.push(...ev.code.map((s) => '      ' + s)); L.push('    }'); }
        } else if (e.kind === 'action') { L.push(`  f${i + 1} script:`); L.push(...e.code.map((s) => '    ' + s)); }
        else if (e.kind === 'init') { L.push(`  f${i + 1} initclip #${e.sprite}:`); L.push(...e.code.map((s) => '    ' + s)); }
      }
    });
  };
  show(res.root);
  for (const tl of Object.values(res.sprites)) show(tl);
  return L.join('\n');
}

if (require.main === module) {
  const res = parse(process.argv[2]);
  if (process.argv.includes('--json')) console.log(JSON.stringify(res, null, 1)); else console.log(print(res));
}
module.exports = { parse, print };
