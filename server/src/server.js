// HTTP + WebSocket server: accounts, builds, matchmaking, ranking and fights
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { Db } from './db.js';
import { Fight, filterEvents } from './game/fight.js';
import { randomMap } from './game/maps.js';
import {
  CLASSES, SLOTS, STAT_LABELS, BOOST_TABLE, STAT_POINTS, SPELL_POINTS, MAX_SCROLL, LEVEL, MAX_CONSUMABLES,
  validateBuild, computeStats, emptyBuild, isHealConsumable,
} from './game/stats.js';
import { randomBuild } from './game/builds.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, '..', 'public');
const PORT = Number(process.env.PORT || 8090);
const db = new Db(process.env.DB_FILE || path.join(ROOT, '..', 'storage', 'db.json'));
const data = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'data', 'game.json'), 'utf8'));
const MAX_BUILDS = 30;
const START_RATING = 1500;
const K = 32;

// ---------------------------------------------------------------- static game data for the client

const clientData = {
  ...data,
  classes: CLASSES, slots: SLOTS, statLabels: STAT_LABELS, boosts: BOOST_TABLE,
  statPoints: STAT_POINTS, spellPoints: SPELL_POINTS, maxScroll: MAX_SCROLL, level: LEVEL, maxConsumables: MAX_CONSUMABLES,
  consumables: Object.values(data.items).filter(isHealConsumable).map(i => i.id),
};
const clientDataGz = zlib.gzipSync(JSON.stringify(clientData));
const clientDataEtag = '"' + crypto.createHash('md5').update(clientDataGz).digest('hex') + '"';

// ---------------------------------------------------------------- accounts

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 32).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
}
function newToken(name) {
  const t = crypto.randomBytes(24).toString('hex');
  db.data.tokens[t] = name.toLowerCase();
  db.save();
  return t;
}
function accountByToken(t) {
  const n = t && db.data.tokens[t];
  return n ? db.data.accounts[n] : null;
}
function publicAccount(a) {
  return { name: a.name, rating: a.rating, stats: a.stats };
}

// ---------------------------------------------------------------- http

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.webp': 'image/webp', '.mp3': 'audio/mpeg' };

async function api(req, res, url) {
  const p = url.pathname;
  const auth = accountByToken((req.headers.authorization || '').replace('Bearer ', ''));
  if (p === '/api/data') {
    if (req.headers['if-none-match'] === clientDataEtag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ETag: clientDataEtag, 'Cache-Control': 'no-cache' });
    return res.end(clientDataGz);
  }
  if (p === '/api/register' && req.method === 'POST') {
    const { name, password } = await readBody(req);
    if (!/^[A-Za-z0-9_-]{3,16}$/.test(name || '')) return send(res, 400, { error: 'Nome: 3 a 16 letras, números, _ ou -' });
    if (!password || password.length < 4) return send(res, 400, { error: 'Senha com pelo menos 4 caracteres' });
    if (db.account(name)) return send(res, 400, { error: 'Esse nome já existe' });
    db.data.accounts[name.toLowerCase()] = {
      name, password: hashPassword(password), created: Date.now(), builds: [],
      rating: { '1v1': START_RATING, '3v3': START_RATING },
      stats: { '1v1': { w: 0, l: 0 }, '3v3': { w: 0, l: 0 } },
    };
    db.save();
    return send(res, 200, { token: newToken(name), account: publicAccount(db.account(name)) });
  }
  if (p === '/api/login' && req.method === 'POST') {
    const { name, password } = await readBody(req);
    const a = name && db.account(name);
    if (!a || !checkPassword(password || '', a.password)) return send(res, 400, { error: 'Nome ou senha incorretos' });
    return send(res, 200, { token: newToken(a.name), account: publicAccount(a) });
  }
  if (p === '/api/ranking') {
    const mode = url.searchParams.get('mode') === '3v3' ? '3v3' : '1v1';
    const list = Object.values(db.data.accounts)
      .filter(a => a.stats[mode].w + a.stats[mode].l > 0)
      .sort((x, y) => y.rating[mode] - x.rating[mode]).slice(0, 100)
      .map(a => ({ name: a.name, rating: a.rating[mode], w: a.stats[mode].w, l: a.stats[mode].l }));
    return send(res, 200, { mode, list });
  }
  if (!auth) return send(res, 401, { error: 'Faça login' });
  if (p === '/api/me') return send(res, 200, { account: publicAccount(auth), builds: auth.builds });
  if (p === '/api/history') {
    const list = db.data.matches.filter(m => m.players.some(x => x.name === auth.name)).slice(-30).reverse();
    return send(res, 200, { list });
  }
  if (p === '/api/builds' && req.method === 'POST') {
    const body = await readBody(req);
    const { build, errors } = validateBuild(body, data);
    if (!build) return send(res, 400, { error: errors.join(', ') });
    if (errors.length) return send(res, 400, { error: errors.join('; ') });
    if (body.id) {
      const i = auth.builds.findIndex(b => b.id === body.id);
      if (i < 0) return send(res, 404, { error: 'Build não encontrada' });
      build.id = body.id;
      auth.builds[i] = build;
    } else {
      if (auth.builds.length >= MAX_BUILDS) return send(res, 400, { error: `Máximo de ${MAX_BUILDS} builds` });
      build.id = db.data.nextBuildId++;
      auth.builds.push(build);
    }
    db.save();
    return send(res, 200, { build });
  }
  const m = p.match(/^\/api\/builds\/(\d+)$/);
  if (m && req.method === 'DELETE') {
    auth.builds = auth.builds.filter(b => b.id !== Number(m[1]));
    db.save();
    return send(res, 200, { ok: true });
  }
  if (p === '/api/suggest') {
    const cls = Number(url.searchParams.get('cls')) || 8;
    if (!CLASSES[cls]) return send(res, 400, { error: 'Classe inválida' });
    return send(res, 200, { build: randomBuild(data, cls, { name: `${CLASSES[cls].name} sugerido` }) });
  }
  return send(res, 404, { error: 'Não encontrado' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    // shared rules (stats, map geometry) are used by the browser too
    const shared = url.pathname.match(/^\/game\/(stats|map)\.js$/);
    if (shared) {
      res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, 'game', shared[1] + '.js')).pipe(res);
    }
    let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) file = path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Erro interno' });
  }
});

