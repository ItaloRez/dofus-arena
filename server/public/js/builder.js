// Build editor: class, characteristics, spells, gear and consumables
import {
  CLASSES, BASE_STATS, STAT_POINTS, SPELL_POINTS, MAX_SCROLL, SLOTS, MAX_CONSUMABLES,
  pointsFor, spellPointsFor, computeStats, itemStats, emptyBuild, orderSpellIds,
} from '/game/stats.js';
import { $, h, esc, toast, clsBadge, effectText, spellIcon, itemStatsHtml, itemIconHtml } from './ui.js';
import { S, api, showLobby } from './app.js';

const SLOT_NAMES = {
  amulet: 'Amuleto', ring1: 'Anel 1', ring2: 'Anel 2', belt: 'Cinto', boots: 'Botas', hat: 'Chapéu', cape: 'Capa',
  weapon: 'Arma', shield: 'Escudo', pet: 'Mascote', dofus1: 'Dofus 1', dofus2: 'Dofus 2', dofus3: 'Dofus 3',
  dofus4: 'Dofus 4', dofus5: 'Dofus 5', dofus6: 'Dofus 6',
};
const SUMMARY = ['ap', 'mp', 'range', 'summons', 'init', 'vit', 'wis', 'str', 'int', 'cha', 'agi', 'dmg', 'pdmg', 'crit', 'heal',
  'trap', 'ptrap', 'reflect', 'dodgeAP', 'dodgeMP', 'rpN', 'rpE', 'rpF', 'rpW', 'rpA', 'rfN', 'rfE', 'rfF', 'rfW', 'rfA'];

let B = null; // build being edited
let tab = 'stats';

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function statSpent() { return BASE_STATS.reduce((s, k) => s + pointsFor(B.cls, k, B.stats[k]), 0); }
function spellSpent() { return Object.values(B.spells).reduce((s, l) => s + spellPointsFor(l), 0); }

function resetSpells() {
  B.spells = {};
  B.spellOrder = [];
  for (const id of S.data.classSpells[B.cls]) B.spells[id] = 1;
}

export function openBuilder(build) {
  S.view = 'builder';
  B = build ? clone(build) : emptyBuild(8);
  if (!build) { B.name = 'Nova build'; resetSpells(); }
  for (const id of S.data.classSpells[B.cls]) if (!B.spells[id]) B.spells[id] = 1;
  tab = 'stats';
  render();
}

