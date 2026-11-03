// App shell: login, lobby (builds, queue, ranking), websocket
import { EFFECT_STATS, CLASSES } from '/game/stats.js';
import { $, h, esc, toast, setData, statEffects, clsBadge, clsName } from './ui.js';
import { openBuilder } from './builder.js';
import { FightView } from './fight.js';
import { soundButton } from './audio.js';

export const S = {
  token: null, account: null, builds: [], data: null, ws: null, lobby: null,
  selectedBuild: null, mode: '1v1', bots: true, fight: null, view: 'lobby',
};
try { S.token = localStorage.getItem('token'); S.selectedBuild = Number(localStorage.getItem('build')) || null; } catch {}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'Erro');
  return json;
}

const app = () => document.getElementById('app');

// ---------------------------------------------------------------- login

function showLogin() {
  S.view = 'login';
  let mode = 'login';
  const el = h(`
    <div class="login"><div class="panel">
      <div class="logo"><h1>Arena 1.29</h1><p class="muted">PvP tático por turnos, direto no navegador</p></div>
      <div class="tabs"><button data-m="login" class="on">Entrar</button><button data-m="register">Criar conta</button></div>
      <form>
        <div class="field"><label>Nome</label><input name="name" autocomplete="username" required></div>
        <div class="field"><label>Senha</label><input name="password" type="password" autocomplete="current-password" required></div>
        <div class="err"></div>
        <button class="btn big" style="width:100%">Entrar</button>
      </form>
    </div></div>`);
  el.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
    mode = b.dataset.m;
    el.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b));
    el.querySelector('form .btn').textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
  });
  el.querySelector('form').onsubmit = async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target);
    try {
      const r = await api('/api/' + mode, { body: { name: f.get('name'), password: f.get('password') } });
      S.token = r.token;
      try { localStorage.setItem('token', r.token); } catch {}
      await start();
    } catch (e) { el.querySelector('.err').textContent = e.message; }
  };
  app().replaceChildren(el);
}

export function logout() {
  S.token = null;
  try { localStorage.removeItem('token'); } catch {}
  S.ws?.close();
  showLogin();
}

// ---------------------------------------------------------------- websocket

function connect() {
  if (S.ws && S.ws.readyState <= 1) return;
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: S.token }));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.t) {
      case 'hello': S.account = m.account; break;
      case 'authError': logout(); break;
      case 'kicked': toast('Conectado em outra aba'); break;
      case 'lobby': S.lobby = m; if (S.view === 'lobby') renderQueue(); break;
      case 'error': toast(m.error); S.fight?.onError?.(m.error); break;
      case 'fightStart':
        S.view = 'fight';
        S.fight?.destroy();
        S.fight = new FightView(app(), { data: S.data, map: m.map, state: m.state, you: m.you, send, onLeave: leaveFight });
        window.fightView = S.fight; // handy for debugging in the console
        break;
      case 'fight': S.fight?.update(m.state, m.events); break;
      case 'chat': S.fight?.chat(m.from, m.text); break;
      case 'fightEnd': S.account = m.account; S.fight?.ended(m.result); break;
    }
  };
  ws.onclose = () => { if (S.token) setTimeout(connect, 1500); };
}

export function send(msg) {
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg));
  else toast('Sem conexão com o servidor');
}

function leaveFight() {
  S.fight?.destroy();
  S.fight = null;
  showLobby();
}

// ---------------------------------------------------------------- lobby

function topbar() {
  const a = S.account;
  return `<div class="topbar"><div class="brand">Arena 1.29</div>
    <div class="who"><span class="pill">1v1: <b>${a.rating['1v1']}</b></span><span class="pill">3v3: <b>${a.rating['3v3']}</b></span>
    <b>${esc(a.name)}</b><span id="sndslot"></span><button class="btn small secondary" id="logout">Sair</button></div></div>`;
}

