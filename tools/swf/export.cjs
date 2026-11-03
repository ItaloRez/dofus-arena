// Pre-renders Dofus 1.29 client assets (SWF) into web images for the game.
//   node export.cjs [sprites|icons|items|maps|fx|fxparts|all]  (also: sprite <gfx>, carry)
// Reads the client from $CLIENT (see harness.cjs), writes into server/public/assets.
const { open, saveDataUrl } = require('./harness.cjs');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'server/public/assets');
const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'server/data/game.json')));
const what = process.argv[2] || 'all';
const only = (k) => what === 'all' || what === k;

const CLASS_ANIMS = ['static', 'walk', 'run', 'hit', 'die', 'bonus', 'anim0', 'anim1'];
const MONSTER_ANIMS = ['static', 'walk', 'hit', 'die', 'anim0', 'anim1'];
const FULL_ANIMS = ['static', 'walk', 'run', 'hit', 'die', 'bonus', 'anim0', 'anim1', 'anim2', 'anim3', 'anim4', 'anim5', 'anim6', 'anim7', 'anim8', 'anim9'];
// MAPS=id,id... exports other maps; POOL tags them ('pvp' for the ranked/training fights, 'training' for the scarecrow)
const MAPS = process.env.MAPS ? process.env.MAPS.split(',').map(Number) : [10648, 10301, 10186, 7346, 7386, 7456, 7488, 9513, 9594, 176, 10344, 9773];
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); };
const exists = (f) => fs.existsSync(f);

