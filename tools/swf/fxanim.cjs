// Exports the spell effects for the client's effect player (server/public/js/fxplayer.js).
//   CLIENT=<client folder> node fxanim.cjs [sprite ids...]      (default: every spell sprite the game uses)
//
// The 1.29 client loads a spell SWF and lets its ActionScript place and move the pieces (cellFrom, cellTo,
// angle, level...). Here each SWF becomes:
//   - "clips": the sprites the player has to create itself, because they (or something inside them) run a
//     script, have clip events or a name. For those it keeps the timeline of those instances and the raw
//     bytecode of every frame script / clip event;
//   - "bands": everything else, pre-rendered. A band is the static content of one clip between two depths,
//     drawn in the right order between the instances the player creates.
// Output: server/public/assets/fx/anim/<sprite>.json + <sprite>-<page>.webp
const { open, saveDataUrl } = require('./harness.cjs');
const { parse } = require('./as.cjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'server/public/assets/fx/anim');
const CLIENT = process.env.CLIENT || '/home/claude/assets-src/client/';
const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/game.json')));

// scripts that only stop the clip or play a sound do not need the player (the renderer bakes the stop,
// the sounds come from tools/audio.py)
const TRIVIAL = /^\s*(stop\(\);|play\(\);|SOMA\.playSound\(.*\);)?\s*$/;

function plan(file) {
  const res = parse(file);
  const tls = { 0: res.root, ...res.sprites };
  const isSprite = (id) => id != null && tls[id] !== undefined;
  const memo = new Map();
  const expands = (id, seen = new Set()) => {
    if (id === 0) return true;
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id) || !isSprite(id)) return false;
    seen.add(id);
    let v = false;
    for (const f of tls[id].frames) for (const e of f) {
      if (e.kind === 'action' && !e.code.every((l) => TRIVIAL.test(l))) v = true;
      else if ((e.kind === 'place' || e.kind === 'move') && (e.events?.length || (isSprite(e.id) && expands(e.id, seen)))) v = true;
    }
    memo.set(id, v);
    return v;
  };

  const clips = {};
  const queue = [0, ...Object.values(res.exports)];
  const seen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !isSprite(id)) continue;
    seen.add(id);
    const tl = tls[id];
    if (!expands(id)) {
      clips[id] = { t: tl.frames.length, bands: [{ lo: -1, hi: 1e9, skip: [] }] };
      continue;
    }
    // instances the player creates: clips with a script inside, clip events or a name
    const nodeKeys = new Set();
    for (const f of tl.frames) for (const e of f) {
      if ((e.kind === 'place' || e.kind === 'move') && isSprite(e.id) && (expands(e.id) || e.events?.length || e.name)) nodeKeys.add(e.depth + ':' + e.born);
    }
    const frames = [];
    const holder = new Map(); // depth -> node key
    for (const f of tl.frames) {
      const ops = [];
      for (const e of f) {
        if (e.kind === 'action') { ops.push({ o: 'a', b: e.bytes }); continue; }
        if (e.kind === 'remove') { if (holder.has(e.depth)) { ops.push({ o: 'r', d: e.depth }); holder.delete(e.depth); } continue; }
        if (e.kind !== 'place' && e.kind !== 'move') continue;
        const key = e.depth + ':' + e.born;
        if (nodeKeys.has(key)) {
          if (holder.get(e.depth) === key) ops.push({ o: 'm', d: e.depth, ...(e.m ? { m: e.m } : {}), ...(e.cx ? { cx: e.cx } : {}) });
          else {
            holder.set(e.depth, key);
            ops.push({ o: 'p', d: e.depth, c: e.id, m: e.m || [1, 0, 0, 1, 0, 0], ...(e.cx ? { cx: e.cx } : {}), ...(e.name ? { n: e.name } : {}),
              ...(e.events?.length ? { ev: e.events.map((v) => ({ f: v.flags, b: v.bytes })) } : {}) });
            queue.push(e.id);
          }
        } else if (holder.has(e.depth)) { ops.push({ o: 'r', d: e.depth }); holder.delete(e.depth); }
      }
      frames.push(ops);
    }
    // bands between the depths of the created instances
    const depths = [...new Set([...nodeKeys].map((k) => Number(k.split(':')[0])))].sort((a, b) => a - b);
    const cuts = [-1, ...depths, 1e9];
    const bands = [];
    for (let j = 1; j < cuts.length; j++) {
      const lo = cuts[j - 1], hi = cuts[j];
      const has = tl.frames.some((f) => f.some((e) => e.kind === 'place' && e.depth > lo && e.depth <= hi && !nodeKeys.has(e.depth + ':' + e.born)));
      if (has) bands.push({ lo, hi, skip: [...nodeKeys] });
    }
    clips[id] = { t: tl.frames.length, x: 1, f: frames, l: tl.labels, bands };
  }
  // does a script call the client's end() hook (the moment the fight goes on)?
  const calls = (code) => code.some((l) => /\bend\(\)/.test(l));
  const end = Object.values(tls).some((tl) => tl.frames.some((f) => f.some((e) => (e.kind === 'action' && calls(e.code)) || (e.events || []).some((v) => calls(v.code)))));
  return { exports: res.exports, clips, end };
}