export async function showLobby() {
  S.view = 'lobby';
  try {
    const me = await api('/api/me');
    S.account = me.account;
    S.builds = me.builds;
  } catch { return logout(); }
  if (!S.builds.find(b => b.id === S.selectedBuild)) S.selectedBuild = S.builds[0]?.id || null;
  const el = h(`<div>${topbar()}
    <div class="lobby">
      <div class="panel"><div class="row"><h2 class="grow">Minhas builds</h2><button class="btn small" id="newb">+ Nova</button></div>
        <div class="build-list" id="blist"></div></div>
      <div class="panel play-box"><h2>Jogar</h2>
        <div id="pick-info" class="muted"></div>
        <div class="mode-pick"><button data-mode="1v1"><b>1v1</b>Duelo</button><button data-mode="3v3"><b>3v3</b>Equipes</button></div>
        <label class="row" style="justify-content:center"><input type="checkbox" id="bots"> Completar com IA se ninguém aparecer em 20 s (sem ranking)</label>
        <div class="row" style="justify-content:center;margin-top:12px;flex-wrap:wrap">
          <button class="btn big" id="queue">Buscar partida</button>
          <button class="btn big secondary" id="train">Treinar contra IA</button>
          <button class="btn big secondary" id="sandbox" title="Personagem de teste com todos os feitiços contra um espantalho">Treino com espantalho</button>
          <select class="inp" id="opp" title="Classe da IA"><option value="">IA aleatória</option>${Object.entries(CLASSES).map(([id, c]) => `<option value="${id}">IA ${c.name}</option>`).join('')}</select>
        </div>
        <div id="qbox"></div>
        <h3 style="margin-top:22px">Últimas partidas</h3><div id="hist" class="muted">…</div>
      </div>
      <div class="panel"><div class="row"><h2 class="grow">Ranking</h2>
        <div class="tabs" style="margin:0;width:130px"><button data-r="1v1" class="on">1v1</button><button data-r="3v3">3v3</button></div></div>
        <div id="rank">…</div></div>
    </div></div>`);
  app().replaceChildren(el);
  $('#logout', el).onclick = logout;
  $('#sndslot', el).replaceWith(soundButton('top'));
  $('#newb', el).onclick = () => openBuilder(null);
  $('#bots', el).checked = S.bots;
  $('#bots', el).onchange = (e) => { S.bots = e.target.checked; };
  el.querySelectorAll('.mode-pick button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === S.mode);
    b.onclick = () => { S.mode = b.dataset.mode; el.querySelectorAll('.mode-pick button').forEach(x => x.classList.toggle('on', x === b)); };
  });
  $('#queue', el).onclick = () => {
    if (!S.selectedBuild) return toast('Crie uma build primeiro');
    if (S.lobby?.queued) send({ t: 'unqueue' });
    else send({ t: 'queue', mode: S.mode, build: S.selectedBuild, bots: S.bots });
  };
  $('#sandbox', el).onclick = () => {
    const b = S.builds.find(x => x.id === S.selectedBuild);
    send({ t: 'sandbox', cls: b ? b.cls : 8 });
  };
  $('#train', el).onclick = () => {
    if (!S.selectedBuild) return toast('Crie uma build primeiro');
    send({ t: 'train', mode: S.mode, build: S.selectedBuild, opponent: Number($('#opp', el).value) || null });
  };
  el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => {
    el.querySelectorAll('[data-r]').forEach(x => x.classList.toggle('on', x === b));
    loadRanking(b.dataset.r);
  });
  renderBuilds();
  renderQueue();
  loadRanking('1v1');
  loadHistory();
}

