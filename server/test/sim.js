// Bot vs bot fights for every class, without timers
import fs from 'node:fs';
import { Fight } from '../src/game/fight.js';
import { randomMap } from '../src/game/maps.js';
import { randomBuild } from '../src/game/builds.js';

const data = JSON.parse(fs.readFileSync(new URL('../data/game.json', import.meta.url)));
let wins = [0, 0], rounds = 0, errors = 0;
const N = Number(process.argv[2] || 24);
const size = Number(process.argv[3] || 1);
for (let i = 0; i < N; i++) {
  const teams = [0, 1].map(t => Array.from({ length: size }, (_, k) => {
    const cls = ((i * 2 + t + k * 5) % 12) + 1;
    return { name: `bot${t}${k}`, build: randomBuild(data, cls), bot: true };
  }));
  const fight = new Fight({ id: i, mode: '1v1', map: randomMap(i), teams, data, timers: false });
  fight.startFight();
  let guard = 0;
  while (fight.phase === 'fighting' && guard++ < 2000) {
    if (fight.pendingPass) { const p = fight.pendingPass; fight.pendingPass = null; p(); continue; }
    const run = fight.pendingAI;
    fight.pendingAI = null;
    if (run) run(); else { try { fight.passTurn(fight.current().id); } catch (e) { errors++; break; } }
    if (fight.round > 60) { fight.finish(0); break; }
  }
  rounds += fight.round;
  if (fight.winner != null) wins[fight.winner]++;
  const desc = teams.map(t => t.map(s => s.build.cls).join('+')).join(' vs ');
  console.log(`fight ${i}: ${desc} -> winner ${fight.winner} in ${fight.round} rounds; life`, fight.fighters.filter(f => !f.summoner).map(f => `${f.life}/${f.maxLife}`).join(' '), 'summons', fight.fighters.filter(f => f.summoner).length);
}
console.log('wins', wins, 'avg rounds', (rounds / N).toFixed(1), 'errors', errors);
