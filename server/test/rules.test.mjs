import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Fight } from '../src/game/fight.js';
import { randomMap } from '../src/game/maps.js';
import { emptyBuild } from '../src/game/stats.js';

const data = JSON.parse(fs.readFileSync(new URL('../data/game.json', import.meta.url), 'utf8'));
function fixture(cls = 10) {
  const build = emptyBuild(cls);
  for (const id of data.classSpells[cls]) build.spells[id] = 6;
  const fight = new Fight({ id: 1, mode: '1v1', map: randomMap(0), teams: [
    [{ name: 'jogador', build }], [{ name: 'alvo', dummy: true, life: 10000 }],
  ], data, timers: false });
  fight.startFight();
  return { fight, caster: fight.fighters[0], target: fight.fighters[1] };
}

test('resistência percentual de PvP para em 50% e a fixa entra depois', () => {
  const { fight, caster, target } = fixture();
  caster.base.str = 100;
  caster.base.dmg = 5;
  target.base.rpE = 80;
  target.base.rfE = 5;
  const dealt = fight.damage(caster, target, 100, 'E', { boosted: true });
  assert.equal(dealt, 97);
  assert.equal(target.life, 9903);
});

test('limite por turno e recarga impedem o lançamento', () => {
  const { fight, caster } = fixture();
  const c = fight.castable(caster, 'spell', 197);
  caster.ap = 20;
  caster.cooldowns[197] = 2;
  assert.equal(fight.spellUsable(caster, c).type, 'cooldown');
  delete caster.cooldowns[197];
  caster.turnCasts[197] = c.lv.perTurn;
  if (c.lv.perTurn > 0) assert.equal(fight.spellUsable(caster, c).type, 'limit');
});

test('bônus temporário termina no turno do lançador', () => {
  const { fight, caster, target } = fixture();
  const before = fight.stat(target, 'str');
  const buff = fight.addBuff(caster, target, { id: 118, min: 20, max: -1, duration: 2 }, { kind: 'stat', stat: 'str', value: 20 });
  assert.equal(fight.stat(target, 'str'), before + 20);
  fight.startTurn(caster);
  assert.equal(buff.duration, 1);
  assert.equal(fight.stat(target, 'str'), before + 20);
  fight.startTurn(caster);
  assert.equal(fight.stat(target, 'str'), before);
});

test('ramo 666 representa o resultado sem bônus de PA da chance Xelor', () => {
  const { fight, caster } = fixture(5);
  const group = data.spells[81].levels[5].effects.filter((e) => e.chance > 0);
  assert.deepEqual(group.map((e) => [e.id, e.chance]), [[666, 90], [120, 10]]);
  const oldRandom = Math.random;
  try {
    caster.ap = 0;
    Math.random = () => 0;
    fight.applyEffects(caster, group, caster.cell, { spellId: 81 });
    assert.equal(caster.ap, 0);
    Math.random = () => 0.99;
    fight.applyEffects(caster, group, caster.cell, { spellId: 81 });
    assert.equal(caster.ap, 1);
  } finally { Math.random = oldRandom; }
});

test('crítico do soco no nível 3 causa dano neutro', () => {
  const { fight, caster, target } = fixture();
  const critical = data.spells[0].levels[2].critical[0];
  assert.equal(critical.id, -100);
  const before = target.life;
  fight.applyEffect(caster, critical, target.cell, [target], [target.cell], { spellId: 0 });
  assert.ok(target.life < before);
});

test('modo estrito falha em efeito de combate não implementado', () => {
  const { fight, caster } = fixture();
  const old = process.env.STRICT_EFFECTS;
  try {
    process.env.STRICT_EFFECTS = '1';
    assert.throws(() => fight.applyEffect(caster, { id: 99999, area: 'Pa' }, caster.cell, [caster], [caster.cell], { spellId: 1 }), /99999/);
  } finally {
    if (old === undefined) delete process.env.STRICT_EFFECTS;
    else process.env.STRICT_EFFECTS = old;
  }
});

