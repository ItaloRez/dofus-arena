// Fight screen in the Dofus 1.29 layout: real map, animated class sprites, spell effects, bottom banner.
import { FightMap } from '/game/map.js';
import { $, h, esc, clsBadge, clsName, effectText, ELEM_COLORS, statEffectMap } from './ui.js';
import { imageNow, image, drawSprite, spriteMeta, loadSprite, FX, FXP, GFX, assetsReady, SPRITE_FPS, itemIcon, json } from './assets.js';
import * as sound from './audio.js';
import { hasFx, loadFx, playFx, stepFx, fxReady } from './fxplayer.js';
import * as keys from './shortcuts.js';

const CELL_W = 53, CELL_H = 27, LEVEL_H = 20;
const TEAM = ['#d8322a', '#2c6fd8'];
const TEAM_SOFT = ['rgba(216,50,42,.55)', 'rgba(44,111,216,.55)'];
const STAT_SHORT = { ap: 'PA', mp: 'PM', range: 'Alc', str: 'For', int: 'Int', cha: 'Sor', agi: 'Agi', wis: 'Sab', vit: 'Vida', dmg: 'Dano', pdmg: '%Dano', crit: 'Crit', heal: 'Cura', dodgeAP: 'EsqPA', dodgeMP: 'EsqPM', rpN: '%RN', rpE: '%RT', rpF: '%RF', rpW: '%RA', rpA: '%RAr', reflect: 'Reenvio', summons: 'Invoc' };
const TRAP_OBJECT = 25; // layer-2 object the 1.29 server puts on a trap's center cell (glyphs send object 0: none)
const BUFF_NAMES = { maxRoll: 'Efeitos aleatórios maximizados', minRoll: 'Efeitos aleatórios minimizados', healOnHit: 'Cura todos ao ser atacado', turnSpell: 'Explode no início do turno', reduce: 'Armadura', reflect: 'Reenvio', return: 'Reenvio de feitiço', dot: 'Veneno', invis: 'Invisível', skip: 'Perde o turno', state: 'Estado', healOrMul: 'Sorte', multiply: 'Multiplica', sacrifice: 'Sacrifício', onDamage: 'Castigo', spellDmg: 'Bônus de feitiço', apPoison: 'Veneno paralisante', spellAp: 'Custo reduzido', spellCrit: 'Crítico' };
const DMG_COLOR = { N: '#ff3b2f', E: '#ff3b2f', F: '#ff3b2f', W: '#ff3b2f', A: '#ff3b2f' };
// colours from the 1.29 client (dofus.Constants)
const C129 = {
  life: '#ff0000', ap: '#0000ff', mp: '#006600',            // floating points (PlayableCharacter.updateLP/AP/MP)
  path: 'rgba(255,102,0,.62)',                             // CELL_PATH_OVER_COLOR 0xFF6600
  range: 'rgba(36,102,150,.4)',                            // CELL_SPELL_RANGE_COLOR 0x246696 (whole range)
  rangeOk: 'rgba(0,102,204,.5)',                           // castable cells on top of it (drawAllowedZone, 0x0066CC alpha 50)
  zone: 'rgba(255,102,0,.7)',                              // CELL_SPELL_EFFECT_COLOR 0xFF6600
  team: ['rgba(255,0,0,.55)', 'rgba(0,0,255,.5)'],         // TEAMS_COLOR, start positions
};
const TURN_SECONDS = 30;
// spell bar: 2 pages of 2 x 10 places
const PAGE_SLOTS = 20, BAR_PAGES = 2, BAR_SLOTS = PAGE_SLOTS * BAR_PAGES;
const POINT_FPS = 25, POINT_NEXT_MS = 8 / POINT_FPS * 1000, POINT_LIFE_MS = 13 / POINT_FPS * 1000;

// effect descriptions, icon categories and state names of the client lang files (tools/uilang.py)
let LANG = { effects: {}, states: {} };
json('/assets/ui/lang.json').then((l) => { if (l) LANG = l; });

// "#1{~1~2 a }#2" templates of the lang effects file: {~n...} is kept only when param n exists
function langText(tpl, p) {
  const has = (n) => p[n] !== undefined && p[n] !== null && p[n] !== '';
  return tpl.replace(/\{((?:~\d)+)([^}]*)\}/g, (_, refs, txt) => (refs.match(/\d/g).every(has) ? txt : ''))
    .replace(/#(\d)/g, (_, n) => (has(n) ? p[n] : '')).replace(/\s+/g, ' ').trim();
}

// icon category of each characteristic (from the first effect id that raises / lowers it)
let statIcons = null;
function STAT_ICON() {
  if (statIcons && Object.keys(LANG.effects).length) return statIcons;
  const out = {};
  for (const [id, [stat, sign]] of Object.entries(statEffectMap())) {
    const c = LANG.effects[id]?.c;
    const k = stat + (sign > 0 ? '+' : '-');
    if (c != null && c >= 0 && out[k] == null) out[k] = c;
  }
  statIcons = Object.keys(LANG.effects).length ? out : null;
  return out;
}

// screen direction -> sprite suffix and mirroring (sprites only have R = facing down-right, L = facing up-left)
const DIR_ANIM = { SE: ['R', false], SW: ['R', true], NW: ['L', false], NE: ['L', true] };

export class FightView {
  constructor(root, { data, map, state, you, send, onLeave }) {
    this.data = data;
    this.send = send;
    this.onLeave = onLeave;
    this.you = you;
    this.mapJson = map;
    this.map = new FightMap(map);
    this.W = map.w;
    this.state = state;
    // trap object (GDC layer 2 = gfx 25) per trap id: when it appeared (its fall-in animation); traps already there show the last frame
    this.trapT0 = new Map((state.traps || []).map(t => [t.id, -Infinity]));
    this.trapGone = new Set();
    this.pos = {};     // fighter id -> { x, y, depth } in world units
    this.anim = {};    // fighter id -> { name, dir, t0, once, until }
    this.dying = {};   // fighter id -> time until which the death animation is shown
    this.floats = [];  // floating points, one queue per fighter (ank.battlefield.PointsHandler)
    this.bubbles = []; // speech bubbles (critical failure)
    this.marks = [];   // short clips on a fighter (critical hit)
    this.fx = [];
    this.spellFx = []; // effects run by fxplayer.js (the spell SWF's own scripts)
    this.t0 = Date.now();
    this.queue = [];
    this.busy = false;
    this.selected = null;
    this.hover = -1;
    this.mouse = { x: 0, y: 0 };
    this.myTeam = state.fighters.find(f => f.id === you)?.team ?? 0;
    this.cellPos = this.map.cells.map((c, i) => this.computeCellPos(i));
    this.bg = null;
    image(`/assets/maps/${map.id}.webp`).then((img) => { this.bg = img; });
    for (const f of state.fighters) { if (f.gfx) loadSprite(f.gfx); if (f.look) loadSprite(f.look); }
    // effects of the spells we can see (our team): loaded ahead so the first cast does not wait
    fxReady.then(() => { for (const f of state.fighters) for (const sp of f.spells || []) { const g = this.data.spells[sp.id]?.sprite; if (g > 0 && hasFx(g)) loadFx(g); } });
    sound.preload(state.fighters.map(f => f.gfx).filter(Boolean));
    sound.preloadSpells(state.fighters.flatMap(f => (f.spells || []).map(s => this.data.spells[s.id ?? s]?.sprite)).filter(Boolean));
    sound.mapMusic(map.id);
    this.build(root);
    window.arenaFight = this; // handle for the browser tests
    this.applyState(state);
    this.faceEnemies();
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
    this.timerInt = setInterval(() => this.renderTimer(), 250);
    this.log(`Mapa: <b>${esc(map.name)}</b>${map.area ? ' (' + esc(map.area) + ')' : ''}`, 'info');
    if (state.phase === 'placement' && state.mode !== 'sandbox') this.log('Escolha sua posição inicial clicando numa célula da sua equipe e clique em Pronto.', 'info');
  }

  me() { return this.state.fighters.find(f => f.id === this.you); }
  // sprite to draw: the changed appearance (drunk Pandawa...) once its sheets are loaded, else the normal one
  sg(f) { return f.look && spriteMeta(f.look) ? f.look : f.gfx; }
  fighter(id) { return this.state.fighters.find(f => f.id === id); }
  myTurn() { return this.state.phase === 'fighting' && this.state.current === this.you && !this.busy; }

  // ---------------------------------------------------------------- geometry (Dofus 1.29 screen layout)

  computeCellPos(i) {
    const W = this.W, per = 2 * W - 1;
    const pair = Math.floor(i / per); let col = i - pair * per; let row = pair * 2; let x;
    if (col >= W) { col -= W; row += 1; x = col * CELL_W + CELL_W; } else x = col * CELL_W + CELL_W / 2;
    const lvl = this.mapJson.cells[i]?.[3] ?? 7;
    return { x, y: row * (CELL_H / 2) + CELL_H / 2 - (lvl - 7) * LEVEL_H };
  }

  // world -> screen transform: the whole map (795 x ~470) fits the stage
  layout() {
    const worldW = this.W * CELL_W;
    const rows = this.mapJson.h * 2 - 1;
    this.yTop = -30;
    this.yBot = rows * CELL_H / 2 + 2; // like the 1.29 client, the last row is half hidden by the banner
    const worldH = this.yBot - this.yTop;
    this.k = Math.min(this.w / worldW, this.h / worldH);
    this.offX = (this.w - worldW * this.k) / 2;
    this.offY = (this.h - worldH * this.k) / 2 - this.yTop * this.k;
  }
  toScreen(x, y) { return [this.offX + x * this.k, this.offY + y * this.k]; }
  toWorld(sx, sy) { return [(sx - this.offX) / this.k, (sy - this.offY) / this.k]; }

  cellAtMouse(mx, my) {
    const [wx, wy] = this.toWorld(mx, my);
    let best = -1;
    for (let i = 0; i < this.map.cells.length; i++) {
      if (!this.map.cells[i].active) continue;
      const p = this.cellPos[i];
      if (Math.abs(wx - p.x) / (CELL_W / 2) + Math.abs(wy - p.y) / (CELL_H / 2) <= 1) best = i;
    }
    return best;
  }

  dirBetween(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (dy >= 0) return dx >= 0 ? 'SE' : 'SW';
    return dx >= 0 ? 'NE' : 'NW';
  }

  faceEnemies() {
    for (const f of this.state.fighters) {
      const p = this.pos[f.id]; if (!p) continue;
      const foes = this.state.fighters.filter(o => o.team !== f.team && !o.dead && this.pos[o.id]);
      if (!foes.length) continue;
      const cx = foes.reduce((s, o) => s + this.pos[o.id].x, 0) / foes.length;
      const cy = foes.reduce((s, o) => s + this.pos[o.id].y, 0) / foes.length;
      this.setAnim(f.id, 'static', this.dirBetween(p, { x: cx, y: cy }));
    }
  }

  // ---------------------------------------------------------------- DOM