(async () => {
  const { browser, page } = await open();
  page.setDefaultTimeout(0);
  const ev = (fn, arg) => page.evaluate(fn, arg);

  // one sprite by gfx id, e.g. the sandbox dummy: node export.cjs sprite 1234
  if (what === 'sprite') {
    const gfx = Number(process.argv[3]);
    const meta = {};
    for (const a of FULL_ANIMS) for (const d of ['R', 'L']) {
      const r = await ev(([g, n]) => R.sheet(`clips/sprites/${g}.swf`, n, { scale: 2, size: 640, q: 0.88 }), [gfx, a + d]).catch(() => null);
      if (!r || r.empty) continue;
      saveDataUrl(`${OUT}/sprites/${gfx}/${a}${d}.webp`, r.data); delete r.data;
      meta[a + d] = r;
    }
    writeJson(`${OUT}/sprites/${gfx}.json`, meta);
    const r = await ev((g) => R.image(`clips/sprites/${g}.swf`, 'staticR', { scale: 5, size: 1024 }), gfx);
    if (r && r.data) saveDataUrl(`${OUT}/classes/full/${gfx}.png`, r.data);
    console.log('sprite', gfx, Object.keys(meta).join(' ') || 'nothing found');
  }

  // Spell casting animations anim2..anim9 of every class (the spell's sprite info names which one the caster
  // plays), merged into the class sprite JSON.
  if (what === 'classanims') {
    for (let c = 1; c <= 12; c++) for (const gfx of [c * 10, c * 10 + 1]) {
      const metaFile = `${OUT}/sprites/${gfx}.json`;
      const meta = exists(metaFile) ? JSON.parse(fs.readFileSync(metaFile)) : {};
      for (let n = 0; n <= 9; n++) for (const d of ['R', 'L']) {
        if (meta[`anim${n}${d}`] && !process.env.FORCE) continue;
        const r = await ev(([g, a]) => R.sheet(`clips/sprites/${g}.swf`, a, { scale: 2, size: 640, q: 0.88 }), [gfx, `anim${n}${d}`]).catch(() => null);
        if (!r || r.empty) continue;
        saveDataUrl(`${OUT}/sprites/${gfx}/anim${n}${d}.webp`, r.data); delete r.data;
        meta[`anim${n}${d}`] = r;
      }
      await ev((g) => R.unload(`clips/sprites/${g}.swf`), gfx);
      writeJson(metaFile, meta);
      console.log('classanims', gfx, Object.keys(meta).filter((k) => k.startsWith('anim')).join(' '));
    }
  }

  // Pandawa carrying animations (Karcham / Chamrak), merged into the class sprite JSON.
  // Each entry keeps `carry`: where the carried fighter is held, per frame (null once it is thrown).
  if (what === 'carry') {
    const CARRY_ANIMS = ['static_C', 'walk_C', 'run_C', 'hit_C', 'carring_C', 'carringThrow_C', 'carringEnd_C'];
    for (const gfx of [120, 121]) {
      const metaFile = `${OUT}/sprites/${gfx}.json`;
      const meta = exists(metaFile) ? JSON.parse(fs.readFileSync(metaFile)) : {};
      for (const a of CARRY_ANIMS) for (const d of ['R', 'L']) {
        const r = await ev(([g, n]) => R.sheet(`clips/sprites/${g}.swf`, n, { scale: 2, size: 640, q: 0.88 }), [gfx, a + d]).catch(() => null);
        if (!r || r.empty) continue;
        saveDataUrl(`${OUT}/sprites/${gfx}/${a}${d}.webp`, r.data); delete r.data;
        meta[a + d] = r;
      }
      await ev((g) => R.unload(`clips/sprites/${g}.swf`), gfx);
      writeJson(metaFile, meta);
      console.log('carry', gfx, Object.keys(meta).filter((k) => k.includes('_C')).join(' '));
    }
  }

  if (only('sprites')) {
    const gfxs = [];
    for (let c = 1; c <= 12; c++) gfxs.push([c * 10, CLASS_ANIMS], [c * 10 + 1, CLASS_ANIMS]);
    for (const m of Object.values(game.monsters)) if (m && m.gfx) gfxs.push([m.gfx, MONSTER_ANIMS]);
    for (const [gfx, anims] of gfxs) {
      const metaFile = `${OUT}/sprites/${gfx}.json`;
      if (exists(metaFile) && !process.env.FORCE) continue;
      const meta = {};
      for (const a of anims) for (const d of ['R', 'L']) {
        const r = await ev(([g, n]) => R.sheet(`clips/sprites/${g}.swf`, n, { scale: 2, size: 640, q: 0.88 }), [gfx, a + d]);
        if (!r || r.empty) continue;
        saveDataUrl(`${OUT}/sprites/${gfx}/${a}${d}.webp`, r.data); delete r.data;
        meta[a + d] = r;
      }
      await ev((g) => R.unload(`clips/sprites/${g}.swf`), gfx);
      writeJson(metaFile, meta);
      console.log('sprite', gfx, Object.keys(meta).length);
    }
  }

  if (only('portraits')) {
    const list = [];
    for (let c = 1; c <= 12; c++) list.push(c * 10, c * 10 + 1);
    for (const m of Object.values(game.monsters)) if (m && m.gfx) list.push(m.gfx);
    for (const g of list) {
      const r = await ev((gg) => R.image(`clips/sprites/${gg}.swf`, 'staticR', { scale: 5, size: 1024 }), g);
      if (r && r.data) saveDataUrl(`${OUT}/classes/full/${g}.png`, r.data);
      await ev((gg) => R.unload(`clips/sprites/${gg}.swf`), g);
    }
    console.log('portraits done (crop with tools/portraits.py)');
  }

  if (only('icons')) {
    const ids = new Set(game.commonSpells);
    for (const l of Object.values(game.classSpells)) l.forEach((i) => ids.add(i));
    for (const id of ids) {
      const f = `${OUT}/spells/${id}.png`;
      if (exists(f)) continue;
      const r = await ev((i) => R.image(`clips/spells/icons/${i}.swf`, 0, { scale: 1, size: 256 }), id);
      if (r && r.data) saveDataUrl(f, r.data);
      await ev((i) => R.unload(`clips/spells/icons/${i}.swf`), id);
    }
    console.log('spell icons', ids.size);
  }

  if (only('items')) {
    let n = 0;
    for (const it of Object.values(game.items)) {
      if (!it.gfx) continue;
      const f = `${OUT}/items/${it.type}/${it.gfx}.png`;
      if (exists(f)) continue;
      const url = `clips/items/${it.type}/${it.gfx}.swf`;
      const r = await ev((u) => R.image(u, 0, { scale: 1, size: 1024 }), url).catch(() => null);
      if (r && r.data) { saveDataUrl(f, r.data); n++; }
      await ev((u) => R.unload(u), url);
    }
    console.log('item icons', n);
  }

  if (only('fx')) {
    const sprites = new Set();
    const ids = new Set(game.commonSpells);
    for (const l of Object.values(game.classSpells)) l.forEach((i) => ids.add(i));
    for (const id of ids) { const s = game.spells[id]; if (s && s.sprite > 0) sprites.add(s.sprite); }
    const metaFile = `${OUT}/fx/index.json`;
    const meta = exists(metaFile) ? JSON.parse(fs.readFileSync(metaFile)) : {};
    for (const sp of sprites) {
      if (meta[sp] !== undefined) continue;
      const url = `clips/spells/${sp}.swf`;
      const r = await ev((u) => R.sheet(u, 0, { scale: 2, size: 768, maxFrames: 150, trimEnd: true, q: 0.85 }), url).catch((e) => { console.log('fx err', sp, e.message); return null; });
      if (r && r.data) { saveDataUrl(`${OUT}/fx/${sp}.webp`, r.data); delete r.data; meta[sp] = r; } else meta[sp] = null;
      await ev((u) => R.unload(u), url);
      writeJson(metaFile, meta);
    }
    console.log('fx', Object.values(meta).filter(Boolean).length, '/', sprites.size);
  }

  // Pieces that VisualEffectHandler places itself: "move" (projectile of types 30/31), "shoot" (impact),
  // "duplicate" (trail of types 40/41) and the root's "rotate" instance (types 20/21, turned towards the target).
  if (only('fxparts')) {
    const sprites = new Set();
    const ids = new Set(game.commonSpells);
    for (const l of Object.values(game.classSpells)) l.forEach((i) => ids.add(i));
    const scriptedTypes = new Set();
    for (const id of ids) {
      const s = game.spells[id]; if (!s || !(s.sprite > 0)) continue;
      sprites.add(s.sprite);
      if (s.spriteInfo && s.spriteInfo[0] >= 50) scriptedTypes.add(s.sprite);
    }
    const metaFile = `${OUT}/fx/parts.json`;
    const meta = exists(metaFile) && !process.env.FORCE ? JSON.parse(fs.readFileSync(metaFile)) : {};
    // a few scripted SWFs never finish rendering: give each call a time limit
    const evT = (fn, arg) => Promise.race([ev(fn, arg), new Promise((res) => setTimeout(() => res(null), 20000))]);
    for (const sp of sprites) {
      if (meta[sp] !== undefined) continue;
      const url = `clips/spells/${sp}.swf`;
      const parts = {};
      if (process.env.VERBOSE) console.log('fxparts', sp);
      const info = await evT(async (u) => {
        const s = await R.ready(u); if (!s) return null;
        const root = s.dict.get(0);
        const rot = root.frames[0].find((e) => e.name === 'rotate');
        // scripted effects (types 50/51) made of one clip that the script turns towards the target (it reads `angle`)
        const kids = new Map();
        for (const f of root.frames) for (const e of f) if (s.dict.get(e.id)?.type === 'sprite' && !kids.has(e.id)) kids.set(e.id, e);
        const usesAngle = new TextDecoder('latin1').decode(s.u8).includes('angle');
        // the first clip flies from the caster, the second one (if any) is the impact placed on the target
        const [aim, hit] = [...kids.values()].sort((a, b) => a.depth - b.depth);
        const scripted = !rot && root.frames.length <= 2 && kids.size <= 2 && aim;
        return { exports: [...s.exports.keys()], rotate: rot ? { id: rot.id, m: rot.m } : null, others: root.frames[0].filter((e) => e !== rot).length,
          aim: scripted && usesAngle ? { id: aim.id, m: aim.m } : null, hit: scripted && usesAngle && hit ? { id: hit.id, m: hit.m } : null,
          // without `angle` the script only moves its clip onto the target cell
          place: scripted && !usesAngle ? { id: aim.id, m: aim.m } : null };
      }, url).catch(() => null);
      if (info && !scriptedTypes.has(sp)) { info.aim = info.hit = info.place = null; }
      if (info) {
        for (const name of ['move', 'shoot', 'duplicate']) {
          if (!info.exports.includes(name)) continue;
          const r = await evT(([u, n]) => R.sheet(u, n, { scale: 2, size: 768, maxFrames: 150, trimEnd: true, q: 0.85 }), [url, name]).catch(() => null);
          if (r && r.data) { saveDataUrl(`${OUT}/fx/parts/${sp}-${name}.webp`, r.data); delete r.data; parts[name] = r; }
        }
        if (info.aim) {
          const r = await evT(([u, n]) => R.sheet(u, n, { scale: 2, size: 1024, maxFrames: 150, trimEnd: true, q: 0.85 }), [url, info.aim.id]).catch(() => null);
          if (r && r.data) {
            saveDataUrl(`${OUT}/fx/parts/${sp}-aim.webp`, r.data); delete r.data;
            const m = info.aim.m;
            parts.aim = { ...r, tx: m[4] / 20, ty: m[5] / 20, sx: Math.hypot(m[0], m[1]), sy: Math.hypot(m[2], m[3]) };
          }
          if (info.hit) {
            const h = await evT(([u, n]) => R.sheet(u, n, { scale: 2, size: 1024, maxFrames: 150, trimEnd: true, q: 0.85 }), [url, info.hit.id]).catch(() => null);
            if (h && h.data && parts.aim) {
              saveDataUrl(`${OUT}/fx/parts/${sp}-hit.webp`, h.data); delete h.data;
              const m = info.hit.m;
              parts.hit = { ...h, ty: m[5] / 20 - info.aim.m[5] / 20 };
              // how far the flight was drawn: the client stretches nothing, but our target is rarely that far
              parts.aim.reach = Math.hypot(m[4] - info.aim.m[4], m[5] - info.aim.m[5]) / 20;
            }
          }
        }
        if (info.place) {
          const r = await evT(([u, n]) => R.sheet(u, n, { scale: 2, size: 1024, maxFrames: 150, trimEnd: true, q: 0.85 }), [url, info.place.id]).catch(() => null);
          if (r && r.data) { saveDataUrl(`${OUT}/fx/parts/${sp}-place.webp`, r.data); delete r.data; parts.place = { ...r, tx: info.place.m[4] / 20, ty: info.place.m[5] / 20 }; }
        }
        if (info.rotate) {
          const r = await evT(([u, n]) => R.sheet(u, n, { scale: 2, size: 768, maxFrames: 150, trimEnd: true, q: 0.85 }), [url, info.rotate.id]).catch(() => null);
          if (r && r.data) {
            saveDataUrl(`${OUT}/fx/parts/${sp}-rotate.webp`, r.data); delete r.data;
            const m = info.rotate.m;
            // the instance keeps its position and scale; only its rotation is replaced by the caster -> target angle
            parts.rotate = { ...r, tx: m[4] / 20, ty: m[5] / 20, sx: Math.hypot(m[0], m[1]), sy: Math.hypot(m[2], m[3]), alone: info.others === 0 };
          }
        }
      }
      meta[sp] = Object.keys(parts).length ? parts : null;
      await ev((u) => R.unload(u), url);
      writeJson(metaFile, meta);
    }
    console.log('fx parts', Object.values(meta).filter(Boolean).length, '/', sprites.size);
  }

  // animated layer-2 objects placed by the server with GDC (e.g. 25: the Sram trap, "Haaaaaaaaz3005")
  //   node export.cjs objanim 25 [more ids]   -> assets/gfx/<id>.webp (sheet) + frames/cols in gfx/index.json
  if (what === 'objanim') {
    const ids = process.argv.slice(3).map(Number).filter(Boolean);
    const gfxMeta = exists(`${OUT}/gfx/index.json`) ? JSON.parse(fs.readFileSync(`${OUT}/gfx/index.json`)) : {};
    for (const gid of ids) {
      const r = await ev(async (g) => {
        await R.gfxIndex();
        for (let i = 1; i <= 12; i++) {
          const u = `clips/gfx/o${i}.swf`;
          const s = await R.ready(u);
          if (s && s.exports.has(String(g))) return R.sheet(u, String(g), { scale: 2, size: 1024, maxFrames: 300, q: 0.9 });
        }
        return null;
      }, gid);
      if (!r || !r.data) { console.log('objanim', gid, 'not found'); continue; }
      saveDataUrl(`${OUT}/gfx/${gid}.webp`, r.data); delete r.data;
      gfxMeta[gid] = r;
      console.log('objanim', gid, r.frames, 'frames');
    }
    writeJson(`${OUT}/gfx/index.json`, gfxMeta);
  }

  if (only('maps')) {
    const maps = JSON.parse(fs.readFileSync(path.join(__dirname, '../out/maps.json')));
    const names = JSON.parse(fs.readFileSync(path.join(__dirname, '../out/maps_pt_1361.json'))).MA;
    const gfxMeta = exists(`${OUT}/gfx/index.json`) ? JSON.parse(fs.readFileSync(`${OUT}/gfx/index.json`)) : {};
    const out = [];
    for (const id of MAPS) {
      const m = maps[id]; if (!m) { console.log('no map', id); continue; }
      const r = await ev((mm) => R.renderMap(mm, { scale: 2 }), m);
      saveDataUrl(`${OUT}/maps/${id}.webp`, r.data);
      for (const o of r.objs) {
        if (gfxMeta[o.id] !== undefined) continue;
        const img = await ev((gid) => R.objImage(gid, 2), o.id);
        if (img && img.data) { saveDataUrl(`${OUT}/gfx/${o.id}.webp`, img.data); delete img.data; gfxMeta[o.id] = img; } else gfxMeta[o.id] = null;
      }
      const sa = names.m[id] && names.sa[names.m[id].sa];
      const area = sa && names.a[sa.a];
      out.push({
        id, name: sa ? sa.n : `Mapa ${id}`, area: area ? area.n : '', w: m.w, h: m.h, places: m.places,
        img: { w: r.w, h: r.h, padY: r.padY, scale: 2 },
        cells: m.cells.map((c) => [c.active, c.los, c.movement, c.groundLevel, c.slope]),
        objs: r.objs.map((o) => [o.cell, o.id, o.flip ? 1 : 0]),
      });
      console.log('map', id, r.objs.length, 'objs', r.missing.length ? 'missing ' + r.missing.join(',') : '');
    }
    writeJson(`${OUT}/gfx/index.json`, gfxMeta);
    // merge into the existing list: maps exported now replace the ones with the same id
    const file = path.join(ROOT, 'server/data/maps.json');
    const prev = exists(file) ? JSON.parse(fs.readFileSync(file)) : [];
    if (process.env.POOL) for (const m of out) m.pool = process.env.POOL;
    writeJson(file, [...prev.filter((m) => !out.some((o) => o.id === m.id)), ...out]);
  }
  await browser.close();
})();