test('Poder Silvestre reduz dano físico e mágico com seus dois efeitos', () => {
  const { fight, caster, target } = fixture();
  const spell = data.spells[197].levels[5];
  fight.applyEffects(caster, spell.effects, caster.cell, { spellId: 197 });
  assert.equal(fight.stat(caster, 'rfPhys'), 1000);
  assert.equal(fight.stat(caster, 'rfMagic'), 1000);
  const before = caster.life;
  assert.equal(fight.damage(target, caster, 100, 'E'), 0);
  assert.equal(fight.damage(target, caster, 100, 'F'), 0);
  assert.equal(caster.life, before);
});

test('efeito 122 aumenta a chance de falha crítica', () => {
  const { fight, caster, target } = fixture(12);
  const effect = data.spells[698].levels[5].critical.find((e) => e.id === 122);
  const before = fight.stat(target, 'fail');
  fight.applyEffect(caster, effect, target.cell, [target], [target.cell], { spellId: 698 });
  assert.equal(fight.stat(target, 'fail'), before + 15);
});

test('dano permanente básico é 10% e o castigo adiciona 5% enquanto ativo', () => {
  const { fight, caster, target } = fixture(11);
  const before = caster.maxLife;
  fight.damage(target, caster, 100, 'N', { raw: true });
  assert.equal(caster.maxLife, before - 10);
  const effect = data.spells[431].levels[5].effects.find((e) => e.id === 776);
  fight.applyEffect(caster, effect, caster.cell, [caster], [caster.cell], { spellId: 431 });
  const buff = caster.buffs.find((b) => b.kind === 'erosion');
  assert.equal(buff.value, 5);
  fight.damage(target, caster, 100, 'N', { raw: true });
  assert.equal(caster.maxLife, before - 25);
  fight.removeBuff(caster, buff);
  fight.damage(target, caster, 100, 'N', { raw: true });
  assert.equal(caster.maxLife, before - 35);
});

// ---------------------------------------------------------------- special and common spells added from the 1.29 data

test('Brokle maximiza e Poisse minimiza os dados do alvo', () => {
  const { fight, caster } = fixture();
  const e = { id: 97, min: 10, max: 20, special: -1, duration: 0 };
  fight.addBuff(caster, caster, { id: 782, min: -1, max: -1, duration: 2 }, { kind: 'maxRoll' });
  const target = fight.fighters[1];
  target.base.rpE = 0; target.base.rfE = 0; caster.base.str = 0; caster.base.pdmg = 0; caster.base.dmg = 0;
  const life = target.life;
  fight.applyEffects(caster, [{ ...e, area: 'Pa', target: 0 }], target.cell, {});
  assert.equal(life - target.life, 20);
  const t = fixture();
  t.fight.addBuff(t.caster, t.target, { id: 781, min: -1, max: -1, duration: 2 }, { kind: 'minRoll' });
  t.target.base.str = 0; t.target.base.pdmg = 0; t.target.base.dmg = 0;
  t.caster.base.rpE = 0; t.caster.base.rfE = 0;
  const before = t.caster.life;
  t.fight.applyEffects(t.target, [{ id: 97, min: 10, max: 20, special: -1, duration: 0, area: 'Pa', target: 0 }], t.caster.cell, {});
  assert.equal(before - t.caster.life, 10);
});

test('Laisse Spirituelle traz de volta o último aliado morto e ele morre junto com o Osamodas', () => {
  const build = emptyBuild(2); for (const id of data.classSpells[2]) build.spells[id] = 6;
  const b2 = emptyBuild(8);
  const fight = new Fight({ id: 1, mode: '3v3', map: randomMap(0), teams: [
    [{ name: 'osa', build }, { name: 'iop', build: b2 }], [{ name: 'alvo', dummy: true, life: 10000 }],
  ], data, timers: false });
  fight.startFight();
  const [osa, iop] = fight.fighters;
  fight.kill(iop, osa);
  assert.ok(iop.dead);
  const free = fight.map.neighbors(osa.cell).find(c => fight.map.cells[c].walk && !fight.at(c));
  fight.applyEffects(osa, data.spells[420].levels[5].effects, free, { spellId: 420 });
  assert.equal(iop.dead, false);
  assert.equal(iop.cell, free);
  assert.equal(iop.life, Math.floor(iop.maxLife * 60 / 100));
  fight.kill(osa, osa);
  assert.ok(iop.dead);
});