function render() {
  const el = h(`<div>
    <div class="topbar"><div class="brand">Arena 1.29</div><span class="pill">Editor de build</span>
      <div class="who"><button class="btn secondary" id="back">Voltar</button></div></div>
    <div class="builder">
      <div class="panel">
        <div class="class-pick">${Object.keys(CLASSES).map(c => `<button data-cls="${c}" class="${Number(c) === B.cls ? 'on' : ''}" title="${CLASSES[c].name}">${clsBadge(Number(c), '', B.sex)}</button>`).join('')}
          <span class="sex-pick"><button data-sex="0" class="${!B.sex ? 'on' : ''}" title="Masculino">♂</button><button data-sex="1" class="${B.sex ? 'on' : ''}" title="Feminino">♀</button></span></div>
        <div class="row" style="flex-wrap:wrap;margin-bottom:10px">
          <input class="inp grow" id="bname" maxlength="40" value="${esc(B.name)}" placeholder="Nome da build">
          <button class="btn secondary" id="suggest" title="Monta uma build automática para esta classe">Sugerir build</button>
          ${B.id ? '<button class="btn secondary" id="dup">Duplicar</button><button class="btn danger" id="del">Excluir</button>' : ''}
          <button class="btn" id="save">Salvar</button>
        </div>
        <div class="btabs">${[['stats', 'Características'], ['spells', 'Feitiços'], ['gear', 'Equipamentos']]
          .map(([k, n]) => `<button data-tab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <div id="tabc"></div>
      </div>
      <div class="panel summary" id="summary"></div>
    </div></div>`);
  document.getElementById('app').replaceChildren(el);
  $('#back', el).onclick = () => showLobby();
  $('#bname', el).oninput = (e) => { B.name = e.target.value; };
  el.querySelectorAll('[data-cls]').forEach(b => b.onclick = () => {
    const cls = Number(b.dataset.cls);
    if (cls === B.cls) return;
    B.cls = cls;
    for (const k of BASE_STATS) B.stats[k] = 0;
    resetSpells();
    render();
  });
  el.querySelectorAll('[data-sex]').forEach(b => b.onclick = () => { B.sex = Number(b.dataset.sex); render(); });
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; render(); });
  $('#suggest', el).onclick = async () => {
    const r = await api('/api/suggest?cls=' + B.cls);
    const keep = { id: B.id, name: B.name === 'Nova build' ? r.build.name : B.name };
    B = { ...r.build, ...keep };
    if (!B.id) delete B.id;
    render();
    toast('Build sugerida aplicada. Ajuste e salve.');
  };
  $('#save', el).onclick = save;
  if (B.id) {
    $('#del', el).onclick = async () => {
      if (!confirm('Excluir esta build?')) return;
      await api('/api/builds/' + B.id, { method: 'DELETE' });
      showLobby();
    };
    $('#dup', el).onclick = () => { delete B.id; B.name += ' (cópia)'; render(); toast('Cópia criada. Salve para guardar.'); };
  }
  renderTab();
  renderSummary();
}

async function save() {
  try {
    const r = await api('/api/builds', { body: B });
    B = r.build;
    S.selectedBuild = B.id;
    try { localStorage.setItem('build', B.id); } catch {}
    toast('Build salva');
    render();
  } catch (e) { toast(e.message); }
}

function renderTab() {
  const box = $('#tabc');
  if (tab === 'stats') return statsTab(box);
  if (tab === 'spells') return spellsTab(box);
  if (tab === 'gear') return gearTab(box);
  return consTab(box);
}

// ---------------------------------------------------------------- characteristics

const STAT_NAMES = { vit: 'Vitalidade', wis: 'Sabedoria', str: 'Força', int: 'Inteligência', cha: 'Sorte', agi: 'Agilidade' };

function statsTab(box) {
  const spent = statSpent();
  const left = STAT_POINTS - spent;
  box.innerHTML = `<div class="points ${left < 0 ? 'over' : ''}">Pontos disponíveis: ${left} / ${STAT_POINTS}</div>
    <p class="muted" style="margin-top:0">O custo por ponto sobe conforme o valor, seguindo a tabela da classe. Pergaminhos dão até ${MAX_SCROLL} pontos grátis em cada característica.</p>
    ${BASE_STATS.map(k => `<div class="stat-row">
      <div><b>${STAT_NAMES[k]}</b></div>
      <div class="val">${B.stats[k]}</div>
      <div class="btns">
        <button data-k="${k}" data-d="-100">-100</button><button data-k="${k}" data-d="-10">-10</button><button data-k="${k}" data-d="-1">-1</button>
        <button data-k="${k}" data-d="1">+1</button><button data-k="${k}" data-d="10">+10</button><button data-k="${k}" data-d="100">+100</button>
        <button data-k="${k}" data-d="max">Máx</button><button data-k="${k}" data-d="zero">0</button>
      </div>
      <label class="muted" style="font-size:12px">Perg. <input type="number" min="0" max="${MAX_SCROLL}" data-scroll="${k}" value="${B.scrolls[k]}"></label>
    </div>`).join('')}
    <p class="muted" style="font-size:13px">Custo do próximo ponto: ${BASE_STATS.map(k => `${STAT_NAMES[k]} ${pointsFor(B.cls, k, B.stats[k] + 1) - pointsFor(B.cls, k, B.stats[k])}`).join(' · ')}</p>`;
  box.querySelectorAll('[data-d]').forEach(b => b.onclick = () => {
    const k = b.dataset.k, d = b.dataset.d;
    const others = statSpent() - pointsFor(B.cls, k, B.stats[k]);
    if (d === 'zero') B.stats[k] = 0;
    else if (d === 'max') {
      let v = B.stats[k];
      while (others + pointsFor(B.cls, k, v + 1) <= STAT_POINTS) v++;
      B.stats[k] = v;
    } else {
      const n = Number(d);
      let v = Math.max(0, B.stats[k] + n);
      while (v > B.stats[k] && others + pointsFor(B.cls, k, v) > STAT_POINTS) v--;
      B.stats[k] = v;
    }
    statsTab(box);
    renderSummary();
  });
  box.querySelectorAll('[data-scroll]').forEach(i => i.onchange = () => {
    B.scrolls[i.dataset.scroll] = Math.max(0, Math.min(MAX_SCROLL, Number(i.value) || 0));
    renderSummary();
  });
}

// ---------------------------------------------------------------- spells

function spellDetails(sp, lvl) {
  const lv = sp.levels[lvl - 1];
  if (!lv) return '';
  const range = lv.minRange === lv.maxRange ? lv.maxRange : `${lv.minRange}-${lv.maxRange}`;
  const flags = [lv.boostRange ? '' : 'alcance fixo', lv.lineOnly ? 'em linha' : '', lv.los ? '' : 'sem linha de visão', lv.freeCell ? 'célula livre' : '',
    lv.perTurn ? `${lv.perTurn}x/turno` : '', lv.perTarget ? `${lv.perTarget}x/alvo` : '', lv.cooldown ? `recarga ${lv.cooldown} t` : ''].filter(Boolean).join(', ');
  return `<div class="effects"><b>${lv.ap} PA · alcance ${range}</b>${flags ? ' · ' + flags : ''}${lv.critRate ? ` · crítico 1/${lv.critRate}` : ''}
    ${lv.effects.map(e => `<span class="e">• ${effectText(e)}</span>`).join('')}
    ${lv.critical.length ? `<span class="e" style="color:#a0661c">Crítico: ${lv.critical.map(e => effectText(e)).join(', ')}</span>` : ''}</div>`;
}

function spellsTab(box) {
  const left = SPELL_POINTS - spellSpent();
  const ids = orderSpellIds(S.data.classSpells[B.cls].filter(id => S.data.spells[id]), B.spellOrder);
  const common = (S.data.commonSpells || []).filter(id => id && S.data.spells[id] && !ids.includes(id));
  box.innerHTML = `<div class="points ${left < 0 ? 'over' : ''}">Pontos de feitiço: ${left} / ${SPELL_POINTS}</div>
    <p class="muted" style="margin-top:0">Subir um feitiço do nível N para N+1 custa N pontos (nível 5 = 10 pontos, nível 6 = 15).
    Arraste os feitiços (⠿) para escolher a ordem da barra de luta: os 10 primeiros vão para as teclas 1 a 0, os 10 seguintes para Q a P.</p>
    <div class="spell-list">${ids.map((id, i) => {
      const sp = S.data.spells[id];
      const lvl = B.spells[id] || 1;
      return `<div class="spell-card" draggable="true" data-drag="${id}"><span class="drag" title="Arraste para mudar a ordem">⠿<small>${i + 1}</small></span>${spellIcon(sp)}<div class="grow"><b>${esc(sp.name)}</b>
        <div class="lv">${sp.levels.map((_, i) => {
          const cost = spellPointsFor(i + 1) - spellPointsFor(lvl);
          return `<button data-sp="${id}" data-l="${i + 1}" class="${i + 1 === lvl ? 'on' : ''}" ${cost > left ? 'disabled' : ''}>${i + 1}</button>`;
        }).join('')}</div>${spellDetails(sp, lvl)}</div></div>`;
    }).join('')}</div>
    <h3 style="margin:16px 0 4px">Feitiços comuns</h3>
    <p class="muted" style="margin-top:0">Feitiços que qualquer classe pode aprender. Escolha um nível para levá-lo à luta ("—" = não aprendido).</p>
    <div class="spell-list">${common.map(id => {
      const sp = S.data.spells[id];
      const lvl = B.spells[id] || 0;
      return `<div class="spell-card ${lvl ? '' : 'off'}">${spellIcon(sp)}<div class="grow"><b>${esc(sp.name)}</b>
        <div class="lv"><button data-sp="${id}" data-l="0" class="${lvl ? '' : 'on'}">—</button>${sp.levels.map((_, i) => {
          const cost = spellPointsFor(i + 1) - spellPointsFor(Math.max(lvl, 1));
          return `<button data-sp="${id}" data-l="${i + 1}" class="${i + 1 === lvl ? 'on' : ''}" ${cost > left ? 'disabled' : ''}>${i + 1}</button>`;
        }).join('')}</div>${spellDetails(sp, Math.max(lvl, 1))}</div></div>`;
    }).join('')}</div>`;
  box.querySelectorAll('[data-sp]').forEach(b => b.onclick = () => {
    const l = Number(b.dataset.l);
    if (l) B.spells[b.dataset.sp] = l; else delete B.spells[b.dataset.sp];
    spellsTab(box);
  });
  // drag and drop to reorder; the ids that are not class spells (fist...) keep their place in the saved order
  let from = null;
  box.querySelectorAll('[data-drag]').forEach(card => {
    card.ondragstart = (e) => { from = Number(card.dataset.drag); card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(from)); };
    card.ondragend = () => { card.classList.remove('dragging'); from = null; };
    card.ondragover = (e) => { if (from == null) return; e.preventDefault(); card.classList.add('over'); };
    card.ondragleave = () => card.classList.remove('over');
    card.ondrop = (e) => {
      e.preventDefault(); card.classList.remove('over');
      const to = Number(card.dataset.drag);
      if (from == null || from === to) return;
      const list = ids.filter(x => x !== from);
      list.splice(list.indexOf(to) + (ids.indexOf(from) < ids.indexOf(to) ? 1 : 0), 0, from);
      const others = (B.spellOrder || []).map(Number).filter(x => !ids.includes(x));
      B.spellOrder = [...list, ...others];
      spellsTab(box);
    };
  });
}

// ---------------------------------------------------------------- gear

function gearTab(box) {
  box.innerHTML = `<p class="muted" style="margin-top:0">Todos os itens vêm com os status no máximo. Clique num espaço para escolher.</p>
    <div class="slots">${Object.keys(SLOTS).map(slot => {
      const it = S.data.items[B.gear[slot]];
      return `<div class="slot" data-slot="${slot}"><div class="sl">${SLOT_NAMES[slot]}</div>
        ${it ? `${itemIconHtml(it, 'slot-icon')}<div class="it">${esc(it.name)}</div><div class="muted" style="font-size:12px">Nível ${it.level}${it.set ? ' · ' + esc(S.data.sets[it.set]?.name?.trim() || '') : ''}</div>` : '<div class="muted">Vazio</div>'}</div>`;
    }).join('')}</div>`;
  box.querySelectorAll('[data-slot]').forEach(s => s.onclick = () => pickItem(s.dataset.slot));
}

const SORTS = [['level', 'Nível'], ['vit', 'Vitalidade'], ['str', 'Força'], ['int', 'Inteligência'], ['cha', 'Sorte'], ['agi', 'Agilidade'], ['wis', 'Sabedoria'],
  ['ap', 'PA'], ['mp', 'PM'], ['range', 'Alcance'], ['dmg', 'Dano'], ['pdmg', '% Dano'], ['crit', 'Críticos'], ['heal', 'Curas'], ['summons', 'Invocações'],
  ['res', 'Resistências %']];

function pickItem(slot) {
  const types = SLOTS[slot];
  const all = Object.values(S.data.items).filter(i => types.includes(i.type) && i.level <= 200);
  let q = '', sort = 'level', minLv = 0;
  const m = h(`<div class="modal-bg"><div class="panel modal">
    <div class="row"><h2 class="grow">${SLOT_NAMES[slot]}</h2><button class="btn small danger" id="clear">Remover</button><button class="btn small secondary" id="close">Fechar</button></div>
    <div class="row" style="flex-wrap:wrap"><input class="inp grow" id="q" placeholder="Buscar pelo nome…">
      <select class="inp" id="sort">${SORTS.map(([k, n]) => `<option value="${k}">Ordenar: ${n}</option>`).join('')}</select>
      <select class="inp" id="minlv"><option value="0">Qualquer nível</option><option value="100">Nível 100+</option><option value="150">Nível 150+</option><option value="180">Nível 180+</option></select></div>
    <div class="list" id="list"></div></div></div>`);
  document.body.appendChild(m);
  const close = () => m.remove();
  m.onclick = (e) => { if (e.target === m) close(); };
  $('#close', m).onclick = close;
  $('#clear', m).onclick = () => { delete B.gear[slot]; close(); render(); };
  const score = (it) => {
    if (sort === 'level') return it.level;
    const st = itemStats(it);
    if (sort === 'res') return (st.rpN || 0) + (st.rpE || 0) + (st.rpF || 0) + (st.rpW || 0) + (st.rpA || 0);
    return st[sort] || 0;
  };
  const draw = () => {
    const ql = q.toLowerCase();
    const list = all.filter(i => i.level >= minLv && (!ql || i.name.toLowerCase().includes(ql)))
      .sort((a, b) => score(b) - score(a) || b.level - a.level).slice(0, 150);
    $('#list', m).innerHTML = list.map(it => `<div class="item-row" data-id="${it.id}">${itemIconHtml(it, 'row-icon')}<b>${esc(it.name)}</b> <span class="muted">nível ${it.level}${it.set ? ' · ' + esc(S.data.sets[it.set]?.name?.trim() || '') : ''}</span>
      <div class="st">${itemStatsHtml(it, itemStats)}</div></div>`).join('') || '<p class="muted">Nada encontrado</p>';
    m.querySelectorAll('.item-row').forEach(r => r.onclick = () => {
      const id = Number(r.dataset.id);
      const it = S.data.items[id];
      if (it.type === 23 || it.type === 9) {
        for (const [s, v] of Object.entries(B.gear)) if (v === id && s !== slot) { toast('Esse item já está equipado'); return; }
      }
      B.gear[slot] = id;
      if (it.weapon?.twoHands && B.gear.shield) { delete B.gear.shield; toast('Arma de duas mãos: escudo removido'); }
      if (slot === 'shield' && S.data.items[B.gear.weapon]?.weapon?.twoHands) { delete B.gear.weapon; toast('Escudo: arma de duas mãos removida'); }
      close();
      render();
    });
  };
  $('#q', m).oninput = (e) => { q = e.target.value; draw(); };
  $('#sort', m).onchange = (e) => { sort = e.target.value; draw(); };
  $('#minlv', m).onchange = (e) => { minLv = Number(e.target.value); draw(); };
  draw();
  $('#q', m).focus();
}

// ---------------------------------------------------------------- consumables

function consTab(box) {
  const list = S.data.consumables.map(id => S.data.items[id]).sort((a, b) => heal(b) - heal(a));
  box.innerHTML = `<p class="muted" style="margin-top:0">Até ${MAX_CONSUMABLES} consumíveis por luta. Cada um pode ser usado uma vez, custa 3 PA, e só um por turno. Regra própria desta arena.</p>
    <div class="slots">${list.map(it => `<div class="slot ${B.consumables.includes(it.id) ? 'on' : ''}" data-c="${it.id}" style="${B.consumables.includes(it.id) ? 'border:2px solid var(--accent);background:#ffe9c7' : ''}">
      ${itemIconHtml(it, 'slot-icon')}<div class="it">${esc(it.name)}</div><div class="muted" style="font-size:12px">Cura ${heal(it)} de vida</div></div>`).join('')}</div>`;
  box.querySelectorAll('[data-c]').forEach(s => s.onclick = () => {
    const id = Number(s.dataset.c);
    if (B.consumables.includes(id)) B.consumables = B.consumables.filter(x => x !== id);
    else if (B.consumables.length < MAX_CONSUMABLES) B.consumables.push(id);
    else return toast(`Máximo de ${MAX_CONSUMABLES}`);
    consTab(box);
  });
}
function heal(it) { return it.effects.filter(e => e[0] === 110).reduce((s, e) => s + e[2], 0); }

// ---------------------------------------------------------------- summary

function renderSummary() {
  const box = $('#summary');
  if (!box) return;
  const { stats, life, setBonus } = computeStats(B, S.data);
  const L = S.data.statLabels;
  box.innerHTML = `<h3>Resumo</h3>
    <div class="row" style="justify-content:space-between"><div><div class="muted">Vida</div><div class="big">${life}</div></div>
      <div><div class="muted">PA / PM</div><div class="big">${stats.ap} / ${stats.mp}</div></div>
      <div><div class="muted">Alcance</div><div class="big">+${stats.range}</div></div></div>
    <div class="grid2" style="margin-top:8px">${SUMMARY.filter(k => !['ap', 'mp', 'range'].includes(k)).map(k => `<div class="line"><span>${L[k]}</span><b>${stats[k]}</b></div>`).join('')}</div>
    ${setBonus.length ? `<h3 style="margin-top:10px">Bônus de panóplia</h3>${setBonus.map(s => `<div class="setb"><b>${esc(s.name.trim())}</b> (${s.count} itens): ${Object.entries(s.stats).map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${L[k]}`).join(', ')}</div>`).join('')}` : ''}
    <p class="muted" style="font-size:12px">Resistências % são limitadas a 50% em luta.</p>`;
}
