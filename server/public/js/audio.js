// Sounds of the Dofus 1.29 client (made by tools/audio.py from audio/effects.swf and audio/musics.swf).
// Like the client's SOMA, each animation plays the sounds its frames ask for; the fight music comes from the map's subarea.
// Settings work like the client's sound options: music and effects can each be switched off and have their own volume.
import { h, $ } from './ui.js';

const KEY = 'sound';
const DEFAULTS = { music: true, musicVol: 50, fx: true, fxVol: 80, muteHidden: true };
export const settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} };

let INDEX = { sprites: {}, spells: {}, maps: {}, fx: [] };
const ready = fetch('/assets/audio/index.json').then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) INDEX = j; }).catch(() => {});

let ctx = null, fxGain = null;
function audioCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    fxGain = ctx.createGain();
    fxGain.connect(ctx.destination);
    applyVolumes();
  }
  return ctx;
}
// browsers only allow sound after a click or key press
const unlock = () => { const c = audioCtx(); if (c && c.state === 'suspended') c.resume(); if (musicEl && settings.music && musicEl.paused) musicEl.play().catch(() => {}); };
window.addEventListener('pointerdown', unlock, true);
window.addEventListener('keydown', unlock, true);

const hidden = () => settings.muteHidden && document.hidden;
function applyVolumes() {
  if (fxGain) fxGain.gain.value = settings.fx && !hidden() ? settings.fxVol / 100 : 0;
  if (musicEl) musicEl.volume = settings.music && !hidden() ? (settings.musicVol / 100) * 0.6 : 0;
}
document.addEventListener('visibilitychange', applyVolumes);

const buffers = new Map();
function buffer(name) {
  if (!buffers.has(name)) {
    const c = audioCtx();
    if (!c) return Promise.resolve(null);
    buffers.set(name, fetch(`/assets/audio/fx/${name}.mp3`).then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Promise((res) => c.decodeAudioData(b, res, () => res(null))) : null)).catch(() => null));
  }
  return buffers.get(name);
}

// SOMA.playSound(name): plays one effect, `delay` ms from now
export function play(name, delay = 0) {
  if (!settings.fx || !name) return;
  const c = audioCtx();
  if (!c || c.state !== 'running') return;
  const at = c.currentTime + delay / 1000;
  buffer(name).then((b) => {
    if (!b || c.currentTime > at + 0.25) return; // too late (still loading): skip rather than play out of sync
    const s = c.createBufferSource();
    s.buffer = b;
    s.connect(fxGain);
    s.start(Math.max(at, c.currentTime));
  });
}

function playList(list) { for (const [ms, n] of list || []) play(n, ms); }
// sounds of a sprite animation (hitR, dieL, anim0R...)
export function anim(gfx, key) { if (gfx && key) playList(INDEX.sprites[gfx]?.[key]); }
// sounds of a spell effect clip
export function spell(fx) { if (fx > 0) playList(INDEX.spells[fx]); }
// loads the sounds a fight will need, so the first cast is not silent
export function preload(gfxs = []) {
  ready.then(() => {
    if (!audioCtx()) return;
    for (const n of ['turn_start', 'start_fight']) buffer(n);
    for (const g of gfxs) for (const l of Object.values(INDEX.sprites[g] || {})) for (const [, n] of l) buffer(n);
  });
}
export function preloadSpells(ids = []) { ready.then(() => { for (const id of ids) for (const [, n] of INDEX.spells[id] || []) buffer(n); }); }

// ---------------------------------------------------------------- music

let musicEl = null, musicWanted = null;
export function music(name) {
  musicWanted = name;
  if (!name) { if (musicEl) { musicEl.pause(); musicEl = null; } return; }
  if (musicEl && musicEl.dataset.name === name) return;
  if (musicEl) musicEl.pause();
  musicEl = new Audio(`/assets/audio/music/${name}.mp3`);
  musicEl.dataset.name = name;
  musicEl.loop = true;
  applyVolumes();
  if (settings.music) musicEl.play().catch(() => {});
}
export function mapMusic(mapId) { musicWanted = 'pending'; ready.then(() => { if (musicWanted === 'pending') music(INDEX.maps[mapId] || 'fig_amakna'); }); }
export function stopMusic() { music(null); }

// ---------------------------------------------------------------- options window

export function openOptions() {
  document.querySelector('.snd-bg')?.remove();
  const row = (k, label) => `<div class="snd-row">
      <label><input type="checkbox" data-on="${k}" ${settings[k] ? 'checked' : ''}> ${label}</label>
      <input type="range" min="0" max="100" step="1" data-vol="${k}Vol" value="${settings[k + 'Vol']}" ${settings[k] ? '' : 'disabled'}>
      <span class="snd-val">${settings[k + 'Vol']}</span></div>`;
  const m = h(`<div class="modal-bg snd-bg"><div class="snd">
      <div class="snd-title">Som</div>
      <div class="snd-body">
        ${row('music', 'Música')}
        ${row('fx', 'Efeitos sonoros')}
        <label class="snd-check"><input type="checkbox" data-on="muteHidden" ${settings.muteHidden ? 'checked' : ''}> Silenciar quando a aba não estiver visível</label>
      </div>
      <div class="snd-foot"><button class="b-next" id="snd-test">Testar</button><button class="b-next" id="snd-close">Fechar</button></div>
    </div></div>`);
  document.body.appendChild(m);
  m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
  m.querySelectorAll('[data-on]').forEach((el) => el.addEventListener('change', () => {
    const k = el.dataset.on;
    settings[k] = el.checked; save();
    const r = m.querySelector(`[data-vol="${k}Vol"]`); if (r) r.disabled = !el.checked;
    if (k === 'music' && musicEl) { if (el.checked) musicEl.play().catch(() => {}); else musicEl.pause(); }
    applyVolumes(); refreshButtons();
  }));
  m.querySelectorAll('[data-vol]').forEach((el) => el.addEventListener('input', () => {
    settings[el.dataset.vol] = +el.value; save();
    el.nextElementSibling.textContent = el.value;
    applyVolumes();
  }));
  m.querySelectorAll('[data-vol="fxVol"]').forEach((el) => el.addEventListener('change', () => play('turn_start')));
  $('#snd-test', m).onclick = () => play('start_fight');
  $('#snd-close', m).onclick = () => m.remove();
}

// speaker buttons (fight banner, lobby bar) show whether anything is audible
const muted = () => !settings.music && !settings.fx;
export function refreshButtons() {
  document.querySelectorAll('.snd-btn').forEach((b) => { b.textContent = muted() ? '🔇' : '🔊'; b.classList.toggle('off', muted()); });
}
export function soundButton(cls = '') {
  const b = h(`<button class="snd-btn ${cls}" title="Som">${muted() ? '🔇' : '🔊'}</button>`);
  b.onclick = (e) => { e.stopPropagation(); openOptions(); };
  return b;
}
