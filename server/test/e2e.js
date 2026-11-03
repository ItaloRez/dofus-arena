// End-to-end: two accounts queue 1v1 over WebSocket and play random actions until the fight ends
import WebSocket from 'ws';
const BASE = process.env.BASE || 'http://localhost:8090';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function post(path, body, token) {
  const r = await fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  return r.json();
}
async function get(path, token) { return (await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + token } })).json(); }

async function player(name, cls) {
  let r = await post('/api/register', { name, password: 'pass1234' });
  if (r.error) r = await post('/api/login', { name, password: 'pass1234' });
  const token = r.token;
  const { build } = await get('/api/suggest?cls=' + cls, token);
  const saved = await post('/api/builds', build, token);
  if (saved.error) throw new Error(saved.error);
  const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws');
  const p = { name, token, ws, build: saved.build, state: null, you: null, ended: null, errors: [] };
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'fightStart') { p.state = m.state; p.you = m.you; p.map = m.map; }
    if (m.t === 'fight') p.state = m.state;
    if (m.t === 'fightEnd') p.ended = m.result;
    if (m.t === 'error') p.errors.push(m.error);
  });
  await new Promise(res => ws.on('open', res));
  ws.send(JSON.stringify({ t: 'auth', token }));
  await sleep(200);
  return p;
}

function act(p) {
  const st = p.state;
  if (!st) return;
  const me = st.fighters.find(f => f.id === p.you);
  if (st.phase === 'placement' && !me.ready) return p.ws.send(JSON.stringify({ t: 'ready' }));
  if (st.phase !== 'fighting' || st.current !== p.you) return;
  const enemies = st.fighters.filter(f => f.team !== me.team && !f.dead && f.cell >= 0);
  const r = Math.random();
  if (r < 0.5 && me.ap > 0 && enemies.length) {
    const s = me.spells[Math.floor(Math.random() * me.spells.length)];
    const target = Math.random() < 0.7 ? enemies[0].cell : Math.floor(Math.random() * p.map.cells.length);
    p.ws.send(JSON.stringify({ t: 'cast', kind: Math.random() < 0.15 ? 'weapon' : 'spell', spell: s.id, cell: target }));
  } else if (r < 0.75 && me.mp > 0) {
    p.ws.send(JSON.stringify({ t: 'move', cell: Math.floor(Math.random() * p.map.cells.length) }));
  } else p.ws.send(JSON.stringify({ t: 'pass' }));
}

const a = await player('e2e_a', 8), b = await player('e2e_b', 9);
a.ws.send(JSON.stringify({ t: 'queue', mode: '1v1', build: a.build.id }));
b.ws.send(JSON.stringify({ t: 'queue', mode: '1v1', build: b.build.id }));
for (let i = 0; i < 6000 && !(a.ended && b.ended); i++) {
  act(a); act(b);
  await sleep(15);
}
if (!a.ended) { console.log('FAIL: fight did not end', a.state?.round); process.exit(1); }
console.log('1v1 ended: winner team', a.ended.winner, 'rounds', a.state.round, a.ended.players.map(p => `${p.name} ${p.delta}`).join(', '));
console.log('errors seen (expected for random actions):', [...new Set([...a.errors, ...b.errors])].slice(0, 8).join(' | '));
const rank = await (await fetch(BASE + '/api/ranking?mode=1v1')).json();
console.log('ranking', rank.list.map(r => `${r.name}:${r.rating}`).join(' '));
// 3v3 training with AI teammates and AI opponents
a.ended = null; a.state = null;
a.ws.send(JSON.stringify({ t: 'train', mode: '3v3', build: a.build.id }));
for (let i = 0; i < 20000 && !a.ended; i++) { act(a); await sleep(10); }
console.log(a.ended ? `3v3 training ended: winner ${a.ended.winner}, rounds ${a.state.round}` : 'FAIL: 3v3 did not end');
process.exit(a.ended ? 0 : 1);