test('Raulebaque devolve todos às posições iniciais', () => {
  const { fight, caster, target } = fixture(5);
  const start = [caster.startCell, target.startCell];
  const free = fight.map.cells.find(c => c.walk && !fight.at(c.id) && c.id !== caster.cell).id;
  caster.cell = free;
  fight.applyEffects(caster, data.spells[424].levels[5].effects, caster.cell, { spellId: 424 });
  assert.deepEqual([caster.cell, target.cell], start);
});

test('Mot Lotof faz o alvo explodir no começo do turno dele', () => {
  const { fight, caster, target } = fixture(7);
  fight.applyEffects(caster, data.spells[427].levels[5].effects, target.cell, { spellId: 427 });
  assert.ok(target.buffs.some(b => b.kind === 'turnSpell'));
  target.static = false;
  const before = target.life;
  fight.startTurn(target);
  assert.ok(!target.buffs.some(b => b.kind === 'turnSpell'));
  assert.ok(target.life < before, 'the bomb hurts its bearer');
});

test('Árvore da Vida cura todos quando sofre dano', () => {
  const { fight, caster, target } = fixture(10);
  caster.life = caster.maxLife - 500;
  fight.addBuff(caster, target, { id: 786, min: -1, max: -1, special: 100, duration: 1 }, { kind: 'healOnHit', value: 100, duration: -1 });
  const before = caster.life;
  fight.damage(caster, target, 100, 'N', { raw: true });
  assert.equal(caster.life, before + 100);
});

test('feitiços comuns só entram na luta quando aprendidos na build', () => {
  const build = emptyBuild(8); build.spells[350] = 3;
  const fight = new Fight({ id: 1, mode: '1v1', map: randomMap(0), teams: [[{ name: 'a', build }], [{ name: 'b', dummy: true }]], data, timers: false });
  const ids = fight.fighters[0].spells.map(s => s.id);
  assert.ok(ids.includes(350));
  assert.ok(!ids.includes(364));
  assert.ok(ids.includes(410) && ids.includes(1908), 'Iop special spell (Brokle) and Dopple');
});

test('feitiço especial de cada classe (pergaminhos de sort spécial, condição PG=classe)', () => {
  // 1 Feca Mise en garde, 2 Osa Laisse spirituelle, 3 Enu Retraite anticipée, 4 Sram Poisse, 5 Xelor Raulebaque,
  // 6 Eca Félintion, 7 Eni Mot Lotof, 8 Iop Brokle, 9 Cra Flèche de dispersion, 10 Sadi Arbre de vie,
  // 11 Sacri Douleur partagée, 12 Panda Ivresse
  const SPECIAL = { 1: 422, 2: 420, 3: 425, 4: 416, 5: 424, 6: 412, 7: 427, 8: 410, 9: 418, 10: 426, 11: 421, 12: 423 };
  const all = new Set(Object.values(SPECIAL));
  for (const [cls, sid] of Object.entries(SPECIAL)) {
    const list = data.classSpells[cls];
    assert.ok(list.includes(sid), `classe ${cls} tem ${sid}`);
    assert.equal(list.filter(id => all.has(id)).length, 1, `classe ${cls} tem um só especial`);
  }
});

// ---------------------------------------------------------------- Goultarminator arenas

test('os mapas de PvP são as arenas do Goultarminador e são simétricos', async () => {
  const { POOLS } = await import('../src/game/maps.js');
  const { checkSymmetry } = await import('../src/game/symmetry.js');
  assert.ok(POOLS.pvp.length >= 1);
  for (const def of POOLS.pvp) {
    assert.ok(def.id >= 12223 && def.id <= 12230, `map ${def.id} is a Goultarminator arena`);
    const r = checkSymmetry(def);
    assert.ok(r.ok, `map ${def.id} symmetric`);
    assert.equal(r.best.walkMismatch, 0);
    assert.equal(r.best.losMismatch, 0);
    assert.ok(r.best.placesOk);
  }
});

