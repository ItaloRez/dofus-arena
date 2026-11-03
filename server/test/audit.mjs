// Inventory the 1.29 combat data against the effect engine and exported art.
// node test/audit.mjs [--json] [--strict|--strict-mechanics|--strict-assets]
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EFFECT_STATS } from '../src/game/stats.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gameBytes = fs.readFileSync(path.join(server, 'data/game.json'));
const data = JSON.parse(gameBytes.toString('utf8'));
const dataSha256 = createHash('sha256').update(gameBytes).digest('hex');
const engine = fs.readFileSync(path.join(server, 'src/game/fight.js'), 'utf8');
const assets = path.join(server, 'public/assets');
const exists = (p) => fs.existsSync(path.join(assets, p));
const sorted = (xs) => [...xs].sort((a, b) => Number(a) - Number(b));

function engineIds() {
  const ids = new Set(Object.keys(EFFECT_STATS).map(Number).filter((id) => id !== 110));
  for (const name of ['DAMAGE', 'STEAL', 'PERCENT_LIFE', 'STEAL_STAT']) {
    const body = engine.match(new RegExp(`const ${name} = \\{([^}]+)\\};`))?.[1];
    if (!body) throw new Error(`Não foi possível ler o mapa ${name} do motor`);
    for (const [, id] of body.matchAll(/(\d+)\s*:/g)) ids.add(Number(id));
  }
  const body = engine.split('  applyEffect(caster, e, cell, targets, cells, ctx) {')[1]?.split('  statEffect(caster, e, targets, forEach) {')[0];
  if (!body) throw new Error('Não foi possível localizar applyEffect');
  for (const [, id] of body.matchAll(/case (-?\d+):/g)) ids.add(Number(id));
  return ids;
}

function inventory() {
  const playable = new Set([...data.commonSpells, ...Object.values(data.classSpells).flat()]);
  const spellIds = new Set(playable);
  const monsterIds = new Set();
  const queue = [...spellIds];
  const missingDefinitions = [];
  while (queue.length) {
    const sid = queue.shift();
    const spell = data.spells[sid];
    if (!spell) { missingDefinitions.push({ kind: 'spell', id: sid }); continue; }
    for (const lv of spell.levels || []) {
      if (!lv) continue;
      for (const e of [...lv.effects, ...lv.critical]) {
        if ([400, 401, 402].includes(e.id) && !spellIds.has(e.min)) {
          spellIds.add(e.min); queue.push(e.min);
        }
        if ([181, 185, 405].includes(e.id) && !monsterIds.has(e.min)) {
          monsterIds.add(e.min);
          const mon = data.monsters[e.min];
          if (!mon) { missingDefinitions.push({ kind: 'monster', id: e.min, spell: sid }); continue; }
          for (const grade of mon.grades || []) for (const [msid] of grade.spells || []) {
            if (!spellIds.has(msid)) { spellIds.add(msid); queue.push(msid); }
          }
        }
      }
    }
  }

  const refs = new Map();
  const looks = new Map();
  const fx = new Map();
  for (const sid of spellIds) {
    const sp = data.spells[sid];
    if (!sp) continue;
    if (sp.sprite > 0) {
      if (!fx.has(sp.sprite)) fx.set(sp.sprite, new Set());
      fx.get(sp.sprite).add(sid);
    }
    for (const [level, lv] of (sp.levels || []).entries()) {
      if (!lv) continue;
      for (const [variant, effects] of [['normal', lv.effects], ['critical', lv.critical]]) {
        for (const e of effects) {
          if (!refs.has(e.id)) refs.set(e.id, []);
          refs.get(e.id).push({ spell: sid, name: sp.name, level: level + 1, variant, chance: e.chance });
          if (e.id === 149 && e.special > 0) {
            if (!looks.has(e.special)) looks.set(e.special, new Set());
            looks.get(e.special).add(sid);
          }
        }
      }
    }
  }
  // Effect 666 is an explicit no-op branch in chance groups (Xelor and Ecaflip).
  // Verify each group contains a real alternative and totals 100%.
  const noOp666Valid = (refs.get(666) || []).every((r) => {
    const sp = data.spells[r.spell];
    const lv = sp?.levels?.[r.level - 1];
    const group = r.variant === 'critical' ? lv?.critical : lv?.effects;
    const random = group?.filter((e) => e.chance > 0) || [];
    return r.chance > 0 && random.some((e) => e.id !== 666) && random.reduce((n, e) => n + e.chance, 0) === 100;
  });
  const implemented = engineIds();
  const unsupported = sorted(refs.keys()).filter((id) => !implemented.has(id) && !(id === 666 && noOp666Valid)).map((id) => ({
    id, spells: sorted(new Set(refs.get(id).map((r) => r.spell))).map((sid) => ({ id: sid, name: data.spells[sid]?.name })),
    occurrences: refs.get(id).length,
  }));

  const neededGfx = new Map();
  const needGfx = (gfx, reason) => {
    if (!gfx || gfx < 0) return;
    if (!neededGfx.has(gfx)) neededGfx.set(gfx, new Set());
    neededGfx.get(gfx).add(reason);
  };
  for (const [cls] of Object.entries(data.classSpells)) for (const sex of [0, 1]) needGfx(Number(cls) * 10 + sex, `classe ${cls}`);
  for (const mid of monsterIds) needGfx(data.monsters[mid]?.gfx, `invocação ${mid}`);
  for (const [gfx, sids] of looks) for (const sid of sids) needGfx(gfx, `transformação ${sid}`);
  const missingSprites = [];
  const brokenSheets = [];
  for (const [gfx, reasons] of neededGfx) {
    const rel = `sprites/${gfx}.json`;
    if (!exists(rel)) { missingSprites.push({ gfx, reasons: [...reasons] }); continue; }
    let meta;
    try { meta = JSON.parse(fs.readFileSync(path.join(assets, rel), 'utf8')); }
    catch { brokenSheets.push({ gfx, animation: '*', reason: 'metadados inválidos' }); continue; }
    if (!meta.staticR && !meta.staticL) brokenSheets.push({ gfx, animation: 'static', reason: 'pose inicial ausente' });
    for (const [anim, m] of Object.entries(meta)) {
      if (!m || !Number.isInteger(m.frames) || m.frames < 1 || !Number.isInteger(m.cols) || m.cols < 1 || !exists(`sprites/${gfx}/${anim}.webp`)) {
        brokenSheets.push({ gfx, animation: anim, reason: 'metadados ou arquivo ausente' });
      }
    }
  }
  const missingAnimations = [];
  for (const [cls, sids] of Object.entries(data.classSpells)) for (const sex of [0, 1]) {
    const gfx = Number(cls) * 10 + sex;
    if (!exists(`sprites/${gfx}.json`)) continue;
    const meta = JSON.parse(fs.readFileSync(path.join(assets, `sprites/${gfx}.json`), 'utf8'));
    const anims = new Map();
    for (const sid of sids) {
      const n = data.spells[sid]?.spriteInfo?.[1];
      if (Number.isInteger(n) && n >= 0) {
        if (!anims.has(n)) anims.set(n, new Set());
        anims.get(n).add(sid);
      }
    }
    for (const [n, ids] of anims) if (!meta[`anim${n}R`] && !meta[`anim${n}L`]) {
      missingAnimations.push({ gfx, animation: `anim${n}`, spells: sorted(ids) });
    }
  }
  const missingFx = sorted(fx.keys()).filter((id) => !exists(`fx/${id}.webp`)).map((id) => ({ id, spells: sorted(fx.get(id)) }));
  const missingIcons = sorted(playable).filter((id) => id !== 0 && !exists(`spells/${id}.png`));
  return {
    source: { gameJsonSha256: dataSha256 },
    counts: { playableSpells: playable.size, reachableSpells: spellIds.size, effectIds: refs.size, spriteGfx: neededGfx.size, fxIds: fx.size },
    mechanics: { unsupported, invalidNoOp666: !noOp666Valid, missingDefinitions },
    assets: { missingSprites, missingAnimations, brokenSheets, missingFx, missingIcons },
  };
}

