// Exports only sprites and spell FX required by game.json but absent from public/assets.
// CLIENT=/path/to/1.29-client node tools/swf/export-required.cjs [sprites|fx|all]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { open, saveDataUrl } = require('./harness.cjs');

const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'server/public/assets');
const data = JSON.parse(fs.readFileSync(path.join(root, 'server/data/game.json'), 'utf8'));
const mode = process.argv[2] || 'all';
if (!['sprites', 'fx', 'all'].includes(mode)) throw new Error('Use sprites, fx ou all');
const client = process.env.CLIENT;
if (!client || !fs.existsSync(path.join(client, 'clips/sprites'))) {
  throw new Error('Informe CLIENT apontando para a pasta do cliente 1.29 que contém clips/sprites/');
}
const classAnims = ['static', 'walk', 'run', 'hit', 'die', 'bonus', 'anim0', 'anim1'];
const monsterAnims = ['static', 'walk', 'hit', 'die', 'anim0', 'anim1'];
const required = new Map();
function requireSprite(gfx, anims) {
  if (!gfx) return;
  if (!required.has(gfx)) required.set(gfx, new Set());
  for (const a of anims) required.get(gfx).add(a);
}
const fxIds = new Set();
for (const [cls, ids] of Object.entries(data.classSpells)) {
  const anims = new Set(classAnims);
  for (const id of ids) {
    const n = data.spells[id]?.spriteInfo?.[1];
    if (Number.isInteger(n) && n >= 0) anims.add(`anim${n}`);
  }
  for (const sex of [0, 1]) requireSprite(Number(cls) * 10 + sex, anims);
}
for (const mon of Object.values(data.monsters)) requireSprite(mon.gfx, monsterAnims);
const playable = new Set([...data.commonSpells, ...Object.values(data.classSpells).flat()]);
const queued = [...playable];
const seenMonsters = new Set();
while (queued.length) {
  const id = queued.shift();
  const spell = data.spells[id];
  if (!spell) continue;
  if (spell.sprite > 0) fxIds.add(spell.sprite);
  for (const lv of spell.levels || []) {
    if (!lv) continue;
    for (const e of [...lv.effects, ...lv.critical]) {
      if (e.id === 149 && e.special > 0) requireSprite(e.special, ['static']);
      if ([400, 401, 402].includes(e.id) && !playable.has(e.min)) { playable.add(e.min); queued.push(e.min); }
      if ([181, 185, 405].includes(e.id) && !seenMonsters.has(e.min)) {
        seenMonsters.add(e.min);
        const mon = data.monsters[e.min];
        for (const grade of mon?.grades || []) for (const [sid] of grade.spells || []) {
          if (!playable.has(sid)) { playable.add(sid); queued.push(sid); }
        }
      }
    }
  }
}

(async () => {
  const { browser, page } = await open();
  page.setDefaultTimeout(0);
  let wrote = 0, unavailable = 0;
  try {
    if (mode !== 'fx') {
      for (const [gfx, anims] of [...required].sort((a, b) => a[0] - b[0])) {
        const source = path.join(client, `clips/sprites/${gfx}.swf`);
        if (!fs.existsSync(source)) { console.error(`SWF ausente: ${source}`); unavailable++; continue; }
        const metaFile = path.join(out, `sprites/${gfx}.json`);
        const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
        let changed = false;
        for (const anim of anims) for (const dir of ['R', 'L']) {
          const name = anim + dir;
          const target = path.join(out, `sprites/${gfx}/${name}.webp`);
          if (!process.env.FORCE && meta[name] && fs.existsSync(target)) continue;
          const result = await page.evaluate(([g, a]) => R.sheet(`clips/sprites/${g}.swf`, a, { scale: 2, size: 640, q: 0.88 }), [gfx, name]).catch(() => null);
          if (!result || result.empty || !result.data) { unavailable++; continue; }
          saveDataUrl(target, result.data);
          delete result.data;
          meta[name] = result;
          changed = true;
          wrote++;
        }
        if (changed) { fs.mkdirSync(path.dirname(metaFile), { recursive: true }); fs.writeFileSync(metaFile, JSON.stringify(meta)); }
        await page.evaluate((g) => R.unload(`clips/sprites/${g}.swf`), gfx);
      }
    }
    if (mode !== 'sprites') {
      const indexFile = path.join(out, 'fx/index.json');
      const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
      for (const id of [...fxIds].sort((a, b) => a - b)) {
        const target = path.join(out, `fx/${id}.webp`);
        if (!process.env.FORCE && index[id] && fs.existsSync(target)) continue;
        const source = path.join(client, `clips/spells/${id}.swf`);
        if (!fs.existsSync(source)) { console.error(`SWF ausente: ${source}`); unavailable++; continue; }
        const result = await page.evaluate(async (n) => {
          const url = `clips/spells/${n}.swf`;
          const opts = { scale: 2, size: 768, maxFrames: 150, trimEnd: true, q: 0.85 };
          let sheet = await R.sheet(url, 0, opts);
          if (sheet && !sheet.empty && sheet.data) return sheet;
          // Some client SWFs draw from a named export instead of the root timeline.
          const info = await R.describe(url);
          const names = Object.keys(info?.exports || {});
          const priority = ['shoot', 'effet', 'tige', 'duplicate', 'duplic', 'sol', 'flam', 'etoiles', 'spire', 'frag', 'move'];
          names.sort((a, b) => {
            const ai = priority.indexOf(a), bi = priority.indexOf(b);
            return (ai < 0 ? priority.length : ai) - (bi < 0 ? priority.length : bi)
              || (info.exports[b] || 0) - (info.exports[a] || 0);
          });
          for (const name of names) {
            sheet = await R.sheet(url, name, opts);
            if (sheet && !sheet.empty && sheet.data) return { ...sheet, source: name };
          }
          // The remaining SWFs place the animation only in an internal sprite.
          const swf = await R.ready(url);
          const internals = [...swf.dict.entries()]
            .filter(([key, value]) => key !== 0 && value.type === 'sprite' && value.frames.length > 1)
            .sort((a, b) => b[1].frames.length - a[1].frames.length);
          for (const [key] of internals) {
            sheet = await R.sheet(url, key, opts);
            if (sheet && !sheet.empty && sheet.data) return { ...sheet, source: `symbol:${key}` };
          }
          return sheet;
        }, id).catch(() => null);
        if (!result || result.empty || !result.data) { unavailable++; continue; }
        if (result.source) console.log(`FX ${id}: símbolo ${result.source}`);
        saveDataUrl(target, result.data);
        delete result.data;
        index[id] = result;
        fs.writeFileSync(indexFile, JSON.stringify(index));
        await page.evaluate((n) => R.unload(`clips/spells/${n}.swf`), id);
        wrote++;
      }
    }
  } finally { await browser.close(); }
  console.log(`Arquivos gerados: ${wrote}; tentativas sem imagem: ${unavailable}`);
  const audit = spawnSync(process.execPath, [path.join(root, 'server/test/audit.mjs'), '--strict-assets'], { encoding: 'utf8' });
  if (audit.status !== 0) {
    process.stderr.write(audit.stdout || audit.stderr || 'Auditoria de assets falhou\n');
    process.exitCode = 1;
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