test('a verificação de simetria recusa um mapa com obstáculo de um lado só', async () => {
  const { POOLS } = await import('../src/game/maps.js');
  const { checkSymmetry } = await import('../src/game/symmetry.js');
  const def = JSON.parse(JSON.stringify(POOLS.pvp[0]));
  const walk = def.cells.map((c, i) => [c, i]).filter(([c]) => c[0] && c[2] > 1);
  const [c] = walk[Math.floor(walk.length / 3)];
  c[2] = 0; c[1] = 0; // a new pillar on one side
  assert.equal(checkSymmetry(def).ok, false);
  const moved = JSON.parse(JSON.stringify(POOLS.pvp[0]));
  moved.places[1] = moved.places[1].slice(1).concat(walk[0][1]);
  const r = checkSymmetry(moved);
  assert.ok(!r.best || !r.best.placesOk, 'start cells that do not mirror are detected');
});

test('layout da barra de feitiços (2 páginas) é validado e guardado na luta', () => {
  const build = emptyBuild(3);
  build.spellSlots = { 51: 25, 43: 25, 99999: 3, 41: 40, 42: 0 };
  const fight = new Fight({ id: 1, mode: '1v1', map: randomMap(0), teams: [[{ name: 'a', build }], [{ name: 'b', dummy: true }]], data, timers: false });
  const f = fight.fighters[0];
  assert.deepEqual(f.slots, { 42: 0, 43: 25 }, 'uma magia por lugar, só ids conhecidos, lugares 0-39');
  const r = fight.setSpellOrder(f.id, [43, 51], { 43: 2, 51: 21 });
  assert.deepEqual(r.slots, { 43: 2, 51: 21 });
  assert.equal(f.spells[0].id, 43);
});

test('Sram invisível: aliados recebem o caminho, inimigos só sabem que ele andou', async () => {
  const { filterEvents } = await import('../src/game/fight.js');
  const { fight, caster, target } = fixture(4);
  fight.addBuff(caster, caster, { id: 150, min: 0, max: 0, duration: 3 }, { kind: 'invis' });
  // a free cell two steps away, not next to the dummy (so the walk is not cut)
  const from = caster.cell;
  const to = fight.map.cells.map((_, i) => i).find((c) => fight.map.dist(from, c) === 2 && fight.map.cells[c].walk && !fight.at(c)
    && fight.map.dist(c, target.cell) > 1 && fight.path(caster, c)?.length === 3);
  let sent = null;
  fight.onUpdate = (_, events) => { sent = events; };
  while (fight.current().id !== caster.id) fight.passTurn(fight.current().id);
  caster.mp = 3;
  const r = fight.move(caster.id, to);
  assert.equal(r.ok, true);
  const mv = sent.find((e) => e.type === 'move');
  assert.equal(mv.hidden, true);
  const mine = filterEvents(sent, caster.team, fight).find((e) => e.type === 'move');
  assert.equal(mine.path.length, 3);
  assert.equal(mine.path.at(-1), to);
  const theirs = filterEvents(sent, 1 - caster.team, fight).find((e) => e.type === 'move');
  assert.deepEqual(theirs, { type: 'move', id: caster.id, hidden: true });
  // a push or teleport while invisible: allies get the cell, enemies get nothing
  fight.events = [];
  fight.emit({ type: 'tp', id: caster.id, cell: to });
  assert.equal(filterEvents(fight.events, caster.team, fight).length, 1);
  assert.equal(filterEvents(fight.events, 1 - caster.team, fight).length, 0);
  // the enemy state does not carry the cell either
  assert.equal(fight.view(1 - caster.team).fighters.find((f) => f.id === caster.id).cell, -1);
  assert.equal(fight.view(caster.team).fighters.find((f) => f.id === caster.id).cell, to);
});
