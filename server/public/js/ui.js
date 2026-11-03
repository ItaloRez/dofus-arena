// Shared UI helpers: DOM, effect descriptions, icons
export const $ = (sel, root = document) => root.querySelector(sel);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg) {
  const el = document.createElement('div');
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

export const ELEM_COLORS = { N: '#9a8f86', E: '#9b6a2f', F: '#e2512b', W: '#2f86d6', A: '#3fae5c' };
export const ELEM_NAMES = { N: 'neutro', E: 'terra', F: 'fogo', W: 'água', A: 'ar' };
const DMG = { 96: 'W', 97: 'E', 98: 'A', 99: 'F', 100: 'N' };
const STEAL = { 91: 'W', 92: 'E', 93: 'A', 94: 'F', 95: 'N' };
const PCT = { 85: 'W', 86: 'E', 87: 'A', 88: 'F', 89: 'N' };

let DATA = null;
export function setData(d) { DATA = d; }

export function clsColor(cls) { return DATA?.classes[cls]?.color || '#777'; }
export function clsName(cls) { return DATA?.classes[cls]?.name || 'Invocação'; }
export function clsBadge(cls, extra = '', sex = 0) {
  const n = clsName(cls);
  if (!DATA?.classes[cls]) return `<div class="cls-badge ${extra}" style="background:#7d6b55" title="${esc(n)}">?</div>`;
  return `<div class="cls-badge ${extra}" style="background:${clsColor(cls)}" title="${esc(n)}"><img src="/assets/classes/${cls * 10 + (sex ? 1 : 0)}.png" alt="${esc(n.slice(0, 2))}" onerror="this.replaceWith(document.createTextNode(this.alt))"></div>`;
}
export function itemIconHtml(item, cls = 'item-icon') {
  return item && item.gfx ? `<img class="${cls}" src="/assets/items/${item.type}/${item.gfx}.png" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<span class="${cls}"></span>`;
}

function range(e) {
  const max = e.max > e.min ? e.max : null;
  return max ? `${e.min} a ${max}` : `${Math.max(e.min, 0)}`;
}

const STAT_EFFECTS = {};
export function statEffects(map) { Object.assign(STAT_EFFECTS, map); }
export function statEffectMap() { return STAT_EFFECTS; }

export function effectText(e) {
  const dur = e.duration > 0 ? ` (${e.duration} t)` : e.duration < 0 ? ' (permanente)' : '';
  const id = e.id;
  if (DMG[id]) return `<span style="color:${ELEM_COLORS[DMG[id]]}">Dano ${ELEM_NAMES[DMG[id]]} ${range(e)}</span>${dur}`;
  if (STEAL[id]) return `<span style="color:${ELEM_COLORS[STEAL[id]]}">Rouba vida (${ELEM_NAMES[STEAL[id]]}) ${range(e)}</span>${dur}`;
  if (PCT[id]) return `Dano ${ELEM_NAMES[PCT[id]]}: ${range(e)}% da vida do lançador${dur}`;
  const S = STAT_EFFECTS[id];
  if (S) {
    const label = DATA.statLabels[S[0]] || S[0];
    return `${S[1] > 0 ? '+' : '-'}${range(e)} ${label}${dur}`;
  }
  const mon = () => DATA.monsters[e.min]?.name?.replace(/\s*\(Invocation\)/, '').trim() || 'criatura';
  const sp = () => DATA.spells[e.min]?.name || 'feitiço';
  const T = {
    4: 'Teleporta para a célula', 5: `Empurra ${range(e)} célula(s)`, 6: `Atrai ${range(e)} célula(s)`, 8: 'Troca de lugar com o alvo',
    9: 'Esquiva corpo a corpo', 77: `Rouba ${range(e)} PM`, 84: `Rouba ${range(e)} PA`, 101: `-${range(e)} PA (esquivável)`,
    127: `-${range(e)} PM (esquivável)`, 108: `<span style="color:#3f8f3a">Cura ${range(e)}</span>`, 143: `Cura fixa ${range(e)}`,
    81: `Cura ${range(e)}`, 82: `Rouba ${range(e)} de vida (fixo)`, 90: `Transfere ${range(e)}% da vida`, 109: `Dano no lançador ${range(e)}`,
    105: `Reduz ${range(e)} de dano`, 265: `Reduz ${range(e)} de dano`, 106: `Reenvia feitiços até nível ${Math.max(e.min, e.max)}`,
    107: `Reenvia ${range(e)} de dano`, 79: 'Sorte: cura ou multiplica o dano sofrido', 114: `Multiplica o dano por ${e.min}`,
    131: `Veneno: ${range(e)} de dano por PA usado`, 132: 'Desenfeitiça o alvo', 140: 'Faz o alvo perder o turno', 141: 'Mata o alvo',
    144: `Dano fixo ${range(e)}`, 149: 'Muda a aparência', 150: 'Invisibilidade', 202: 'Revela invisíveis e armadilhas',
    180: 'Invoca um duplo', 181: `Invoca ${mon()}`, 185: `Invoca ${mon()} (estática)`, 405: `Invoca ${mon()}`,
    400: `Armadilha: ${sp()}`, 401: `Glifo: ${sp()}`, 402: `Glifo: ${sp()}`, 293: `+${e.special} de dano em ${sp()}`,
    950: `Aplica estado ${e.special}`, 951: `Remove estado ${e.special}`, 672: `Punição (${range(e)}%)`, 765: 'Sacrifício: recebe o dano no lugar do aliado',
    783: 'Medo: empurra o aliado/inimigo à frente', 788: `Castigo: ganha característica ao sofrer dano (máx. ${e.max})`,
    776: 'Erosão', 666: 'Sem efeito', 780: `Ressuscita o último aliado morto com ${range(e)}% da vida`, 781: 'Minimiza os efeitos aleatórios do alvo',
    782: 'Maximiza os efeitos aleatórios do alvo', 784: 'Todos voltam às posições iniciais', 786: 'Cura todos ao ser atacado',
    787: `No início do turno, o alvo lança ${sp()}`, 671: `Dano neutro: ${range(e)}% da vida do lançador`, 128: `+${range(e)} PM`, 50: 'Carregar (não disponível)', 51: 'Arremessar (não disponível)',
  };
  return (T[id] || `Efeito ${id}`) + dur;
}

export function spellElement(spell) {
  const lv = spell?.levels?.at?.(-1);
  if (!lv) return 'N';
  for (const e of lv.effects) { const el = DMG[e.id] || STEAL[e.id]; if (el) return el; }
  return null;
}

const ICON_COLORS = { N: ['#a39a90', '#5e554d'], E: ['#b98545', '#5d3c17'], F: ['#f07a3a', '#8f2412'], W: ['#5aa9ee', '#1d4f8a'], A: ['#6ccf7e', '#22713a'] };
export function spellIcon(spell, cls = 'spell-icon') {
  const el = spellElement(spell);
  const [a, b] = el ? ICON_COLORS[el] : ['#c9a0e8', '#5b3a88'];
  const name = spell?.name || '?';
  const short = name.replace(/[^A-Za-zÀ-ÿ ]/g, '').split(' ').filter(w => w.length > 2).slice(0, 2).map(w => w[0]).join('') || name[0];
  const img = spell && spell.icon > 0 ? `<img src="/assets/spells/${spell.id}.png" onerror="this.remove()" alt="">` : '';
  return `<div class="${cls}" style="background:linear-gradient(135deg,${a},${b})" title="${esc(name)}"><span class="lbl">${esc(short.toUpperCase())}</span>${img}</div>`;
}

export function itemStatsHtml(item, itemStats) {
  const st = itemStats(item);
  const parts = Object.entries(st).filter(([, v]) => v).map(([k, v]) => `<span class="${v > 0 ? 'pos' : 'neg'}">${v > 0 ? '+' : ''}${v} ${esc(DATA.statLabels[k] || k)}</span>`);
  if (item.weapon) {
    const dm = item.effects.filter(e => (e[0] >= 91 && e[0] <= 101) || e[0] === 108)
      .map(([id, min, max]) => effectText({ id, min, max, duration: 0 }));
    parts.unshift(...dm, `${item.weapon.ap} PA, alcance ${item.weapon.minRange}-${item.weapon.maxRange}${item.weapon.twoHands ? ', duas mãos' : ''}`);
  }
  return parts.join(' · ');
}