const report = inventory();
const args = new Set(process.argv.slice(2));
if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Feitiços: ${report.counts.playableSpells} jogáveis, ${report.counts.reachableSpells} alcançáveis; ${report.counts.effectIds} IDs de efeito.`);
  console.log(`Efeitos sem tratamento: ${report.mechanics.unsupported.length}`);
  if (!args.has('--strict-assets')) for (const e of report.mechanics.unsupported) console.log(`  ${e.id}: ${e.spells.map((s) => `${s.id} ${s.name}`).join(', ')}`);
  console.log(`Sprites ausentes: ${report.assets.missingSprites.length}; animações ausentes: ${report.assets.missingAnimations.length}; folhas quebradas: ${report.assets.brokenSheets.length}; efeitos visuais ausentes: ${report.assets.missingFx.length}; ícones ausentes: ${report.assets.missingIcons.length}.`);
  if (!args.has('--strict-mechanics')) {
    for (const s of report.assets.missingSprites) console.log(`  sprite ${s.gfx}: ${s.reasons.join(', ')}`);
    for (const a of report.assets.missingAnimations) console.log(`  ${a.gfx}/${a.animation}: feitiços ${a.spells.join(', ')}`);
    if (report.assets.missingFx.length) console.log(`  FX ausentes: ${report.assets.missingFx.map((x) => x.id).join(', ')}`);
  }
}
const mechanicErrors = report.mechanics.unsupported.length + report.mechanics.missingDefinitions.length + Number(report.mechanics.invalidNoOp666);
const assetErrors = Object.values(report.assets).reduce((n, arr) => n + arr.length, 0);
if ((args.has('--strict') && mechanicErrors + assetErrors) || (args.has('--strict-mechanics') && mechanicErrors) || (args.has('--strict-assets') && assetErrors)) process.exitCode = 1;