// ---------------------------------------------------------------- realtime: lobby, queues, fights

const clients = new Map(); // account name (lower) -> ws
const queues = { '1v1': [], '3v3': [] };
const fights = new Map();
const playerFight = new Map(); // account name (lower) -> { fight, fid }
let fightSeq = 1;

function wsSend(ws, msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
function toAccount(name, msg) { wsSend(clients.get(name.toLowerCase()), msg); }

function queueStatus() {
  return { '1v1': queues['1v1'].length, '3v3': queues['3v3'].length, fights: fights.size, online: clients.size };
}
function broadcastLobby() {
  const st = queueStatus();
  for (const [name, ws] of clients) {
    const q = Object.entries(queues).find(([, list]) => list.some(e => e.key === name));
    wsSend(ws, { t: 'lobby', status: st, queued: q ? q[0] : null, since: q ? q[1].find(e => e.key === name).since : null });
  }
}

function leaveQueues(key) {
  for (const list of Object.values(queues)) {
    const i = list.findIndex(e => e.key === key);
    if (i >= 0) list.splice(i, 1);
  }
}

function botSpec(rating) {
  const cls = 1 + Math.floor(Math.random() * 12);
  return { name: `IA ${CLASSES[cls].name}`, build: randomBuild(data, cls, { random: true }), bot: true, rating };
}

function startFight(mode, teams, ranked) {
  const id = fightSeq++;
  const fight = new Fight({
    id, mode, map: randomMap(null, mode === 'sandbox' ? 'training' : 'pvp'), teams, data, ranked,
    onUpdate: (f, events) => {
      for (const [key, pf] of playerFight) {
        if (pf.fight !== f) continue;
        const team = f.fighter(pf.fid).team;
        toAccount(key, { t: 'fight', state: f.view(team), events: filterEvents(events, team, f), you: pf.fid });
      }
    },
    onEnd: (f, winner) => endFight(f, winner),
  });
  fights.set(id, fight);
  fight.mapJson = fight.map.toJSON();
  for (const fr of fight.fighters) {
    if (!fr.accountId) continue;
    playerFight.set(fr.accountId, { fight, fid: fr.id });
    leaveQueues(fr.accountId);
    toAccount(fr.accountId, { t: 'fightStart', map: fight.mapJson, state: fight.view(fr.team), you: fr.id });
  }
  broadcastLobby();
  return fight;
}

function endFight(fight, winner) {
  const players = fight.fighters.filter(f => !f.summoner);
  const result = { id: fight.id, mode: fight.mode, ranked: fight.ranked, date: Date.now(), winner, players: [] };
  if (fight.ranked) {
    const accounts = players.map(p => ({ p, a: db.data.accounts[p.accountId] }));
    const avg = (t) => { const l = accounts.filter(x => x.p.team === t); return l.reduce((s, x) => s + x.a.rating[fight.mode], 0) / l.length; };
    const r = [avg(0), avg(1)];
    for (const { p, a } of accounts) {
      const exp = 1 / (1 + Math.pow(10, (r[1 - p.team] - r[p.team]) / 400));
      const score = p.team === winner ? 1 : 0;
      const delta = Math.round(K * (score - exp));
      a.rating[fight.mode] += delta;
      a.stats[fight.mode][score ? 'w' : 'l']++;
      result.players.push({ name: a.name, cls: p.cls, team: p.team, delta, rating: a.rating[fight.mode] });
    }
  } else {
    for (const p of players) result.players.push({ name: p.name, cls: p.cls, team: p.team, bot: p.bot });
  }
  if (fight.mode !== 'sandbox') db.data.matches.push(result);
  if (db.data.matches.length > 5000) db.data.matches.splice(0, 1000);
  db.save();
  for (const p of players) {
    if (!p.accountId) continue;
    toAccount(p.accountId, { t: 'fightEnd', result, account: publicAccount(db.data.accounts[p.accountId]) });
  }
  for (const [key, pf] of playerFight) if (pf.fight === fight) playerFight.delete(key);
  setTimeout(() => {
    fights.delete(fight.id);
    broadcastLobby();
  }, 1000);
}

// Test character for the sandbox: suggested build with every class spell at its highest level
function testSpec(account, cls) {
  const build = randomBuild(data, cls);
  for (const sid of [...data.classSpells[cls], ...data.commonSpells]) if (sid && data.spells[sid]) build.spells[sid] = data.spells[sid].levels.length;
  build.name = `Teste ${CLASSES[cls].name}`;
  build.spellOrder = account.sandboxOrder?.[cls] || [];
  build.spellSlots = account.sandboxSlots?.[cls] || null;
  return { accountId: account.name.toLowerCase(), name: account.name, build };
}

function specFor(account, buildId) {
  const build = account.builds.find(b => b.id === Number(buildId));
  if (!build) return null;
  return { accountId: account.name.toLowerCase(), name: account.name, build, buildId: build.id };
}

// Saves the spell bar order of the character the player is fighting with (its build, or the sandbox class)
function saveSpellOrder(account, fight, fid, res) {
  const f = fight.fighter(fid);
  if (!f || !res) return;
  const { ids, slots } = res;
  if (fight.mode === 'sandbox') {
    account.sandboxOrder ??= {};
    account.sandboxOrder[f.cls] = ids;
    account.sandboxSlots ??= {};
    account.sandboxSlots[f.cls] = slots;
  } else {
    const b = account.builds.find(x => x.id === f.buildId);
    if (b) { b.spellOrder = ids; b.spellSlots = slots; }
  }
  db.save();
}

function matchmake() {
  const now = Date.now();
  // 1v1: closest ratings, window grows with waiting time
  const q1 = queues['1v1'].sort((a, b) => a.rating - b.rating);
  for (let i = 0; i + 1 < q1.length; i++) {
    const a = q1[i], b = q1[i + 1];
    const wait = (now - Math.min(a.since, b.since)) / 1000;
    if (Math.abs(a.rating - b.rating) <= 100 + wait * 10) {
      q1.splice(i, 2);
      startFight('1v1', [[a.spec], [b.spec]], true);
      i--;
    }
  }
  // 3v3: 6 players, teams balanced (snake draft)
  const q3 = queues['3v3'].sort((a, b) => a.rating - b.rating);
  while (q3.length >= 6) {
    const six = q3.splice(0, 6).sort((a, b) => b.rating - a.rating);
    const t = [[six[0], six[3], six[4]], [six[1], six[2], six[5]]];
    startFight('3v3', t.map(team => team.map(e => e.spec)), true);
  }
  // players who accepted bots: fill the fight after 20 seconds (not ranked)
  for (const mode of ['1v1', '3v3']) {
    const q = queues[mode];
    const ready = q.filter(e => e.bots && now - e.since > 20000);
    if (!ready.length) continue;
    const size = mode === '1v1' ? 1 : 3;
    const humans = ready.slice(0, size * 2);
    for (const h of humans) q.splice(q.indexOf(h), 1);
    const teams = [[], []];
    humans.forEach((h, i) => teams[i % 2].push(h.spec));
    for (const team of teams) while (team.length < size) team.push(botSpec());
    startFight(mode, teams, false);
  }
  broadcastLobby();
}
setInterval(matchmake, 2000);

function onMessage(ws, account, msg) {
  const key = account.name.toLowerCase();
  const pf = playerFight.get(key);
  switch (msg.t) {
    case 'queue': {
      if (pf) return wsSend(ws, { t: 'error', error: 'Você já está em uma luta' });
      const mode = msg.mode === '3v3' ? '3v3' : '1v1';
      const spec = specFor(account, msg.build);
      if (!spec) return wsSend(ws, { t: 'error', error: 'Escolha uma build' });
      leaveQueues(key);
      queues[mode].push({ key, spec, rating: account.rating[mode], since: Date.now(), bots: !!msg.bots });
      matchmake();
      return;
    }
    case 'unqueue': leaveQueues(key); broadcastLobby(); return;
    case 'train': {
      if (pf) return wsSend(ws, { t: 'error', error: 'Você já está em uma luta' });
      const spec = specFor(account, msg.build);
      if (!spec) return wsSend(ws, { t: 'error', error: 'Escolha uma build' });
      leaveQueues(key);
      const size = msg.mode === '3v3' ? 3 : 1;
      const teams = [[spec], []];
      while (teams[0].length < size) teams[0].push(botSpec());
      while (teams[1].length < size) teams[1].push(botSpec());
      if (msg.opponent && CLASSES[msg.opponent]) teams[1][0] = { name: `IA ${CLASSES[msg.opponent].name}`, build: randomBuild(data, Number(msg.opponent)), bot: true };
      startFight(size === 1 ? '1v1' : '3v3', teams, false);
      return;
    }
    case 'sandbox': {
      if (pf) return wsSend(ws, { t: 'error', error: 'Você já está em uma luta' });
      const cls = CLASSES[msg.cls] ? Number(msg.cls) : 8;
      leaveQueues(key);
      const fight = startFight('sandbox', [[testSpec(account, cls)], [{ name: 'Espantalho', dummy: true, bot: true }]], false);
      // no placement: straight into the fight
      fight.startFight();
      return;
    }
  }
  if (!pf) return;
  const { fight, fid } = pf;
  let r;
  switch (msg.t) {
    case 'place': fight.place(fid, Number(msg.cell)); break;
    case 'ready': fight.setReady(fid, msg.ready !== false); break;
    case 'move': r = fight.move(fid, Number(msg.cell)); break;
    case 'cast': r = fight.cast(fid, msg.kind === 'weapon' ? 'weapon' : 'spell', Number(msg.spell), Number(msg.cell)); break;
    case 'item': r = fight.useItem(fid, Number(msg.index)); break;
    case 'pass': fight.passTurn(fid); break;
    case 'sandboxClass': {
      const cls = Number(msg.cls);
      if (!CLASSES[cls]) return;
      r = fight.changeClass(fid, testSpec(account, cls));
      break;
    }
    case 'forfeit': fight.forfeit(fid); break;
    case 'spellOrder': saveSpellOrder(account, fight, fid, fight.setSpellOrder(fid, msg.order, msg.slots)); return;
    case 'chat': {
      const text = String(msg.text || '').slice(0, 200);
      if (!text) return;
      for (const [k, p] of playerFight) if (p.fight === fight) toAccount(k, { t: 'chat', from: account.name, text });
      return;
    }
  }
  if (r?.error) wsSend(ws, { t: 'error', error: r.error });
}

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  let account = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!account) {
      if (msg.t !== 'auth') return;
      account = accountByToken(msg.token);
      if (!account) { wsSend(ws, { t: 'authError' }); return ws.close(); }
      const key = account.name.toLowerCase();
      const old = clients.get(key);
      if (old && old !== ws) { wsSend(old, { t: 'kicked' }); old.close(); }
      clients.set(key, ws);
      wsSend(ws, { t: 'hello', account: publicAccount(account) });
      const pf = playerFight.get(key);
      if (pf) {
        const f = pf.fight.fighter(pf.fid);
        f.connected = true;
        clearTimeout(f.dcTimer);
        wsSend(ws, { t: 'fightStart', map: pf.fight.mapJson, state: pf.fight.view(f.team), you: pf.fid });
      }
      broadcastLobby();
      return;
    }
    try { onMessage(ws, account, msg); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => {
    if (!account) return;
    const key = account.name.toLowerCase();
    if (clients.get(key) !== ws) return;
    clients.delete(key);
    leaveQueues(key);
    const pf = playerFight.get(key);
    if (pf) {
      const f = pf.fight.fighter(pf.fid);
      f.connected = false;
      // leaving for good loses the fight
      f.dcTimer = setTimeout(() => { if (!f.connected) pf.fight.forfeit(pf.fid); }, 90000);
      if (pf.fight.phase === 'placement') pf.fight.setReady(pf.fid, true);
    }
    broadcastLobby();
  });
});

process.on('SIGINT', () => { db.flush(); process.exit(0); });
process.on('SIGTERM', () => { db.flush(); process.exit(0); });

server.listen(PORT, () => console.log(`Dofus Arena em http://localhost:${PORT}`));
export { server };