function renderBuilds() {
  const list = $('#blist');
  if (!list) return;
  if (!S.builds.length) {
    list.innerHTML = `<p class="muted">Nenhuma build ainda. Crie uma: escolha a classe, distribua os pontos, os feitiços e os itens. O botão "Sugerir" monta uma build pronta.</p>`;
  } else {
    list.innerHTML = S.builds.map(b => `<div class="build-card ${b.id === S.selectedBuild ? 'on' : ''}" data-id="${b.id}">
      ${clsBadge(b.cls, '', b.sex)}<div class="grow"><div class="name">${esc(b.name)}</div><div class="muted" style="font-size:12px">${esc(clsName(b.cls))} · nível 200</div></div>
      <button class="btn small secondary" data-edit="${b.id}">Editar</button></div>`).join('');
  }
  list.querySelectorAll('.build-card').forEach(c => c.onclick = (ev) => {
    const id = Number(c.dataset.id);
    if (ev.target.dataset.edit) return openBuilder(S.builds.find(b => b.id === id));
    S.selectedBuild = id;
    try { localStorage.setItem('build', id); } catch {}
    renderBuilds();
  });
  const sel = S.builds.find(b => b.id === S.selectedBuild);
  const info = $('#pick-info');
  if (info) info.innerHTML = sel ? `Build: <b>${esc(sel.name)}</b> (${esc(clsName(sel.cls))})` : 'Crie uma build para jogar';
}

function renderQueue() {
  const box = $('#qbox');
  if (!box) return;
  const L = S.lobby;
  const btn = $('#queue');
  if (btn) btn.textContent = L?.queued ? 'Sair da fila' : 'Buscar partida';
  const st = L?.status;
  box.innerHTML = `<div class="queue-box">${L?.queued
    ? `<span class="spinner"></span> Procurando partida ${L.queued}… <span id="qtime"></span>`
    : 'Fora da fila'}
    <div style="font-size:12px;opacity:.8;margin-top:4px">${st ? `${st.online} online · fila 1v1: ${st['1v1']} · fila 3v3: ${st['3v3']} · lutas em andamento: ${st.fights}` : ''}</div></div>`;
  clearInterval(renderQueue.t);
  if (L?.queued) {
    const tick = () => { const e = $('#qtime'); if (e) e.textContent = Math.floor((Date.now() - L.since) / 1000) + ' s'; };
    tick();
    renderQueue.t = setInterval(tick, 1000);
  }
}

async function loadRanking(mode) {
  const r = await api('/api/ranking?mode=' + mode).catch(() => null);
  const box = $('#rank');
  if (!box || !r) return;
  box.innerHTML = r.list.length ? `<table class="rank"><tr><th>#</th><th>Jogador</th><th>Elo</th><th>V/D</th></tr>
    ${r.list.map((p, i) => `<tr><td class="pos">${i + 1}</td><td>${esc(p.name)}</td><td><b>${p.rating}</b></td><td><span class="win">${p.w}</span>/<span class="loss">${p.l}</span></td></tr>`).join('')}</table>`
    : '<p class="muted">Ninguém jogou partidas ranqueadas ainda.</p>';
}

async function loadHistory() {
  const r = await api('/api/history').catch(() => null);
  const box = $('#hist');
  if (!box || !r) return;
  box.innerHTML = r.list.length ? r.list.slice(0, 8).map(m => {
    const me = m.players.find(p => p.name === S.account.name);
    const won = me && me.team === m.winner;
    const vs = m.players.filter(p => me && p.team !== me.team).map(p => esc(p.name)).join(', ');
    return `<div style="text-align:left;padding:3px 0;border-bottom:1px dotted rgba(0,0,0,.1)"><span class="${won ? 'win' : 'loss'}">${won ? 'Vitória' : 'Derrota'}</span> ${m.mode} contra ${vs}
      ${m.ranked && me ? `<b>${me.delta > 0 ? '+' : ''}${me.delta}</b>` : '<span class="muted">(treino)</span>'}</div>`;
  }).join('') : 'Nenhuma partida ainda.';
}

// ---------------------------------------------------------------- start

async function start() {
  if (!S.data) {
    S.data = await (await fetch('/api/data')).json();
    for (const sp of Object.values(S.data.spells)) sp.name = sp.name.trim();
    for (const it of Object.values(S.data.items)) it.name = it.name.trim();
    setData(S.data);
    statEffects(EFFECT_STATS);
  }
  if (!S.token) return showLogin();
  connect();
  await showLobby();
}

export function refreshBuilds(builds) { S.builds = builds; }

start();