(async () => {
  let sprites = process.argv.slice(2).map(Number);
  if (!sprites.length) {
    const ids = new Set(game.commonSpells);
    for (const l of Object.values(game.classSpells)) l.forEach((i) => ids.add(i));
    sprites = [...new Set([...ids].map((i) => game.spells[i]?.sprite).filter((s) => s > 0))].sort((a, b) => a - b);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const { browser, page } = await open();
  page.setDefaultTimeout(0);
  const index = fs.existsSync(path.join(OUT, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'))) : {};
  for (const sp of sprites) {
    const file = path.join(CLIENT, 'clips/spells', sp + '.swf');
    if (!fs.existsSync(file)) { console.log('missing', sp); continue; }
    const t0 = Date.now();
    const p = plan(file);
    const jobs = [];
    for (const [id, c] of Object.entries(p.clips)) c.bands.forEach((b, i) => jobs.push({ id: Number(id), i, ...b }));
    const out = await page.evaluate(async ([url, jobs]) => {
      const sheets = []; const meta = [];
      for (const j of jobs) {
        const r = await R.bandFrames(url, j.id, { lo: j.lo, hi: j.hi, skip: j.skip, size: j.id === 0 ? 1536 : 1024 });
        meta.push(r ? { w: r.w, h: r.h, cols: r.cols, frames: r.frames, total: r.total, ox: r.ox, oy: r.oy, stop: r.stop, k: sheets.length } : null);
        if (r) sheets.push(r);
      }
      const atlas = sheets.length ? await R.packAtlas(sheets) : { pages: [], place: [] };
      R.unload(url);
      return { meta, pages: atlas.pages, place: atlas.place };
    }, [`clips/spells/${sp}.swf`, jobs]);
    const clips = {};
    for (const [id, c] of Object.entries(p.clips)) clips[id] = { t: c.t, ...(c.x ? { x: 1, f: c.f } : {}), ...(c.l && Object.keys(c.l).length ? { l: c.l } : {}), b: [] };
    jobs.forEach((j, n) => {
      const m = out.meta[n]; if (!m) return;
      const [pg, x, y] = out.place[m.k];
      // drawn just under the instance at depth hi (or above the last one)
      const z = j.hi === 1e9 ? j.lo + 0.5 : j.hi - 0.5;
      clips[j.id].b.push({ z, p: pg, x, y, w: m.w, h: m.h, c: m.cols, n: m.frames, t: m.total, ox: m.ox, oy: m.oy, s: m.stop });
    });
    out.pages.forEach((d, i) => saveDataUrl(path.join(OUT, `${sp}-${i}.webp`), d));
    fs.writeFileSync(path.join(OUT, `${sp}.json`), JSON.stringify({ v: 1, ex: p.exports, pages: out.pages.length, end: p.end ? 1 : 0, clips }));
    index[sp] = out.pages.length;
    fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index));
    console.log('fxanim', sp, 'clips', Object.keys(clips).length, 'bands', jobs.length, 'pages', out.pages.length, ((Date.now() - t0) / 1000).toFixed(1) + 's');
  }
  await browser.close();
})();