  build(root) {
    // Layout of the 1.29 client: map on top; the banner holds the chat, the round illustration with the turn
    // chronometer, the heart (life), AP star, MP circle, the shortcut grid and the end-of-turn / give-up buttons.
    // Hovering a fighter swaps the shortcut grid for its characteristics (BannerSpriteInfos).
    this.el = h(`<div class="fight d129">
      <div class="stage"><canvas id="cv"></canvas><div id="tip" class="tip" style="display:none"></div>
        <div class="sb-tabs" id="sbtabs"></div><div id="course"></div><div id="ctext"></div>
        <div class="tline" id="tl"></div>
        <div class="scursor" id="scur" style="display:none"><img alt=""><i></i></div></div>
      <div class="banner129">
        <div class="b-chat"><div class="log" id="log"></div><input id="chat" maxlength="200" placeholder="Mensagem (Enter)"></div>
        <div class="b-mid">
          <div class="b-circle" id="circle"><img id="art" alt=""><div class="chrono" id="chrono"></div><b id="count"></b></div>
          <div class="heart" id="olife" title="Pontos de vida"></div>
          <div class="pts"><div class="pa" id="oap" title="Pontos de ação"></div><div class="pm" id="omp" title="Pontos de movimento"></div></div>
          <div class="b-actions"><button class="b-giveup" id="ff" title="Desistir"></button><button class="b-next" id="pass">Passar a vez</button></div>
        </div>
        <div class="b-right">
          <div class="b-tools"><span class="grow"></span><div class="b-small" id="bsmall"><button id="tac" title="Modo tático">▦</button></div></div>
          <div class="b-row"><div class="b-spells" id="bar"></div><div class="b-info" id="finfo" style="display:none"></div></div>
        </div>
      </div></div>`);
    root.replaceChildren(this.el);
    $('#bsmall', this.el).appendChild(sound.soundButton());
    this.cv = $('#cv', this.el);
    this.ctx = this.cv.getContext('2d');
    this.resize();
    this.onResize = () => this.resize();
    window.addEventListener('resize', this.onResize);
    this.cv.addEventListener('mousemove', (e) => this.onMove(e));
    this.cv.addEventListener('mouseleave', () => { this.hover = -1; this.hoverF = null; $('#tip', this.el).style.display = 'none'; $('#scur', this.el).style.display = 'none'; this.showFighterInfo(null); });
    this.cv.addEventListener('click', (e) => this.onClick(e));
    this.cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.select(null); });
    this.onKey = (e) => {
      // typing in the chat or any field never triggers a shortcut
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (this.rebinding) return this.onRebindKey(e);
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') { this.closeMenu(); this.select(null); return; }
      const slot = keys.slotFor(e.code);
      if (slot) {
        e.preventDefault();
        const b = this.el.querySelector(`.sbtn[data-slot="${slot}"]`);
        b?.click();
        return;
      }
      if (e.code === 'KeyT') this.toggleTactical();
      if (e.key === ' ' && this.myTurn()) { e.preventDefault(); this.send({ t: 'pass' }); }
    };
    window.addEventListener('keydown', this.onKey);
    $('#pass', this.el).onclick = () => {
      const me = this.me();
      if (this.state.phase === 'placement' && me) return this.send({ t: 'ready', ready: !me.ready });
      this.select(null); this.send({ t: 'pass' });
    };
    try { this.tactical = localStorage.getItem('tactical') === '1'; } catch {}
    $('#tac', this.el).classList.toggle('on', !!this.tactical);
    $('#tac', this.el).onclick = () => this.toggleTactical();
    $('#ff', this.el).onclick = () => {
      if (this.state.phase === 'ended') return this.onLeave();
      if (confirm(this.state.mode === 'sandbox' ? 'Sair do treino?' : 'Desistir da luta? Conta como derrota.')) this.send({ t: 'forfeit' });
    };
    $('#chat', this.el).onkeydown = (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) { this.send({ t: 'chat', text: e.target.value }); e.target.value = ''; }
    };
  }

  resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.cv.width = Math.round(r.width * dpr);
    this.cv.height = Math.round(r.height * dpr);
    this.w = r.width;
    this.h = r.height;
    this.layout();
  }

  // ---------------------------------------------------------------- state

  update(state, events) {
    for (const f of state.fighters) { if (f.gfx) loadSprite(f.gfx); if (f.look) loadSprite(f.look); }
    this.queue.push({ state, events });
    if (!this.busy) this.process();
  }

  async process() {
    this.busy = true;
    while (this.queue.length) {
      const { state, events } = this.queue.shift();
      for (const ev of events) await this.animate(ev, state);
      this.applyState(state);
    }
    this.busy = false;
    this.renderUI();
  }

  applyState(state) {
    const prevPhase = this.state.phase;
    this.state = state;
    const nowT = performance.now();
    for (const t of state.traps || []) if (!this.trapT0.has(t.id)) this.trapT0.set(t.id, nowT);
    for (const f of state.fighters) {
      if (f.cell >= 0) {
        const c = this.cellPos[f.cell];
        const p = this.pos[f.id];
        if (!p || p.cell !== f.cell) this.pos[f.id] = { x: c.x, y: c.y, cell: f.cell, depth: f.cell };
        this.pos[f.id].hidden = false;
        if (!this.anim[f.id]) this.setAnim(f.id, 'static', f.team === 0 ? 'SE' : 'NW');
      } else if (this.pos[f.id] && f.invisible) this.pos[f.id].hidden = true;
    }
    if (prevPhase === 'placement' && state.phase === 'fighting') { sound.play('start_fight'); this.faceEnemies(); this.centerText('O combate começou!'); this.t0 = Date.now(); }
    if (state.phase === 'placement') this.faceEnemies();
    if (this.selected && !this.canUseSelected()) this.select(null);
    this.renderUI();
  }

  setAnim(id, name, dir) {
    const a = this.anim[id] || {};
    this.anim[id] = { name, dir: dir || a.dir || 'SE', t0: performance.now() };
  }

  // Sprite.setAnim: a fighter holding someone plays the "_C" version of each animation (static_CR, walk_CR...)
  animKey(f, meta, base, suf) {
    if (!meta) return null;
    const o = suf === 'R' ? 'L' : 'R';
    for (const b of f.carrying ? [base + '_C', base] : [base]) { if (meta[b + suf]) return b + suf; if (meta[b + o]) return b + o; }
    return null;
  }

  animMs(id, name, dir) {
    const f = this.fighter(id);
    const meta = f && this.sg(f) ? spriteMeta(this.sg(f)) : null;
    const [suf] = DIR_ANIM[dir || this.anim[id]?.dir || 'SE'];
    const k = this.animKey(f, meta, name, suf), m = k && meta[k];
    return m ? m.frames / SPRITE_FPS * 1000 : 0;
  }

  // VisualEffectHandler.onLoadInit: `from` is the caster sprite, `to` the target sprite (else the target cell).
  // The fight goes on when the clip calls end() (the client's hook), or after a short while if it never does.
  async launchFx(ev, sp, type, fromCell, toCell) {
    const me = this.pos[ev.id];
    const tgt = this.state.fighters.find((f) => f.cell === ev.cell && !f.dead && this.pos[f.id] && !this.pos[f.id].hidden);
    const from = me ? { x: me.x, y: me.y } : fromCell;
    const to = tgt ? { x: this.pos[tgt.id].x, y: this.pos[tgt.id].y } : toCell;
    const level = this.fighter(ev.id)?.spells?.find((s) => s.id === ev.spell)?.level || 1;
    const meta = await loadFx(sp.sprite);
    const fx = meta && await playFx(sp.sprite, { type, from, to, level });
    if (!fx) return false;
    this.spellFx.push(fx);
    if (meta.end) await Promise.race([fx.ended, this.sleep(2500), new Promise((r) => { const w = () => (fx.done ? r() : setTimeout(w, 50)); w(); })]);
    else await this.sleep(450);
    return true;
  }

  // VisualEffectHandler.onLoadInit for the display types whose pieces the client places itself.
  // Returns false when this spell has no such pieces, so the caller falls back to the whole clip.
  async launchParts(sp, parts, type, from, to) {
    const url = (n) => `/assets/fx/parts/${sp}-${n}.webp`;
    await Promise.all(Object.keys(parts).map((n) => image(url(n))));
    const now = performance.now();
    const add = (name, x, y, extra = {}) => this.fx.push({ part: url(name), m: parts[name], x, y, t0: performance.now(), ...extra });
    const dx = to.x - from.x, dy = to.y - from.y;
    const ms = (m) => m.frames / SPRITE_FPS * 1000;
    if ((type === 20 || type === 21) && parts.rotate) {
      // the "rotate" clip is turned towards the target; "shoot" is attached on the target at once
      const r = parts.rotate;
      add('rotate', from.x, from.y, { rot: Math.atan2(dy, dx), off: [r.tx, r.ty], scale: [r.sx, r.sy] });
      if (parts.shoot) add('shoot', to.x, to.y);
      await this.sleep(Math.min(500, ms(r) * 0.5));
      return true;
    }
    if ((type === 30 || type === 31) && parts.move) {
      // ballistic arc (the same formula as the client), mirrored when shooting to the left
      const k = type === 31 ? 0.9 : 0.5, speed = type === 31 ? 0.4 : 0.5, g = 9.81, hg = g / 2;
      let sx = 1, sy = 1, yDest = dy;
      if (dx <= 0) { if (dx === 0 && dy < 0) { sy = -1; yDest = -yDest; } sx = -1; }
      const xDest = Math.abs(dx);
      const start = (Math.atan2(dy, Math.abs(dx)) + Math.PI / 2) * k - Math.PI / 2;
      const vx = Math.sqrt(Math.abs(hg * xDest * xDest / (Math.abs(yDest - Math.tan(start) * xDest) || 1e-6)));
      const vy = Math.tan(start) * vx;
      const path = [];
      let t = 0, end = null;
      for (let i = 0; i < 2000; i++) {
        const vyi = vy + g * t, x = t * vx, y = hg * t * t + vy * t;
        t += speed;
        const rot = Math.atan(vyi / (vx || 1e-6));
        if ((Math.abs(y) >= Math.abs(yDest) && x >= xDest) || x > xDest) { end = rot; break; }
        path.push([x, y, rot]);
      }
      const o = { x: from.x, y: from.y - 10, mirror: [sx, sy] };
      this.fx.push({ part: url('move'), m: parts.move, path, t0: now, ...o });
      await this.sleep(path.length / SPRITE_FPS * 1000);
      if (parts.shoot) this.fx.push({ part: url('shoot'), m: parts.shoot, t0: performance.now(), ...o, at: [xDest, yDest], rot: end ?? 0 });
      await this.sleep(120);
      return true;
    }
    if ((type === 50 || type === 51) && parts.aim) {
      // scripted effects that read `angle`: the flight clip leaves the caster turned towards the target
      // (stretched to the real distance), the impact clip plays on the target
      const a = parts.aim;
      const near = Math.abs(a.tx) < 30 && Math.abs(a.ty) < 60;
      const dist = Math.hypot(dx, dy);
      const sx = a.reach ? Math.max(0.3, Math.min(3, dist / a.reach)) : 1;
      add('aim', from.x, from.y, { rot: Math.atan2(dy, dx), off: [near ? a.tx : 0, near ? a.ty : -25], scale: [a.sx * sx, a.sy] });
      if (parts.hit) add('hit', to.x, to.y);
      await this.sleep(Math.min(500, ms(a) * 0.5));
      return true;
    }
    if ((type === 50 || type === 51) && parts.place) {
      // scripted effects that only move their clip onto the target cell
      add('place', to.x + parts.place.tx, to.y + parts.place.ty);
      await this.sleep(Math.min(500, ms(parts.place) * 0.5));
      return true;
    }
    if ((type === 40 || type === 41) && (parts.duplicate || parts.shoot)) {
      // a trail: one "duplicate" every 20 px along the line, then "shoot" on the target (41)
      const full = Math.hypot(dx, dy), n = Math.max(1, Math.floor(full / 20)), step = full / n, a = Math.atan2(dy, dx);
      if (parts.duplicate) for (let d = step, i = 0; d <= full; d += step, i++) {
        this.fx.push({ part: url('duplicate'), m: parts.duplicate, x: from.x + d * Math.cos(a), y: from.y + d * Math.sin(a), t0: now + i * 1000 / SPRITE_FPS });
      }
      await this.sleep(n * 1000 / SPRITE_FPS);
      if (type === 41 && parts.shoot) add('shoot', to.x, to.y);
      await this.sleep(150);
      return true;
    }
    return false;
  }

  // Plays an animation once; resolves after `wait` ms (default: the whole animation)
  playOnce(id, name, dir, wait) {
    const f = this.fighter(id);
    const meta = f && this.sg(f) ? spriteMeta(this.sg(f)) : null;
    const d = dir || this.anim[id]?.dir || 'SE';
    const [suf] = DIR_ANIM[d];
    const key = this.animKey(f, meta, name, suf), m = key && meta[key];
    if (!m) return Promise.resolve();
    const dur = m.frames / SPRITE_FPS * 1000;
    const cur = this.anim[id];
    // a reaction (hit, bonus) never cuts a running animation of the same or higher priority (attack > hit > bonus)
    const PRIO = { bonus: 1, hit: 2, anim0: 3, anim1: 3, die: 9 };
    if (cur && cur.once && performance.now() < cur.until && (name === 'hit' || name === 'bonus') && (PRIO[cur.name] || 0) >= PRIO[name]) {
      return this.sleep(Math.min(cur.until - performance.now(), wait ?? dur));
    }
    // the clip is chosen now: a throw keeps playing its "_C" clip after the carried fighter has left
    this.anim[id] = { name, key, dir: d, t0: performance.now(), once: true, until: performance.now() + dur };
    sound.anim(this.sg(f), key);
    return this.sleep(Math.min(dur, wait ?? dur));
  }

  sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Waits until the fighter's current one-shot animation (attack, hit, bonus) has finished, so it is not cut
  finishAnim(id, max = 1500) {
    const a = this.anim[id];
    if (!a || !a.once || a.name === 'die') return Promise.resolve();
    const left = a.until - performance.now();
    return left > 0 ? this.sleep(Math.min(left, max)) : Promise.resolve();
  }

  async walk(id, path) {
    await this.finishAnim(id);
    const p = this.pos[id] || {};
    const run = path.length > 4;
    const per = run ? 170 : 290;
    for (let i = 1; i < path.length; i++) {
      const a = this.cellPos[path[i - 1]], b = this.cellPos[path[i]];
      const dir = this.dirBetween(a, b);
      const cur = this.anim[id];
      if (!cur || cur.name !== (run ? 'run' : 'walk') || cur.dir !== dir) this.setAnim(id, run ? 'run' : 'walk', dir);
      p.depth = Math.max(path[i - 1], path[i]);
      const t0 = performance.now();
      await new Promise(res => {
        const step = () => {
          const t = Math.min(1, (performance.now() - t0) / per);
          p.x = a.x + (b.x - a.x) * t; p.y = a.y + (b.y - a.y) * t;
          if (t < 1) requestAnimationFrame(step); else res();
        };
        step();
      });
    }
    p.cell = path.at(-1); p.depth = p.cell;
    this.pos[id] = p;
    this.setAnim(id, 'static', this.anim[id]?.dir);
  }

  async animate(ev, nextState) {
    const name = (id) => esc(this.fighter(id)?.name || nextState.fighters.find(f => f.id === id)?.name || '?');
    switch (ev.type) {
      case 'turn': {
        // 1.29: the "string course" shows the artwork, name and level of whoever starts playing
        const f = nextState.fighters.find(x => x.id === ev.id);
        if (f) this.stringCourse(f);
        if (ev.id === this.you) { this.log('É a sua vez de jogar.', 'info'); sound.play('turn_start'); }
        break;
      }
      case 'move':
        // an invisible enemy comes without a path (nothing to show); an invisible ally walks normally, at reduced alpha
        if (!ev.path) break;
        if (ev.path.length > 1) this.floatAt(ev.id, `-${ev.path.length - 1}`, C129.mp);
        await this.walk(ev.id, ev.path);
        break;
      case 'slide': case 'tp': {
        const c = this.cellPos[ev.cell];
        const p = this.pos[ev.id];
        if (p && ev.type === 'slide') {
          const a = { x: p.x, y: p.y }, t0 = performance.now();
          await new Promise(res => { const step = () => { const t = Math.min(1, (performance.now() - t0) / 220); p.x = a.x + (c.x - a.x) * t; p.y = a.y + (c.y - a.y) * t; if (t < 1) requestAnimationFrame(step); else res(); }; step(); });
        }
        this.pos[ev.id] = { ...(this.pos[ev.id] || {}), x: c.x, y: c.y, cell: ev.cell, depth: ev.cell };
        if (ev.type === 'tp') await this.sleep(150);
        break;
      }
      case 'cast': {
        const isWeapon = ev.kind === 'weapon';
        const sp = isWeapon ? { name: this.data.items[ev.spell]?.name } : this.data.spells[ev.spell];
        this.log(isWeapon ? `${name(ev.id)} ataca corpo a corpo.` : `${name(ev.id)} lança o feitiço ${esc(ev.name || sp?.name)}.`);
        if (ev.crit) this.log('(Golpe crítico)');
        if (ev.fail) this.log('(Falha crítica)');
        if (ev.ap) this.floatAt(ev.id, `-${ev.ap}`, C129.ap);
        const from = this.cellPos[ev.from] || this.pos[ev.id], to = this.cellPos[ev.cell];
        const dir = from && to && ev.from !== ev.cell ? this.dirBetween(from, to) : this.anim[ev.id]?.dir;
        if (ev.fail) { this.bubble(ev.id, 'Falha crítica'); await this.playOnce(ev.id, 'hit', dir, 400); break; }
        if (ev.crit) this.marks.push({ id: ev.id, kind: 'crit', t0: performance.now(), dur: 1000 });
        // spell "sprite info" from the client data: [display type, caster animation (anim<n>), in front]
        // (GameActions 300 -> spriteLaunchVisualEffect). -1 means no caster animation.
        const info = sp?.spriteInfo || [];
        let anim = isWeapon ? 'anim0' : info[1] >= 0 ? 'anim' + info[1] : null;
        if (anim && !this.animMs(ev.id, anim, dir)) anim = isWeapon || info[1] === 0 ? 'anim0' : 'anim1';
        await this.finishAnim(ev.id);
        // the hit lands about 60% into the attack animation; the rest keeps playing while the target reacts
        if (anim) await this.playOnce(ev.id, anim, dir, this.animMs(ev.id, anim, dir) * 0.6);
        const fxm = !isWeapon && sp?.sprite > 0 ? FX[sp.sprite] : null;
        const parts = !isWeapon && sp?.sprite > 0 ? FXP[sp.sprite] : null;
        await fxReady;
        const scripted = !isWeapon && sp?.sprite > 0 && hasFx(sp.sprite);
        if (!isWeapon && (fxm || parts || scripted)) sound.spell(sp.sprite);
        if (scripted && from && to && await this.launchFx(ev, sp, info[0], from, to)) {
          // played by the spell's own ActionScript (VisualEffectHandler + fxplayer.js)
        } else if (parts && from && to && await this.launchParts(sp.sprite, parts, info[0], from, to)) {
          // effect placed piece by piece like the client
        } else if (fxm && to) {
          // display types (VisualEffectHandler): 10/12 on the caster, 11 on the target, 50/51 drawn by the effect
          // from the caster towards the target (our sheet was rendered pointing right, so it is skewed along the line)
          const type = info[0];
          const at = (type === 10 || type === 12) && from ? from : to;
          let skew = null;
          if ((type === 50 || type === 51) && from && to && ev.from !== ev.cell) {
            const dx = to.x - from.x, dy = to.y - from.y, len = Math.hypot(dx, dy) || 1;
            skew = [dx / len, dy / len];
          }
          this.fx.push({ sprite: sp.sprite, m: fxm, x: at.x, y: at.y, skew, t0: performance.now() });
          await this.sleep(Math.min(450, fxm.frames / SPRITE_FPS * 1000 * 0.5));
        } else if (to) {
          this.fx.push({ burst: true, color: this.spellColor(isWeapon ? null : sp), x: to.x, y: to.y, t0: performance.now(), dur: 380 });
          await this.sleep(150);
        }
        break;
      }
      case 'damage':
        if (ev.value > 0) {
          this.floatAt(ev.id, `-${ev.value}`, C129.life);
          this.log(`${name(ev.id)}: <span class="dmg">-${ev.value} PV</span>`);
          if (this.fighter(ev.id)?.dummy && !this.fighter(ev.id).gfx) this.anim[ev.id] = { name: 'hit', dir: 'SE', t0: performance.now(), once: true, until: performance.now() + 400 };
          else this.playOnce(ev.id, 'hit');
        }
        await this.sleep(160);
        break;
      case 'heal': this.floatAt(ev.id, `+${ev.value}`, C129.life); this.log(`${name(ev.id)}: <span class="heal">+${ev.value} PV</span>`); await this.sleep(80); break;
      case 'stat': {
        // only life, AP and MP changes float over the head in 1.29; other characteristics go to the chat
        if (ev.stat === 'ap' || ev.stat === 'mp') this.floatAt(ev.id, `${ev.value > 0 ? '+' : ''}${ev.value}`, C129[ev.stat]);
        this.log(`${name(ev.id)}: ${ev.value > 0 ? '+' : ''}${ev.value} ${esc(this.data.statLabels[ev.stat] || ev.stat)} (${ev.duration} t)`);
        if (ev.value > 0) this.playOnce(ev.id, 'bonus');
        await this.sleep(80);
        break;
      }
      case 'ap': case 'mp':
        this.floatAt(ev.id, `${ev.value > 0 ? '+' : ''}${ev.value}`, C129[ev.type]);
        this.log(`${name(ev.id)}: ${ev.value > 0 ? '+' : ''}${ev.value} ${ev.type === 'ap' ? 'PA' : 'PM'}`);
        break;
      case 'dodge':
        if (ev.stat === 'melee') { this.log(`${name(ev.id)} se esquiva do golpe.`); await this.sleep(150); break; }
        this.log(`${name(ev.id)} esquivou a perda de ${ev.value} ${ev.stat === 'ap' ? 'PA' : 'PM'}.`); break;
      case 'reduced': break; // armour reduction is not shown as a floating text in 1.29
      case 'reflect': this.log(`${name(ev.id)} reenvia ${ev.value} de dano`); break;
      case 'tackled': this.log(`${name(ev.id)} foi preso${ev.ap ? ` e perde ${ev.ap} PA` : ''}.`); if (ev.ap) this.floatAt(ev.id, `-${ev.ap}`, C129.ap); await this.sleep(300); break;
      case 'buff': if (BUFF_NAMES[ev.kind]) { this.log(`${name(ev.id)}: ${esc(BUFF_NAMES[ev.kind])}${ev.duration > 0 ? ` (${ev.duration} turnos)` : ''}`); this.playOnce(ev.id, 'bonus'); } break;
      case 'die': {
        this.log(`${name(ev.id)} está morto.`, 'dmg');
        const f = this.fighter(ev.id);
        const meta = f && this.sg(f) && spriteMeta(this.sg(f));
        const [suf] = DIR_ANIM[this.anim[ev.id]?.dir || 'SE'];
        const m = meta && meta['die' + suf];
        if (m) sound.anim(this.sg(f), 'die' + suf);
        const dur = m ? m.frames / SPRITE_FPS * 1000 : 600;
        this.dying[ev.id] = performance.now() + dur;
        this.anim[ev.id] = { name: 'die', dir: this.anim[ev.id]?.dir || 'SE', t0: performance.now(), once: true, until: performance.now() + dur + 5000 };
        await this.sleep(Math.min(dur, 700));
        break;
      }
      case 'carry': {
        // SpriteHandler.carriedSprite: the carrier turns to the target and plays "carring"; the carried sprite
        // follows the hands marker of each frame, from its own cell up above the carrier's head
        const t = this.fighter(ev.target) || nextState.fighters.find(f => f.id === ev.target);
        const me = this.fighter(ev.id);
        this.log(`${name(ev.id)} levanta ${name(ev.target)}`);
        const from = this.pos[ev.id], tp = this.pos[ev.target];
        const dir = from && tp && (from.x !== tp.x || from.y !== tp.y) ? this.dirBetween(from, tp) : this.anim[ev.id]?.dir;
        if (t) t.carriedBy = ev.id;
        if (me) me.carrying = ev.target;
        this.anim[ev.target] = { name: 'static', dir, t0: performance.now() };
        await this.playOnce(ev.id, 'carring', dir);
        break;
      }
      case 'throw': case 'drop': {
        const t = this.fighter(ev.target), me = this.fighter(ev.id);
        const c = this.cellPos[ev.cell], from = this.pos[ev.id];
        // where the carried fighter leaves from: the hands marker of the carrier's current frame
        let a = from && { x: from.x, y: from.y - 38 };
        if (ev.type === 'throw') {
          // SpriteHandler.launchCarriedSprite: "carringThrow" until the carried sprite leaves the hands, then an arc
          this.log(`${name(ev.id)} arremessa ${name(ev.target)}`);
          const dir = from && c ? this.dirBetween(from, c) : undefined;
          this.playOnce(ev.id, 'carringThrow', dir);
          const fr = me && this.frameOf(me, performance.now());
          const marks = fr && fr.m && fr.m.carry;
          const release = marks ? marks.indexOf(null) : -1;
          if (release > 0) {
            await this.sleep(release / SPRITE_FPS * 1000);
            const k = marks[release - 1];
            if (from) a = { x: from.x + (fr.flip ? -k[0] : k[0]) / 2, y: from.y + k[1] / 2 };
          } else if (!marks) await this.playOnce(ev.id, 'anim1', dir, 300);
        }
        if (t) delete t.carriedBy;
        if (me) delete me.carrying;
        const p = this.pos[ev.target] = { ...(this.pos[ev.target] || {}), cell: ev.cell, depth: ev.cell };
        if (a && c) {
          // arc from the hands to the landing cell
          const t0 = performance.now(), dur = ev.type === 'throw' ? 260 + 40 * Math.min(6, Math.hypot(c.x - a.x, c.y - a.y) / 30) : 150;
          await new Promise(res => { const step = () => { const k = Math.min(1, (performance.now() - t0) / dur); p.x = a.x + (c.x - a.x) * k; p.y = a.y + (c.y - a.y) * k - Math.sin(k * Math.PI) * 30; if (k < 1) requestAnimationFrame(step); else res(); }; step(); });
        }
        if (c) { p.x = c.x; p.y = c.y; }
        break;
      }
      case 'summon': this.log(`${name(ev.by)} invoca ${name(ev.id)}`); break;
      case 'revive': { delete this.dying[ev.id]; this.anim[ev.id] = { name: 'static', dir: 'SE', t0: performance.now() }; this.log(`${name(ev.by)} traz ${name(ev.id)} de volta à luta`); break; }
      case 'trap': this.trapGone.add(ev.id); this.fx.push({ burst: true, color: '#b05cff', ...this.cellPos[ev.cell], t0: performance.now(), dur: 500 }); this.log('Uma armadilha foi ativada!'); await this.sleep(250); break;
      case 'invis': this.log(`${name(ev.id)} fica invisível`); break;
      case 'reveal': {
        // an invisible enemy that casts shows up at his real cell for a moment (his own team already sees him)
        const c = this.cellPos[ev.cell], f = this.fighter(ev.id), me = this.fighter(this.you);
        if (c && f && me && f.team !== me.team) this.pos[ev.id] = { ...(this.pos[ev.id] || {}), x: c.x, y: c.y, cell: ev.cell, depth: ev.cell, revealUntil: performance.now() + 1000 };
        break;
      }
      case 'item': this.log(`${name(ev.id)} usa ${esc(ev.name)}`); break;
      case 'log': this.log(esc(ev.text), 'info'); break;
      case 'end': break;
    }
  }

  spellColor(sp) {
    const lv = sp?.levels?.at?.(-1);
    const map = { 96: 'W', 97: 'E', 98: 'A', 99: 'F', 100: 'N', 91: 'W', 92: 'E', 93: 'A', 94: 'F', 95: 'N' };
    for (const e of lv?.effects || []) if (map[e.id]) return ELEM_COLORS[map[e.id]];
    return sp?.levels ? '#c79cff' : '#e8dcc0';
  }

  // Floating points as in ank.battlefield.mc.Points: the number pops (sine bounce on its scale) and rises
  // ~46 px with a decaying speed; each fighter shows one at a time, the next starts when the previous ends.
  floatAt(id, text, color) {
    if (!this.pos[id]) return;
    const q = this.floats.filter(f => f.id === id);
    const prev = q.at(-1);
    const start = Math.max(performance.now(), prev ? prev.t0 + POINT_NEXT_MS : 0);
    this.floats.push({ id, text, color, t0: start });
  }

  // CenterText: big message in the middle of the map on a dark band (fight start)
  centerText(text, ms = 2000) {
    const box = $('#ctext', this.el);
    if (!box) return;
    box.innerHTML = `<div class="ctext">${esc(text)}</div>`;
    clearTimeout(this.ctTimer);
    this.ctTimer = setTimeout(() => { box.innerHTML = ''; }, ms);
  }

  // StringCourse: artwork, name and level of the fighter whose turn starts
  stringCourse(f) {
    const box = $('#course', this.el);
    if (!box) return;
    const art = f.cls ? `<img src="/assets/classes/${f.gfx}.png" alt="">` : '<canvas width="64" height="64"></canvas>';
    box.innerHTML = `<div class="course t${f.team}">${art}<div><b>${esc(f.name)}</b><span>Nv. ${f.level}</span></div></div>`;
    const cv = $('canvas', box);
    if (cv) this.drawPortrait(cv, f.gfx);
    clearTimeout(this.courseTimer);
    this.courseTimer = setTimeout(() => { box.innerHTML = ''; }, 2600);
  }

  bubble(id, text) { this.bubbles.push({ id, text, t0: performance.now(), dur: 2200 }); }

  log(html, cls = '') {
    const box = $('#log', this.el);
    if (!box) return;
    const d = document.createElement('div');
    if (cls) d.className = cls;
    d.innerHTML = html;
    box.appendChild(d);
    while (box.children.length > 200) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  }

  chat(from, text) { this.log(`<b>${esc(from)}:</b> ${esc(text)}`, 'chatmsg'); }
  onError(msg) { this.log(esc(msg), 'err'); }

  // ---------------------------------------------------------------- UI panels

  // Turn chronometer: the ring around the banner illustration runs on your own turn (and during placement);
  // during someone else's turn it runs on their timeline item. The last 5 seconds are counted in big digits.
  renderTimer() {
    const st = this.state;
    const left = Math.max(0, (st.deadline - Date.now()) / 1000);
    const total = st.phase === 'placement' ? 30 : TURN_SECONDS;
    const frac = st.phase === 'ended' ? 0 : Math.min(1, left / total);
    const mineNow = st.mode !== 'sandbox' && (st.phase === 'placement' || (st.phase === 'fighting' && st.current === this.you));
    const ring = $('#chrono', this.el), cnt = $('#count', this.el);
    if (ring) {
      ring.style.setProperty('--p', mineNow ? frac : 0);
      ring.classList.toggle('low', mineNow && left <= 5);
    }
    if (cnt) cnt.textContent = mineNow && left > 0 && left <= 5 ? Math.ceil(left) : '';
    const it = st.phase === 'fighting' && st.current !== this.you && this.el.querySelector(`.tl[data-f="${st.current}"] .tchrono`);
    this.el.querySelectorAll('.tl .tchrono').forEach(e => { if (e !== it) e.style.setProperty('--p', 0); });
    if (it) it.style.setProperty('--p', frac);
  }

  // Sandbox: one tab per class to switch the test character
  renderSandboxTabs() {
    const box = $('#sbtabs', this.el);
    if (!box) return;
    const me = this.me();
    if (this.state.mode !== 'sandbox' || !me) { box.innerHTML = ''; return; }
    if (box.dataset.cls === String(me.cls)) return;
    box.dataset.cls = me.cls;
    box.innerHTML = Object.entries(this.data.classes).map(([id, c]) =>
      `<button class="${Number(id) === me.cls ? 'on' : ''}" data-cls="${id}" title="${esc(c.name)}"><img src="/assets/classes/${id * 10}.png" alt="${esc(c.name.slice(0, 2))}"><span>${esc(c.name)}</span></button>`).join('');
    box.querySelectorAll('button').forEach(b => b.onclick = () => { if (Number(b.dataset.cls) !== this.me()?.cls) this.send({ t: 'sandboxClass', cls: Number(b.dataset.cls) }); });
  }

  renderUI() {
    const st = this.state;
    const me = this.me();
    this.renderTimeline();
    this.renderSandboxTabs();
    if (me) {
      const art = $('#art', this.el);
      if (art.dataset.g !== String(me.gfx)) { art.dataset.g = me.gfx; art.src = `/assets/classes/${me.gfx}.png`; }
      $('#olife', this.el).innerHTML = `<b>${Math.max(0, me.life)}</b>`;
      $('#olife', this.el).title = `${me.life} / ${me.maxLife} PV`;
      $('#olife', this.el).style.setProperty('--f', Math.max(0, me.life / me.maxLife));
      $('#oap', this.el).textContent = st.current === me.id ? me.ap : me.stats.ap;
      $('#omp', this.el).textContent = st.current === me.id ? me.mp : me.stats.mp;
    }
    const pass = $('#pass', this.el);
    if (st.phase === 'placement') {
      pass.textContent = me?.ready ? 'Aguardando…' : 'Pronto';
      pass.dataset.label = pass.textContent;
      pass.disabled = false;
      pass.classList.toggle('ready', !!me?.ready);
      pass.classList.toggle('placing', !me?.ready);
    } else {
      pass.textContent = 'Passar a vez';
      pass.dataset.label = pass.textContent;
      pass.classList.remove('ready', 'placing');
      pass.disabled = !(st.phase === 'fighting' && st.current === this.you);
    }
    $('#ff', this.el).title = st.phase === 'ended' ? 'Sair' : st.mode === 'sandbox' ? 'Sair do treino' : 'Desistir';
    this.renderBar();
    this.renderTimer();
    this.renderEffects();
  }

  // Timeline (dofus.graphics.gapi.controls.Timeline): one 34 px item per fighter in turn order, anchored to the
  // right; the sprite's head, a vertical life gauge and a chronometer. Summons are smaller and grouped on a band
  // after their summoner; the dead stay greyed. A pointer marks whose turn it is.
  renderTimeline() {
    const st = this.state;
    const tl = $('#tl', this.el);
    const order = st.phase === 'placement' ? st.fighters.filter(f => !f.summoner).map(f => f.id) : st.order;
    const key = order.join(',') + '|' + st.fighters.map(f => `${f.id}:${f.dead ? 1 : 0}:${this.sg(f)}`).join(',');
    if (tl.dataset.k !== key) {
      tl.dataset.k = key;
      let html = `<div class="tl-round" id="round"></div>`;
      for (const id of order) {
        const f = this.fighter(id); if (!f) continue;
        html += `<div class="tl t${f.team} ${f.summoner ? 'sum' : ''} ${f.dead ? 'dead' : ''}" data-f="${f.id}">
          <canvas width="60" height="66"></canvas><div class="thp"><i></i></div><div class="tchrono"></div></div>`;
      }
      tl.innerHTML = html;
      tl.querySelectorAll('.tl[data-f]').forEach(el => {
        const f = this.fighter(Number(el.dataset.f)) || this.fighter(el.dataset.f);
        if (!f) return;
        this.drawPortrait($('canvas', el), this.sg(f), true);
        el.onmouseenter = () => { this.tlHover = f.id; this.showFighterInfo(this.fighter(f.id)); };
        el.onmouseleave = () => { this.tlHover = null; this.showFighterInfo(null); };
        el.onclick = (ev) => {
          const cur = this.fighter(f.id);
          if (this.selected && cur && cur.cell >= 0 && this.myTurn()) { this.hover = cur.cell; this.castAt(cur.cell); }
          else if (cur) this.openEffects(cur.id, ev);
        };
      });
    }
    const rd = $('#round', tl);
    if (rd) rd.textContent = st.phase === 'placement' ? 'Posicionamento' : `Rodada ${Math.max(1, (st.round || 0) + 1)}`;
    tl.querySelectorAll('.tl').forEach(el => {
      const f = st.fighters.find(x => String(x.id) === el.dataset.f);
      if (!f) return;
      $('.thp i', el).style.height = `${Math.max(0, f.life / f.maxLife * 100)}%`;
      el.classList.toggle('cur', st.phase === 'fighting' && st.current === f.id);
      el.classList.toggle('dead', !!f.dead);
      el.title = `${f.name} (${Math.max(0, f.life)})`;
    });
  }

  // head-and-shoulders portrait from the first frame of the static animation
  drawPortrait(cv, gfx, flip = false) {
    const ctx = cv.getContext('2d');
    const paint = () => {
      const meta = spriteMeta(gfx);
      const m = meta && (meta.staticR || meta.staticL);
      const img = m && imageNow(`/assets/sprites/${gfx}/${meta.staticR ? 'staticR' : 'staticL'}.webp`);
      if (!img) return false;
      ctx.clearRect(0, 0, cv.width, cv.height);
      // the head is at the top of the frame: show the top ~55% scaled to fit
      const sh = Math.min(m.h, m.w * 1.3);
      const k = Math.min(cv.width / m.w, cv.height / sh) * 1.1;
      ctx.save();
      if (flip) { ctx.translate(cv.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(img, 0, 0, m.w, sh, (cv.width - m.w * k) / 2, 2, m.w * k, sh * k);
      ctx.restore();
      return true;
    };
    if (!gfx || paint()) return;
    let tries = 0;
    const retry = () => { if (!paint() && tries++ < 40) setTimeout(retry, 150); };
    retry();
  }

  // ---------------------------------------------------------------- effects window (1.29 buff tooltip, as a window)

  openEffects(fid, ev) {
    this.effWins ??= new Map();
    let w = this.effWins.get(fid);
    if (!w) {
      w = h(`<div class="fxwin"><div class="fx-title"><span></span><button class="fx-x" title="Fechar">×</button></div><div class="fx-body"></div></div>`);
      this.el.appendChild(w);
      const r = this.el.getBoundingClientRect();
      const n = this.effWins.size;
      const x = ev?.clientX != null ? ev.clientX - r.left + 18 : 40 + n * 24, y = ev?.clientY != null ? ev.clientY - r.top - 40 : 60 + n * 24;
      w.style.left = Math.max(4, Math.min(x, r.width - 330)) + 'px';
      w.style.top = Math.max(4, Math.min(y, r.height - 260)) + 'px';
      $('.fx-x', w).onclick = () => this.closeEffects(fid);
      this.dragWindow(w, $('.fx-title', w));
      this.effWins.set(fid, w);
    }
    w.dataset.k = '';
    this.el.appendChild(w); // bring to front
    this.renderEffects();
  }

  closeEffects(fid) {
    const w = this.effWins?.get(fid);
    if (w) { w.remove(); this.effWins.delete(fid); }
  }

  // moves a window by its title bar, kept inside the fight screen
  dragWindow(w, handle) {
    handle.onpointerdown = (e) => {
      if (e.target.closest('button')) return;
      e.preventDefault();
      this.el.appendChild(w);
      const r = this.el.getBoundingClientRect(), wr = w.getBoundingClientRect();
      const dx = e.clientX - wr.left, dy = e.clientY - wr.top;
      handle.setPointerCapture(e.pointerId);
      handle.onpointermove = (m) => {
        w.style.left = Math.max(0, Math.min(m.clientX - r.left - dx, r.width - wr.width)) + 'px';
        w.style.top = Math.max(0, Math.min(m.clientY - r.top - dy, r.height - 24)) + 'px';
      };
      handle.onpointerup = () => { handle.onpointermove = null; handle.onpointerup = null; };
    };
  }

  // one line per buff: icon, effect text with its value, turns left, caster and spell
  buffLine(b) {
    const data = this.data;
    const E = b.effect ? LANG.effects[b.effect.id] : null;
    const spIcon = b.spell != null && b.spell > 0 ? `/assets/spells/${b.spell}.png` : null;
    let text = '', icon = E && E.c >= 0 ? `/assets/ui/effects/${E.c}.png` : null;
    if (b.kind === 'stat') {
      const lbl = data.statLabels[b.stat] || b.stat;
      text = `${b.value > 0 ? '+' : ''}${b.value} ${lbl}`;
      const c = STAT_ICON()[b.stat + (b.value < 0 ? '-' : '+')] ?? STAT_ICON()[b.stat + '+'];
      if (c != null) icon = `/assets/ui/effects/${c}.png`;
    } else if (b.kind === 'state') {
      text = `Estado: ${LANG.states[b.state] || b.state}`;
      icon = `/assets/ui/states/${b.state}.png`;
    } else if (b.kind === 'invis') text = 'Invisível';
    else if (b.kind === 'skip') text = 'Perde o próximo turno';
    else if (b.kind === 'look') text = 'Aparência alterada';
    else if (b.kind === 'evade') text = 'Esquiva corpo a corpo (recua ao ser atacado)';
    else if (b.kind === 'sacrifice') text = 'Sacrifício: o Sacrier recebe os danos no lugar';
    else if (b.kind === 'onDamage') text = `Castigo: ganha ${esc(data.statLabels[b.stat] || '')} ao sofrer dano (máx. ${b.effect?.max ?? ''})`;
    else if (b.kind === 'spellDmg' || b.kind === 'spellAp' || b.kind === 'spellCrit') {
      const sp = data.spells[b.effect?.min]?.name || 'feitiço';
      text = b.kind === 'spellDmg' ? `+${b.value} de dano em ${sp}` : b.kind === 'spellAp' ? `-${b.value} PA no custo de ${sp}` : `+${b.value} de chance de crítico em ${sp}`;
    } else if (E && E.d) {
      const e = b.effect;
      const v = b.value != null && ['reduce', 'reflect', 'apPoison', 'erosion'].includes(b.kind) ? b.value : null;
      const p = { 1: v ?? (e.min >= 0 ? e.min : undefined), 2: v == null && e.max > e.min ? e.max : undefined, 3: e.special >= 0 ? e.special : undefined };
      if (b.kind === 'apPoison') { p[1] = 1; p[2] = b.value; }
      text = langText(E.d, p);
    } else text = BUFF_NAMES[b.kind] || b.kind;
    const caster = this.fighter(b.caster);
    const src = b.spell != null ? data.spells[b.spell]?.name : b.weapon ? data.items[b.weapon]?.name : null;
    const turns = b.duration < 0 ? 'infinito' : `${b.duration} turno${b.duration === 1 ? '' : 's'}`;
    return `<div class="fx-line ${b.kind === 'stat' && b.value < 0 ? 'neg' : ''}">
      <span class="fx-ic">${icon || spIcon ? `<img src="${icon || spIcon}" alt="" data-fb="${icon ? spIcon || '' : ''}" onerror="if(this.dataset.fb){this.src=this.dataset.fb;this.dataset.fb=''}else this.remove()">` : ''}</span>
      <div class="fx-txt"><div><b>${esc(text)}</b> <span class="fx-turns">(${turns})</span>${b.dispellable ? '' : ' <img class="fx-lock" src="/assets/ui/hud/NonDispellableIcon.png" alt="" title="Não pode ser desenfeitiçado">'}</div>
        <div class="fx-src">${spIcon ? `<img src="${spIcon}" alt="" onerror="this.remove()">` : ''}${esc(caster ? caster.name : '?')}${src ? ' · ' + esc(src) : ''}</div></div></div>`;
  }

  renderEffects() {
    if (!this.effWins?.size) return;
    for (const [fid, w] of this.effWins) {
      const f = this.fighter(fid);
      if (!f) { this.closeEffects(fid); continue; }
      const list = (f.buffs || []).filter(b => !(b.kind === 'stat' && !b.value));
      const key = JSON.stringify([f.life, f.dead, f.ap, f.mp, list.map(b => [b.uid, b.duration, b.value])]);
      if (w.dataset.k === key) continue;
      w.dataset.k = key;
      $('.fx-title span', w).innerHTML = `${esc(f.name)} <small>(${Math.max(0, f.life)} PV${f.dead ? ' · morto' : ''})</small>`;
      w.classList.toggle('t0', f.team === 0); w.classList.toggle('t1', f.team === 1);
      $('.fx-body', w).innerHTML = list.length ? list.map(b => this.buffLine(b)).join('') : '<div class="fx-none">Nenhum efeito ativo.</div>';
    }
  }

  castables() {
    const me = this.me();
    if (!me?.spells) return [];
    const list = me.spells.map(s => ({ kind: 'spell', id: s.id, level: s.level, def: this.data.spells[s.id] }))
      .filter(c => c.def).map(c => ({ ...c, lv: c.def.levels[c.level - 1] }));
    if (me.weapon) {
      const w = this.data.items[me.weapon];
      list.unshift({ kind: 'weapon', id: w.id, def: { name: w.name }, lv: { ap: w.weapon.ap, minRange: w.weapon.minRange, maxRange: w.weapon.maxRange, boostRange: false, los: true, lineOnly: false, effects: [], critical: [] }, weapon: w });
    }
    return list;
  }

  // Places of the spell bar: 2 pages of 20 (keys 1-0 and Q-P on each). Without a saved layout the 20 class
  // spells start on page 1 and the others (special spell, Dopple, common spells) on page 2.
  barLayout() {
    const me = this.me();
    const spells = this.castables().filter(c => c.kind === 'spell');
    const out = new Array(BAR_SLOTS).fill(null);
    const saved = me?.slots || null;
    const rest = [];
    for (const c of spells) {
      const p = saved ? saved[c.id] : undefined;
      if (p != null && p >= 0 && p < BAR_SLOTS && !out[p]) out[p] = c; else rest.push(c);
    }
    const base = new Set((this.data.classSpells[me?.cls] || []).slice(0, 20));
    const free = (from) => { for (let i = 0; i < BAR_SLOTS; i++) { const p = (from + i) % BAR_SLOTS; if (!out[p]) return p; } return -1; };
    for (const c of rest) { const p = free(base.has(c.id) ? 0 : PAGE_SLOTS); if (p >= 0) out[p] = c; }
    return out;
  }

  setBarPage(p, force) {
    const n = Math.max(0, Math.min(BAR_PAGES - 1, p));
    if (n === this.barPage) return;
    this.barPage = n;
    $('#tip', this.el).style.display = 'none';
    this.renderBar(force);
  }

  renderBar(force) {
    const me = this.me();
    const bar = $('#bar', this.el);
    if (!me) { bar.innerHTML = ''; return; }
    if (this.dragFrom != null && !force) return; // don't rebuild the bar under a drag (except to turn the page)
    this.barPage ??= 0;
    const mine = this.state.phase === 'fighting' && this.state.current === me.id;
    const all = this.castables();
    const weapon = all.find(c => c.kind === 'weapon');
    const layout = this.barLayout();
    this.layout = layout;
    const page = this.barPage, first = page * PAGE_SLOTS;
    const items = [];
    const btn = (c, slot, pos, style) => {
      const i = items.push(c) - 1;
      const cd = me.cooldowns?.[c.id];
      const used = c.kind === 'spell' ? (me.turnCasts?.[c.id] || 0) : (me.turnCasts?.weapon || 0);
      const limit = c.kind === 'spell' ? c.lv.perTurn : 1;
      // MouseShortcuts.setSpellStateOnContainer: an unusable shortcut is drawn at 50% brightness and a spell
      // waiting for its cooldown shows the number of turns left
      const u = me.usable ? me.usable[c.kind === 'weapon' ? 'weapon' : c.id] : 1;
      const off = this.state.phase === 'fighting' && (u !== undefined ? u !== 1 : (me.ap < c.lv.ap || cd || (limit && used >= limit)));
      const wrongState = off && u === 'state';
      const sel = this.selected && this.selected.kind === c.kind && this.selected.id === c.id;
      const src = c.kind === 'weapon' ? itemIcon(c.weapon) : `/assets/spells/${c.id}.png`;
      const key = keys.label(keys.keyOf(slot));
      return `<button class="sbtn ${c.kind === 'weapon' ? 'cc' : ''} ${off ? 'off' : ''} ${wrongState ? 'wstate' : ''} ${sel ? 'sel' : ''} ${mine ? '' : 'wait'}" data-i="${i}" data-slot="${slot}" ${pos != null ? `data-pos="${pos}"` : ''} ${c.kind === 'spell' ? 'draggable="true"' : ''} style="${style}"><img src="${src}" alt="" draggable="false" onerror="this.style.visibility='hidden'">${cd ? `<span class="cd">${cd}</span>` : ''}${key ? `<i class="key">${esc(key)}</i>` : ''}</button>`;
    };
    let html = weapon ? btn(weapon, 'weapon', null, '') : '';
    for (let k = 0; k < PAGE_SLOTS; k++) {
      const pos = first + k, c = layout[pos];
      const style = `grid-row:${1 + Math.floor(k / 10)};grid-column:${2 + (k % 10)}`;
      if (c) html += btn(c, 's' + k, pos, style);
      else html += `<div class="sbtn empty" data-pos="${pos}" style="${style}"></div>`;
    }
    // page selector (the wheel over the grid turns the page too)
    html += `<div class="bpage" style="grid-row:1 / span 2;grid-column:12"><button data-pg="-1" title="Página anterior" ${page === 0 ? 'disabled' : ''}>▲</button><span>${page + 1}</span><button data-pg="1" title="Próxima página" ${page === BAR_PAGES - 1 ? 'disabled' : ''}>▼</button></div>`;
    bar.innerHTML = html;
    bar.onwheel = (e) => { if (!e.deltaY) return; e.preventDefault(); this.setBarPage(this.barPage + (e.deltaY > 0 ? 1 : -1), this.dragFrom != null); };
    bar.querySelectorAll('.bpage button').forEach(b => {
      b.onclick = () => this.setBarPage(this.barPage + Number(b.dataset.pg));
      // while dragging a spell, hovering an arrow turns the page
      b.ondragover = (e) => { if (this.dragFrom == null) return; e.preventDefault(); this.setBarPage(this.barPage + Number(b.dataset.pg), true); };
    });
    const dropTarget = (el) => {
      el.ondragover = (e) => { if (this.dragFrom == null) return; e.preventDefault(); el.classList.add('over'); };
      el.ondragleave = () => el.classList.remove('over');
      el.ondrop = (e) => { e.preventDefault(); el.classList.remove('over'); this.dropSpell(this.dragFrom, Number(el.dataset.pos)); };
    };
    bar.querySelectorAll('.sbtn.empty').forEach(dropTarget);
    bar.querySelectorAll('[data-i]').forEach(b => {
      const c = items[Number(b.dataset.i)];
      b.onclick = () => {
        if (!this.myTurn() || b.classList.contains('off')) return; // a greyed shortcut cannot be selected
        this.select(this.selected && this.selected.id === c.id && this.selected.kind === c.kind ? null : c);
      };
      b.onmouseenter = () => this.showSpellTip(c, b);
      b.onmouseleave = () => { $('#tip', this.el).style.display = 'none'; };
      b.oncontextmenu = (e) => { e.preventDefault(); this.slotMenu(b.dataset.slot, c, e); };
      if (c.kind !== 'spell') return;
      // drag a spell onto another place of the bar, on this page or the other one (saved with the character)
      b.ondragstart = (e) => { this.dragFrom = Number(b.dataset.pos); b.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(c.id)); $('#tip', this.el).style.display = 'none'; };
      b.ondragend = () => { b.classList.remove('dragging'); const moved = this.dragFrom == null; this.dragFrom = null; if (!moved) this.renderBar(); };
      dropTarget(b);
    });
  }

  // from / to: places on the bar. An occupied place swaps with the dragged spell (like 1.29), an empty one takes it.
  dropSpell(from, to) {
    this.dragFrom = null;
    const me = this.me();
    const layout = this.layout || this.barLayout();
    if (!me?.spells || from == null || to == null || from === to || !layout[from]) { this.renderBar(); return; }
    [layout[from], layout[to]] = [layout[to], layout[from]];
    const slots = {};
    layout.forEach((c, p) => { if (c) slots[c.id] = p; });
    const ids = layout.filter(Boolean).map(c => c.id);
    for (const s of me.spells) if (!ids.includes(s.id)) ids.push(s.id);
    me.spells = ids.map(id => me.spells.find(s => s.id === id));
    me.slots = slots;
    this.send({ t: 'spellOrder', order: ids, slots });
    this.renderBar();
  }

  // right click on a shortcut: set or remove its key
  slotMenu(slot, c, e) {
    this.closeMenu();
    const key = keys.keyOf(slot);
    const m = h(`<div class="ctxmenu"><div class="cm-title">${esc(c.def.name)}</div>
      <button data-a="set">Definir atalho${key ? ` (atual: ${esc(keys.label(key))})` : ''}</button>
      ${key ? '<button data-a="del">Remover atalho</button>' : ''}
      <button data-a="reset">Restaurar atalhos padrão</button></div>`);
    const r = this.el.getBoundingClientRect();
    m.style.left = Math.min(e.clientX - r.left, r.width - 200) + 'px';
    m.style.top = Math.max(4, e.clientY - r.top - 110) + 'px';
    this.el.appendChild(m);
    this.menu = m;
    m.querySelectorAll('button').forEach(b => b.onclick = () => {
      const a = b.dataset.a;
      this.closeMenu();
      if (a === 'set') this.startRebind(slot, c);
      if (a === 'del') { keys.unbind(slot); this.renderBar(); }
      if (a === 'reset') { keys.reset(); this.renderBar(); }
    });
    setTimeout(() => { this.menuOff = (ev) => { if (!m.contains(ev.target)) this.closeMenu(); }; window.addEventListener('mousedown', this.menuOff); }, 0);
  }

  closeMenu() {
    if (this.menu) { this.menu.remove(); this.menu = null; }
    if (this.menuOff) { window.removeEventListener('mousedown', this.menuOff); this.menuOff = null; }
  }

  startRebind(slot, c) {
    this.rebinding = slot;
    const box = h(`<div class="rebind"><div><b>${esc(c.def.name)}</b><br>Pressione a tecla do atalho<br><small>Esc cancela · Backspace remove</small></div></div>`);
    box.onclick = () => this.stopRebind();
    this.el.appendChild(box);
    this.rebindBox = box;
  }

  onRebindKey(e) {
    e.preventDefault();
    if (e.code === 'Escape') return this.stopRebind();
    if (e.code === 'Backspace' || e.code === 'Delete') { keys.unbind(this.rebinding); return this.stopRebind(); }
    if (!keys.allowed(e.code)) return;
    keys.bind(this.rebinding, e.code);
    this.stopRebind();
  }

  stopRebind() {
    this.rebinding = null;
    this.rebindBox?.remove();
    this.rebindBox = null;
    this.renderBar();
  }

  showSpellTip(c, btn) {
    const tip = $('#tip', this.el);
    let html = `<b>${esc(c.def.name)}</b>${c.level ? ` (nível ${c.level})` : ''}<br>${c.lv.ap} PA · alcance ${c.lv.minRange}-${c.lv.maxRange}${c.lv.boostRange ? ' (+alcance)' : ''}`;
    if (c.kind === 'weapon') {
      html += '<br>' + c.weapon.effects.filter(e => e[0] >= 91 && e[0] <= 101).map(([id, min, max]) => effectText({ id, min, max, duration: 0 })).join('<br>');
    } else {
      html += (c.lv.lineOnly ? ' · em linha' : '') + (c.lv.los ? '' : ' · sem linha de visão') + (c.lv.perTurn ? ` · ${c.lv.perTurn}x/turno` : '') + (c.lv.cooldown ? ` · recarga ${c.lv.cooldown}` : '');
      html += '<br>' + c.lv.effects.map(e => '• ' + effectText(e)).join('<br>');
      if (c.def.desc) html += `<div class="desc">${esc(c.def.desc)}</div>`;
    }
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = btn.getBoundingClientRect(), pr = this.cv.getBoundingClientRect();
    tip.style.left = Math.max(4, Math.min(r.left - pr.left, this.w - 300)) + 'px';
    tip.style.top = Math.max(4, pr.height - 8 - tip.offsetHeight) + 'px';
  }

  select(c) {
    this.selected = c;
    // the spell icon follows the mouse while a spell is selected (25x25 at +15,+15, like ui.setCursor)
    const cur = $('#scur', this.el);
    if (c) $('img', cur).src = c.kind === 'weapon' ? itemIcon(c.weapon) : `/assets/spells/${c.id}.png`;
    else cur.style.display = 'none';
    this.renderBar();
  }

  castAt(cell) {
    const c = this.selected;
    if (!c) return;
    this.send(c.kind === 'weapon' ? { t: 'cast', kind: 'weapon', spell: c.id, cell } : { t: 'cast', kind: 'spell', spell: c.id, cell });
    this.select(null);
  }

  canUseSelected() {
    const me = this.me(), c = this.selected;
    if (!me || !c || !(this.state.phase === 'fighting' && this.state.current === me.id)) return false;
    const u = me.usable ? me.usable[c.kind === 'weapon' ? 'weapon' : c.id] : 1;
    return u !== undefined ? u === 1 : me.ap >= c.lv.ap;
  }

  // ---------------------------------------------------------------- rules on the client (preview only)

  occupied(cell) { return this.state.fighters.some(f => !f.dead && f.cell === cell); }
  at(cell) { return this.state.fighters.find(f => !f.dead && f.cell === cell); }

  reachable() {
    const me = this.me();
    const dist = new Map();
    if (!me || me.cell < 0) return dist;
    dist.set(me.cell, 0);
    const adjEnemy = (c) => this.map.neighbors(c).some(n => { const o = this.at(n); return o && o.team !== me.team && !o.static; });
    const queue = [me.cell];
    while (queue.length) {
      const c = queue.shift();
      const d = dist.get(c);
      if (d >= me.mp) continue;
      if (c !== me.cell && adjEnemy(c)) continue;
      for (const n of this.map.neighbors(c)) {
        if (dist.has(n) || !this.map.cells[n].walk || this.occupied(n)) continue;
        dist.set(n, d + 1);
        queue.push(n);
      }
    }
    return dist;
  }

  pathTo(to) {
    const me = this.me();
    const prev = new Map([[me.cell, -1]]);
    const q = [me.cell];
    while (q.length) {
      const c = q.shift();
      if (c === to) break;
      for (const n of this.map.neighbors(c)) {
        if (prev.has(n) || !this.map.cells[n].walk || this.occupied(n)) continue;
        prev.set(n, c); q.push(n);
      }
    }
    if (!prev.has(to)) return null;
    const p = [];
    for (let c = to; c !== -1; c = prev.get(c)) p.unshift(c);
    return p;
  }

  // Range of the selected spell, with ok = castable on that cell. Mirrors the per-cell checks of
  // Fight.canCast on the server (SpellsManager.checkCanLaunchSpellOnCell), so a cell drawn as castable never fails.
  rangeCells(c) {
    const me = this.me();
    const lv = c.lv;
    let max = lv.maxRange + (lv.boostRange ? me.stats.range : 0);
    max = Math.max(max, lv.minRange);
    const key = c.kind === 'weapon' ? 'weapon' : c.id;
    const hits = (me.turnTargets && me.turnTargets[key]) || {};
    const needsFree = lv.freeCell || (lv.effects || []).some(e => [180, 181, 185, 4, 400, 401, 402].includes(e.id));
    const out = [];
    for (const cell of this.map.cells) {
      if (!cell.active) continue;
      const target = this.castTarget(cell.id);
      if (!cell.walk && !target) continue;
      const d = this.map.dist(me.cell, cell.id);
      if (d < lv.minRange || d > max) continue;
      if (lv.lineOnly && !this.map.inLine(me.cell, cell.id)) continue;
      let ok = !(needsFree && target);
      if (ok && lv.perTarget > 0 && target && (hits[target.id] || 0) >= lv.perTarget) ok = false;
      if (ok && lv.los) ok = this.map.lineOfSight(me.cell, cell.id, id => !this.map.cells[id].los || !!this.castTarget(id));
      out.push({ id: cell.id, ok });
    }
    return out;
  }

  // the fighter a spell cast on this cell hits (Fight.at on the server: a carried fighter is not a target)
  castTarget(cell) { return this.state.fighters.find(f => !f.dead && f.cell === cell && !f.carriedBy); }

  // ---------------------------------------------------------------- input

  onMove(e) {
    const r = this.cv.getBoundingClientRect();
    this.mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.hover = this.cellAtMouse(this.mouse.x, this.mouse.y);
    const f = (this.hover >= 0 && this.at(this.hover)) || this.spriteAtMouse();
    this.hoverF = f ? f.id : null;
    this.showFighterInfo(f || null);
    const cur = $('#scur', this.el);
    if (this.selected && this.myTurn()) {
      cur.style.display = 'block';
      cur.style.left = this.mouse.x + 15 + 'px';
      cur.style.top = this.mouse.y + 15 + 'px';
      const cell = f && f.cell >= 0 ? f.cell : this.hover;
      cur.classList.toggle('no', !this.rangeCells(this.selected).some(r => r.id === cell && r.ok));
    } else cur.style.display = 'none';
  }

  // the sprite under the mouse (its body, not only its cell), like rolling over the sprite clip in Flash
  spriteAtMouse() {
    const [wx, wy] = this.toWorld(this.mouse.x, this.mouse.y);
    let best = null;
    for (const f of this.state.fighters) {
      const p = this.pos[f.id];
      if (!p || f.dead || p.hidden || f.cell < 0) continue;
      if (Math.abs(wx - p.x) < 14 && wy < p.y + 4 && wy > p.y - 62 && (!best || p.y > this.pos[best.id].y)) best = f;
    }
    return best;
  }

  // BannerSpriteInfos: hovering a fighter (on the map or the timeline) replaces the shortcut grid with its
  // artwork, name, level, life, AP, MP, the five resistances and the AP/MP dodge
  showFighterInfo(f) {
    const box = $('#finfo', this.el), bar = $('#bar', this.el);
    if (!f && this.tlHover != null) f = this.fighter(this.tlHover);
    if (!f) { if (this.infoFor != null) { box.style.display = 'none'; bar.style.display = ''; this.infoFor = null; } return; }
    const s = f.stats;
    const key = f.id + ':' + f.life + ':' + f.buffs.length + ':' + f.ap + ':' + f.mp;
    if (this.infoFor === key) return;
    this.infoFor = key;
    const res = (k, n) => `<span class="r r${k}" title="${n}"><i></i>${s['rp' + k] || 0}%</span>`;
    const buffs = f.buffs.filter(b => b.kind !== 'look' && (b.kind !== 'stat' || b.value)).slice(0, 10).map(b =>
      `<span class="bf ${b.kind === 'stat' && b.value < 0 ? 'neg' : ''}">${b.kind === 'stat' ? `${b.value > 0 ? '+' : ''}${b.value} ${esc(STAT_SHORT[b.stat] || b.stat)}` : esc(BUFF_NAMES[b.kind] || b.kind)}${b.duration > 0 ? ` <small>${b.duration}</small>` : ''}</span>`).join('');
    const pa = this.state.current === f.id ? f.ap : s.ap, pm = this.state.current === f.id ? f.mp : s.mp;
    const art = f.cls ? `<img src="/assets/classes/${f.gfx}.png" alt="">` : '<canvas width="70" height="70"></canvas>';
    box.innerHTML = `<div class="fi-art t${f.team}">${art}</div>
      <div class="fi-main">
        <div class="fi-head"><b>${esc(f.name)}</b> <span>Nível ${f.level}</span></div>
        <div class="fi-row"><span class="lf">${Math.max(0, f.life)}</span><span class="pa">${Math.max(0, pa)}</span><span class="pm">${Math.max(0, pm)}</span></div>
        ${buffs ? `<div class="fi-row buffs">${buffs}</div>` : ''}
      </div>
      <div class="fi-res"><div class="fi-t">Resistências</div>
        <div class="res">${res('N', 'Neutro')}${res('E', 'Terra')}${res('F', 'Fogo')}${res('W', 'Água')}${res('A', 'Ar')}</div>
        <div class="dodge"><span title="Esquiva PA">Esq. PA ${s.dodgeAP || 0}</span><span title="Esquiva PM">Esq. PM ${s.dodgeMP || 0}</span></div></div>`;
    const cv = $('canvas', box);
    if (cv) this.drawPortrait(cv, f.gfx);
    box.style.display = 'flex';
    bar.style.display = 'none';
  }

  onClick(e) {
    this.onMove(e);
    const hf = this.hoverF != null && this.fighter(this.hoverF);
    const cell = this.selected && hf && hf.cell >= 0 ? hf.cell : this.hover;
    if (cell < 0) return;
    const st = this.state;
    const me = this.me();
    if (!me) return;
    // clicking a fighter without a spell selected opens its effects window
    // (during placement, clicking a teammate on one of your start cells still swaps places)
    const placeSwap = st.phase === 'placement' && hf && hf.team === me.team && hf.id !== me.id && this.map.placement[me.team].includes(cell);
    if (hf && !(this.selected && this.myTurn()) && !placeSwap) { this.openEffects(hf.id, e); return; }
    if (st.phase === 'placement') {
      if (this.map.placement[me.team].includes(cell)) this.send({ t: 'place', cell });
      return;
    }
    if (!this.myTurn()) return;
    if (this.selected) { this.castAt(cell); return; }
    const reach = this.reachable();
    if (reach.has(cell) && cell !== me.cell) this.send({ t: 'move', cell });
  }

  // ---------------------------------------------------------------- drawing

  loop() {
    this.raf = requestAnimationFrame(this.loop);
    this.draw();
  }

  toggleTactical() {
    this.tactical = !this.tactical;
    try { localStorage.setItem('tactical', this.tactical ? '1' : '0'); } catch {}
    $('#tac', this.el)?.classList.toggle('on', this.tactical);
  }

  // Tactical mode: flat cells instead of the map art (floor, holes, and blocks that stop sight)
  drawTactical() {
    const c = this.ctx;
    c.fillStyle = '#20251c';
    const img = this.mapJson.img;
    c.fillRect(-60, -img.padY / 2, img.w / 2 + 120, img.h / 2 + 60);
    for (const cell of this.map.cells) {
      if (!cell.active) continue;
      const p = this.cellPos[cell.id]; if (!p) continue;
      if (cell.walk) this.diamond(cell.id, (cell.x + cell.y) % 2 ? '#a9b88a' : '#9fae80', 'rgba(40,50,30,.35)', 0.5);
      else if (!cell.los) {
        // obstacle that blocks line of sight: a raised block
        const w = CELL_W / 2 - 1, hh = CELL_H / 2 - 0.5, up = 10;
        c.fillStyle = '#4a4f45'; c.beginPath(); c.moveTo(p.x - w, p.y); c.lineTo(p.x, p.y + hh); c.lineTo(p.x, p.y + hh - up); c.lineTo(p.x - w, p.y - up); c.closePath(); c.fill();
        c.fillStyle = '#3b4037'; c.beginPath(); c.moveTo(p.x + w, p.y); c.lineTo(p.x, p.y + hh); c.lineTo(p.x, p.y + hh - up); c.lineTo(p.x + w, p.y - up); c.closePath(); c.fill();
        c.fillStyle = '#6a7064'; c.beginPath(); c.moveTo(p.x, p.y - hh - up); c.lineTo(p.x + w, p.y - up); c.lineTo(p.x, p.y + hh - up); c.lineTo(p.x - w, p.y - up); c.closePath(); c.fill();
      } else this.diamond(cell.id, '#2d3328', null, 1); // hole: can't walk, can see through
    }
  }

  // Estimated damage/heal of the selected spell on everyone in its area, shown over their heads
  estimate(me, t, e, weapon) {
    const ELEM = { 96: 'W', 97: 'E', 98: 'A', 99: 'F', 100: 'N', 91: 'W', 92: 'E', 93: 'A', 94: 'F', 95: 'N' };
    const STAT = { N: 'str', E: 'str', F: 'int', W: 'cha', A: 'agi' };
    const s = me.stats, ts = t.stats;
    const el = ELEM[e.id];
    const lo = Math.max(e.min, 0), hi = e.max > e.min ? e.max : lo;
    if (el) {
      const skill = weapon ? (this.data.classes[me.cls]?.weapons?.[weapon.type] ?? 90) / 100 : 1;
      const f = (v) => {
        let d = Math.floor(Math.floor(v * Math.max(100 + (s[STAT[el]] || 0) + (s.pdmg || 0), 0) / 100) * skill);
        d += (s.dmg || 0) + (el === 'N' || el === 'E' ? (s.phys || 0) : 0);
        d = Math.floor(Math.max(d, 0) * (100 - Math.min(ts['rp' + el] || 0, 50)) / 100) - (ts['rf' + el] || 0);
        return Math.max(d, 0);
      };
      return { kind: 'dmg', el, min: f(lo), max: f(hi) };
    }
    if (e.id === 108) {
      const f = (v) => Math.floor(v * (100 + (s.int || 0)) / 100) + (s.heal || 0);
      return { kind: 'heal', min: f(lo), max: f(hi) };
    }
    return null;
  }

  weaponArea(w) { return w.type === 7 || w.type === 4 ? 'Tb' : w.type === 8 || w.type === 22 ? 'Lb' : 'Pa'; }

  drawGrid() {
    const c = this.ctx;
    c.save();
    c.strokeStyle = this.tactical ? 'rgba(40,50,30,.35)' : 'rgba(255,255,255,.16)';
    c.lineWidth = 1 / this.k;
    c.beginPath();
    for (const cell of this.map.cells) {
      if (!cell.active || !cell.walk) continue;
      const p = this.cellPos[cell.id]; if (!p) continue;
      const w = CELL_W / 2, hh = CELL_H / 2;
      c.moveTo(p.x, p.y - hh); c.lineTo(p.x + w, p.y); c.lineTo(p.x, p.y + hh); c.lineTo(p.x - w, p.y); c.closePath();
    }
    c.stroke();
    c.restore();
  }

  drawDamagePreview(me) {
    const c = this.ctx, sel = this.selected;
    const hf = this.hoverF != null && this.fighter(this.hoverF);
    const target = hf && hf.cell >= 0 ? hf.cell : this.hover;
    const r = this.rangeCells(sel).find(x => x.id === target && x.ok);
    if (!r) return;
    let effects = sel.lv.effects;
    if (sel.kind === 'weapon') {
      effects = sel.weapon.effects.filter(e => (e[0] >= 91 && e[0] <= 100) || e[0] === 108)
        .map(([id, min, max]) => ({ id, min, max, area: this.weaponArea(sel.weapon), target: 0, duration: 0 }));
    }
    const per = new Map();
    for (const e of effects) {
      if (e.duration > 0 || e.chance) continue;
      for (const id of this.map.area(e.area || 'Pa', me.cell, target)) {
        const t = this.at(id); if (!t) continue;
        if (e.target & 32 && t.id !== me.id) continue;
        const est = this.estimate(me, t, e, sel.kind === 'weapon' ? sel.weapon : null);
        if (!est) continue;
        const cur = per.get(t.id) || { t, dmg: [0, 0], heal: [0, 0], el: est.el };
        cur[est.kind][0] += est.min; cur[est.kind][1] += est.max;
        per.set(t.id, cur);
      }
    }
    c.save(); c.font = 'bold 11px Verdana, sans-serif'; c.textAlign = 'center'; c.lineWidth = 3; c.strokeStyle = 'rgba(0,0,0,.8)';
    for (const { t, dmg, heal, el } of per.values()) {
      const p = this.pos[t.id]; if (!p) continue;
      let y = p.y - 84;
      for (const [txt, col] of [[dmg[1] ? `-${dmg[0]}${dmg[1] !== dmg[0] ? ' a ' + dmg[1] : ''}` : '', DMG_COLOR[el] || '#ff5a3c'], [heal[1] ? `+${heal[0]}${heal[1] !== heal[0] ? ' a ' + heal[1] : ''}` : '', '#5fd35f']]) {
        if (!txt) continue;
        c.fillStyle = col; c.strokeText(txt, p.x, y); c.fillText(txt, p.x, y); y -= 13;
      }
    }
    c.restore();
  }

  diamond(id, fill, stroke, inset = 1) {
    const p = this.cellPos[id]; if (!p) return;
    const c = this.ctx, w = CELL_W / 2 - inset, hh = CELL_H / 2 - inset / 2;
    c.beginPath();
    c.moveTo(p.x, p.y - hh); c.lineTo(p.x + w, p.y); c.lineTo(p.x, p.y + hh); c.lineTo(p.x - w, p.y); c.closePath();
    if (fill) { c.fillStyle = fill; c.fill(); }
    if (stroke) { c.strokeStyle = stroke; c.lineWidth = 1 / this.k; c.stroke(); }
  }

  // ank.battlefield.mc.Zone: the whole shape filled at 30% in the zone color, then one opaque 1px line along
  // the outer border only (no inner grid lines). Each cell sits at its own ground level (cellPos).
  drawZone(z) {
    const c = this.ctx, W = this.W, color = z.rgb || '#ffffff';
    const set = new Set(z.cells);
    const w = CELL_W / 2, hh = CELL_H / 2;
    c.save();
    c.globalAlpha = 0.3; c.fillStyle = color;
    c.beginPath();
    for (const id of set) {
      const p = this.cellPos[id]; if (!p) continue;
      c.moveTo(p.x, p.y - hh); c.lineTo(p.x + w, p.y); c.lineTo(p.x, p.y + hh); c.lineTo(p.x - w, p.y); c.closePath();
    }
    c.fill();
    c.globalAlpha = 1; c.strokeStyle = color; c.lineWidth = 1; c.lineCap = 'round';
    c.beginPath();
    for (const id of set) {
      const p = this.cellPos[id]; if (!p) continue;
      const N = [p.x, p.y - hh], E = [p.x + w, p.y], S = [p.x, p.y + hh], Wp = [p.x - w, p.y];
      // neighbours across each edge: NE = id-(W-1), SE = id+W, SW = id+(W-1), NW = id-W
      for (const [nb, a, b] of [[id - (W - 1), N, E], [id + W, E, S], [id + (W - 1), S, Wp], [id - W, Wp, N]]) {
        if (set.has(nb)) continue;
        c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
      }
    }
    c.stroke();
    c.restore();
  }

  draw() {
    const c = this.ctx, st = this.state, me = this.me();
    const now = performance.now();
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#000';
    c.fillRect(0, 0, this.cv.width, this.cv.height);
    const d = this.dpr;
    c.setTransform(this.k * d, 0, 0, this.k * d, this.offX * d, this.offY * d);
    // map: background + ground + flat objects, pre-rendered at 2x
    const img = this.mapJson.img;
    if (this.tactical) this.drawTactical();
    else if (this.bg) c.drawImage(this.bg, 0, -img.padY / 2, img.w / 2, img.h / 2);

    // cell overlays
    if (st.phase === 'placement') {
      for (const t of [0, 1]) for (const id of this.map.placement[t]) this.diamond(id, C129.team[t], null, 0.5);
    }
    // the client draws the cell grid once the fight is running (Game.onStartToPlay -> gfx.drawGrid)
    if (st.phase !== 'placement') this.drawGrid();
    // glyphs and traps: Zone.drawCircle (fill ALPHA 30) + drawCircleBorder (1px opaque outer outline), own color each
    for (const t of st.traps) this.drawZone(t);
    for (const g of st.glyphs) this.drawZone(g);
    const mine = me && st.phase === 'fighting' && st.current === me.id && !this.busy;
    if (mine && me.cell >= 0) {
      if (this.selected) {
        // spell range like GameManager.drawAllowedZone with AdvancedLineOfSight: the whole range in pale blue,
        // then a second overlay (0x0066CC, alpha 50) on the cells where the spell can really be cast
        const cells = this.rangeCells(this.selected);
        for (const r of cells) this.diamond(r.id, C129.range, null, 0.5);
        for (const r of cells) if (r.ok) this.diamond(r.id, C129.rangeOk, null, 0.5);
        const hf = this.hoverF != null && this.fighter(this.hoverF);
        const target = hf && hf.cell >= 0 ? hf.cell : this.hover;
        const inRange = cells.find(r => r.id === target && r.ok);
        if (inRange) {
          const zones = new Set();
          if (this.selected.kind === 'spell') for (const e of this.selected.lv.effects) for (const id of this.map.area(e.area || 'Pa', me.cell, target)) zones.add(id);
          else for (const id of this.map.area(this.weaponArea(this.selected.weapon), me.cell, target)) zones.add(id);
          for (const id of zones) this.diamond(id, C129.zone, null, 0.5);
        }
      } else {
        // path preview in orange up to the cell under the mouse, only within the MP left
        const reach = this.reachable();
        if (reach.has(this.hover) && this.hover !== me.cell) {
          const p = this.pathTo(this.hover) || [];
          p.slice(1).forEach(id => this.diamond(id, C129.path, null, 0.5));
        }
      }
    }

    // depth-sorted: layer-2 objects and fighters (Dofus draws in cell order)
    const items = [];
    if (!this.tactical) for (const [cell, gid, flip] of this.mapJson.objs) items.push({ d: cell, kind: 'obj', cell, gid, flip });
    // the trap's own object on its center cell (1.29: GDC<cell>;Haaaaaaaaz3005 -> layer-2 object 25), seen by whoever sees the trap
    for (const t of st.traps) if (!this.trapGone.has(t.id)) items.push({ d: t.cell, kind: 'obj', cell: t.cell, gid: TRAP_OBJECT, t0: this.trapT0.get(t.id) ?? -Infinity });
    for (const f of st.fighters) {
      const p = this.pos[f.id];
      const dyingNow = f.dead && this.dying[f.id] > now;
      const flash = p && p.revealUntil > now;
      if (!p || (f.dead && !dyingNow) || (p.hidden && !flash) || (f.cell < 0 && f.invisible && !dyingNow && !flash)) continue;
      // a carried fighter is drawn on the carrier's hands marker (Sprite.updateCarriedPosition) and moves with it
      const cp = f.carriedBy && this.pos[f.carriedBy];
      if (cp) {
        const cf = this.fighter(f.carriedBy), fr = cf && this.frameOf(cf, now);
        const k = fr && fr.m && fr.m.carry ? fr.m.carry[fr.frame] : undefined;
        if (k === null) continue; // already left the hands (thrown)
        const x = k ? cp.x + (fr.flip ? -k[0] : k[0]) / 2 : cp.x, y = k ? cp.y + k[1] / 2 : cp.y - 38;
        if (this.anim[f.id] && cf) this.anim[f.id].dir = this.anim[cf.id]?.dir || this.anim[f.id].dir;
        items.push({ d: (cp.depth ?? cp.cell) + 0.6, kind: 'fighter', f, p: { ...p, x, y, carried: true } });
        continue;
      }
      items.push({ d: (p.depth ?? p.cell) + 0.5, kind: 'fighter', f, p });
    }
    items.sort((a, b) => a.d - b.d);
    for (const it of items) {
      if (it.kind === 'obj') this.drawObj(it);
      else this.drawFighter(it.f, it.p, now);
    }

    if (mine && this.selected && me.cell >= 0) this.drawDamagePreview(me);

    // spell effects
    this.fx = this.fx.filter(e => e.burst ? now - e.t0 < e.dur : e.path ? (now - e.t0) / 1000 * SPRITE_FPS < e.path.length : (now - e.t0) / 1000 * SPRITE_FPS < e.m.frames);
    for (const e of this.fx) {
      if (e.part) {
        // a piece placed by VisualEffectHandler
        if (now < e.t0) continue;
        const im = imageNow(e.part); if (!im) continue;
        const m = e.m, cols = m.cols || m.frames;
        const step = Math.floor((now - e.t0) / 1000 * SPRITE_FPS);
        const f = e.path ? 0 : Math.min(step, m.frames - 1);
        c.save(); c.translate(e.x, e.y);
        if (e.mirror) c.scale(e.mirror[0], e.mirror[1]);
        if (e.path) { const q = e.path[Math.min(step, e.path.length - 1)]; c.translate(q[0], q[1]); c.rotate(q[2]); }
        if (e.at) { c.translate(e.at[0], e.at[1]); c.rotate(e.rot); }
        if (e.off) { c.translate(e.off[0], e.off[1]); c.rotate(e.rot); c.scale(e.scale[0], e.scale[1]); }
        c.drawImage(im, (f % cols) * m.w, Math.floor(f / cols) * m.h, m.w, m.h, -m.ox / 2, -m.oy / 2, m.w / 2, m.h / 2);
        c.restore();
        continue;
      }
      if (e.burst) {
        const t = (now - e.t0) / e.dur;
        c.save(); c.globalAlpha = 1 - t;
        c.beginPath(); c.ellipse(e.x, e.y, 10 + t * 26, 5 + t * 13, 0, 0, Math.PI * 2);
        c.strokeStyle = e.color; c.lineWidth = 3; c.stroke();
        c.restore();
        continue;
      }
      const im = imageNow(`/assets/fx/${e.sprite}.webp`); if (!im) continue;
      const m = e.m, f = Math.floor((now - e.t0) / 1000 * SPRITE_FPS);
      const cols = m.cols || m.frames;
      if (e.skew) {
        // x axis along the caster -> target line, y axis kept vertical
        c.save(); c.translate(e.x, e.y); c.transform(e.skew[0], e.skew[1], 0, 1, 0, 0);
        c.drawImage(im, (f % cols) * m.w, Math.floor(f / cols) * m.h, m.w, m.h, -m.ox / 2, -m.oy / 2, m.w / 2, m.h / 2);
        c.restore();
      } else c.drawImage(im, (f % cols) * m.w, Math.floor(f / cols) * m.h, m.w, m.h, e.x - m.ox / 2, e.y - m.oy / 2, m.w / 2, m.h / 2);
    }

    // effects run by their own scripts
    this.spellFx = stepFx(this.spellFx, now);
    for (const fx of this.spellFx) fx.draw(c);

    // critical hit clip on the caster: a short golden flash
    this.marks = this.marks.filter(m => now - m.t0 < m.dur);
    for (const m of this.marks) {
      const p = this.pos[m.id]; if (!p) continue;
      const t = (now - m.t0) / m.dur;
      c.save(); c.globalAlpha = 0.85 * (1 - t); c.translate(p.x, p.y - 34);
      c.fillStyle = '#ffd23a'; c.strokeStyle = '#a06a00'; c.lineWidth = 1;
      c.beginPath();
      for (let i = 0; i < 16; i++) { const r = i % 2 ? 5 + t * 6 : 12 + t * 16, a2 = i / 16 * Math.PI * 2; c.lineTo(Math.cos(a2) * r, Math.sin(a2) * r * 0.7); }
      c.closePath(); c.fill(); c.stroke();
      c.restore();
    }

    // screen space from here on
    c.setTransform(d, 0, 0, d, 0, 0);
    this.drawPoints(now);

    // over-head text of the hovered fighter: "Name (life)" during the fight, "Name (level)" before it
    const hid = this.hoverF ?? this.tlHover;
    const hf = hid != null && this.fighter(hid);
    if (hf && this.pos[hf.id] && !hf.dead) {
      const p = this.pos[hf.id];
      const txt = `${hf.name} (${st.phase === 'placement' ? hf.level : Math.max(0, hf.life)})`;
      this.overHead(p, txt, hf.summoner ? '#ffff99' : '#ffffff');
    }
    // ready marker over each fighter during placement
    if (st.phase === 'placement') {
      for (const f of st.fighters) if (f.ready && this.pos[f.id]) {
        const [sx, sy] = this.toScreen(this.pos[f.id].x, this.pos[f.id].y - 66);
        c.fillStyle = '#2fae2f'; c.strokeStyle = '#0d4a0d'; c.lineWidth = 2;
        c.beginPath(); c.arc(sx, sy, 8, 0, Math.PI * 2); c.fill(); c.stroke();
        c.strokeStyle = '#fff'; c.lineWidth = 2.2; c.beginPath(); c.moveTo(sx - 4, sy); c.lineTo(sx - 1, sy + 3); c.lineTo(sx + 4, sy - 3); c.stroke();
      }
    }
    // speech bubbles (critical failure)
    this.bubbles = this.bubbles.filter(b => now - b.t0 < b.dur);
    for (const b of this.bubbles) {
      const p = this.pos[b.id]; if (!p) continue;
      const [sx, sy] = this.toScreen(p.x, p.y - 70);
      c.font = '11px Verdana, sans-serif'; c.textAlign = 'center';
      const w = c.measureText(b.text).width + 16;
      c.fillStyle = '#fff'; c.strokeStyle = '#222'; c.lineWidth = 1;
      c.beginPath(); c.roundRect(sx - w / 2, sy - 26, w, 20, 6); c.fill(); c.stroke();
      c.beginPath(); c.moveTo(sx - 4, sy - 6); c.lineTo(sx, sy + 2); c.lineTo(sx + 4, sy - 6); c.fill();
      c.fillStyle = '#111'; c.fillText(b.text, sx, sy - 12);
    }
  }

  overHead(p, txt, color) {
    const c = this.ctx;
    const [sx, sy] = this.toScreen(p.x, p.y - 64);
    c.font = 'bold 11px Verdana, sans-serif'; c.textAlign = 'center';
    const w = c.measureText(txt).width + 10;
    c.fillStyle = 'rgba(0,0,0,.6)'; c.beginPath(); c.roundRect(sx - w / 2, sy - 13, w, 17, 3); c.fill();
    c.fillStyle = color; c.fillText(txt, sx, sy);
  }

  // ank.battlefield.mc.Points: scale = 100 + sz*sin(i), i += 1.2, sz *= .85; y += vy, vy starts at -20 and is
  // multiplied by .7 each frame; removed once it has risen 46 px. Drawn at 25 frames per second.
  drawPoints(now) {
    const c = this.ctx;
    this.floats = this.floats.filter(f => now - f.t0 < POINT_LIFE_MS);
    for (const f of this.floats) {
      const p = this.pos[f.id];
      if (!p || now < f.t0) continue;
      const n = Math.floor((now - f.t0) / 1000 * POINT_FPS);
      let i = 0, sz = 100, vy = -20, y = 0, sc = 100;
      for (let k = 0; k <= n; k++) { sc = 100 + sz * Math.sin(i += 1.2); sz *= 0.85; y += (vy *= 0.7); }
      const [sx, sy] = this.toScreen(p.x, p.y - 50);
      const fs = 18 * Math.max(0.2, sc / 100) * Math.max(1, this.k * 0.9);
      c.save();
      c.font = `bold ${fs.toFixed(1)}px Verdana, sans-serif`;
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.lineWidth = 3; c.strokeStyle = '#fff'; c.lineJoin = 'round';
      c.strokeText(f.text, sx, sy + y * this.k);
      c.fillStyle = f.color; c.fillText(f.text, sx, sy + y * this.k);
      c.restore();
    }
  }

  drawObj(o) {
    const m = GFX[o.gid];
    if (!m) return;
    const im = imageNow(`/assets/gfx/${o.gid}.webp`);
    if (!im) return;
    const p = this.cellPos[o.cell];
    if (!p) return;
    const c = this.ctx;
    let sx = 0, sy = 0;
    if (m.frames > 1) {
      // animated object (sheet): plays once from t0, then holds the last frame (the clip ends on a stop())
      const f = Math.max(0, Math.min(m.frames - 1, Math.floor((performance.now() - (o.t0 ?? -Infinity)) / 1000 * SPRITE_FPS)));
      const cols = m.cols || m.frames;
      sx = (f % cols) * m.w; sy = Math.floor(f / cols) * m.h;
    }
    c.save(); c.translate(p.x, p.y);
    if (o.flip) c.scale(-1, 1);
    c.drawImage(im, sx, sy, m.w, m.h, -m.ox / 2, -m.oy / 2, m.w / 2, m.h / 2);
    c.restore();
  }

  // Training scarecrow (drawn here, not a game sprite): post, crossbar, sack head and straw hat
  drawScarecrow(c, x, y, now) {
    const hit = this.anim[this.state.fighters.find(f => f.dummy)?.id];
    const wob = hit && hit.once && now < hit.until ? Math.sin((now - hit.t0) / 40) * 0.12 : 0;
    c.save(); c.translate(x, y); c.rotate(wob);
    c.lineCap = 'round';
    c.strokeStyle = '#6b4a2b'; c.lineWidth = 4;
    c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -50); c.stroke();          // post
    c.beginPath(); c.moveTo(-18, -36); c.lineTo(18, -36); c.stroke();     // arms
    c.fillStyle = '#9b3d2e'; c.beginPath(); c.moveTo(-10, -40); c.lineTo(10, -40); c.lineTo(13, -18); c.lineTo(-13, -18); c.closePath(); c.fill(); // shirt
    c.strokeStyle = '#e3c463'; c.lineWidth = 1.5;
    for (const sx of [-1, 1]) { c.beginPath(); c.moveTo(sx * 18, -36); c.lineTo(sx * 23, -33); c.moveTo(sx * 18, -36); c.lineTo(sx * 22, -39); c.stroke(); } // straw hands
    c.fillStyle = '#d9c08a'; c.beginPath(); c.arc(0, -48, 8, 0, Math.PI * 2); c.fill(); // sack head
    c.fillStyle = '#3a2a1a'; c.fillRect(-4, -50, 2, 2); c.fillRect(2, -50, 2, 2); c.fillRect(-3, -45, 6, 1);
    c.fillStyle = '#c9a646'; c.beginPath(); c.ellipse(0, -55, 12, 3, 0, 0, Math.PI * 2); c.fill(); // hat brim
    c.beginPath(); c.moveTo(-6, -55); c.lineTo(-4, -63); c.lineTo(4, -63); c.lineTo(6, -55); c.closePath(); c.fill();
    c.restore();
  }

  // The clip and frame a fighter shows now
  frameOf(f, now) {
    let a = this.anim[f.id] || { name: 'static', dir: 'SE', t0: now };
    if (a.once && now > a.until) { a = { name: 'static', dir: a.dir, t0: a.until }; this.anim[f.id] = a; }
    const [suf, flip] = DIR_ANIM[a.dir] || DIR_ANIM.SE;
    let frame = Math.floor((now - a.t0) / 1000 * SPRITE_FPS);
    const g = this.sg(f);
    const meta = g ? spriteMeta(g) : null;
    let name = (a.once && a.key && meta && meta[a.key]) ? a.key : this.animKey(f, meta, a.name, suf);
    if (meta && !name) name = this.animKey(f, meta, 'static', suf) || 'static' + suf;
    if (!meta) name = a.name + suf;
    const m = meta && meta[name];
    if (m) frame = a.once ? Math.min(frame, m.frames - 1) : frame % m.frames;
    // long idle clips (some monsters) end on a stop() in the client: hold the rest pose instead of looping the whole clip
    if (m && !a.once && a.name === 'static' && m.frames > 30) frame = m.frames - 1;
    return { g, name, frame: Math.max(0, frame), flip, suf, m };
  }

  drawFighter(f, p, now) {
    const c = this.ctx;
    // team circle under each fighter once the fight runs (CIRCLE_FILE tinted with TEAMS_COLOR)
    if (this.state.phase !== 'placement' && !p.carried) {
      c.save();
      c.beginPath(); c.ellipse(p.x, p.y, 16, 8, 0, 0, Math.PI * 2);
      c.lineWidth = 2; c.strokeStyle = f.team === 0 ? '#ff0000' : '#0000ff'; c.stroke();
      c.restore();
    }
    // a hovered sprite is highlighted (gfx.selectSprite)
    const lit = (this.hoverF ?? this.tlHover) === f.id;
    if (lit) { c.save(); c.filter = 'brightness(1.35)'; }
    const { g, name, frame, flip, suf } = this.frameOf(f, now);
    const alpha = f.invisible && !(p.revealUntil > now) ? 0.45 : 1;
    const scale = f.summoner && !f.double ? 1 : 1;
    if (f.dummy && !g) { this.drawScarecrow(c, p.x, p.y, now); }
    else if (!g || !(drawSprite(c, g, name, frame, p.x, p.y, flip, alpha) || drawSprite(c, g, 'static' + suf, 0, p.x, p.y, flip, alpha))) {
      // sprite still loading: simple placeholder
      c.save(); c.globalAlpha = alpha * 0.8;
      c.fillStyle = TEAM[f.team]; c.beginPath(); c.ellipse(p.x, p.y - 22 * scale, 9, 20, 0, 0, Math.PI * 2); c.fill();
      c.restore();
    }
    if (lit) c.restore();
  }

  // ---------------------------------------------------------------- end

  ended(result) {
    const wait = () => (this.busy || this.queue.length ? setTimeout(wait, 200) : this.showEnd(result));
    wait();
  }

  // GameResult: "Resultados da luta" window with the duration and the winners / losers tables
  showEnd(result) {
    const me = this.me();
    const secs = Math.max(1, Math.round((Date.now() - this.t0) / 1000));
    const dur = `${Math.floor(secs / 60) ? Math.floor(secs / 60) + ' min ' : ''}${secs % 60} s`;
    const ranked = result.ranked;
    const table = (title, list) => `<div class="gr-team"><div class="gr-title">${title}</div>
      <table><tr><th>Nome</th><th>Nível</th>${ranked ? '<th>Elo</th><th>±</th>' : ''}</tr>
      ${list.map(p => `<tr class="${p.name === me?.name ? 'me' : ''}"><td>${clsBadge(p.cls)} ${esc(p.name)}</td><td>200</td>${ranked ? `<td>${p.rating ?? ''}</td><td class="${p.delta > 0 ? 'win' : 'loss'}">${p.delta != null ? (p.delta > 0 ? '+' : '') + p.delta : ''}</td>` : ''}</tr>`).join('')}</table></div>`;
    const win = result.players.filter(p => p.team === result.winner), lose = result.players.filter(p => p.team !== result.winner);
    const m = h(`<div class="modal-bg"><div class="gresult">
      <div class="gr-head">Resultados da luta</div>
      <div class="gr-body"><div class="gr-dur">Duração da luta: ${dur}</div>
        ${table('Vencedores', win)}${table('Perdedores', lose)}
        <div class="gr-foot"><button class="b-next" id="back">Fechar</button></div></div></div></div>`);
    this.el.appendChild(m);
    $('#back', m).onclick = () => this.onLeave();
  }

  destroy() {
    sound.stopMusic();
    cancelAnimationFrame(this.raf);
    clearInterval(this.timerInt);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener('keydown', this.onKey);
    this.closeMenu();
    for (const id of [...(this.effWins?.keys() || [])]) this.closeEffects(id);
  }
}

assetsReady.catch(() => {});
