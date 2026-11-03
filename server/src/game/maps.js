// Loads the exported fight maps (server only).
// pool 'pvp': the Goultarminator arenas used by queued and AI fights; only maps that pass the symmetry check are kept
// (start cells of team 2 are rebuilt as the mirror image of team 1's when only they differ).
// pool 'training': the scarecrow sandbox maps.
import { readFileSync, existsSync } from 'fs';
import { FightMap } from './map.js';
import { checkSymmetry } from './symmetry.js';

const MAPS_FILE = new URL('../../data/maps.json', import.meta.url);
export const MAPS = existsSync(MAPS_FILE) ? JSON.parse(readFileSync(MAPS_FILE, 'utf8')) : [];

export const POOLS = { pvp: [], training: [] };
for (const def of MAPS) {
  const pool = def.pool || 'training';
  if (pool === 'pvp') {
    const r = checkSymmetry(def);
    if (!r.ok) { console.warn(`Mapa ${def.id} recusado: não é simétrico`); continue; }
    if (!r.best.placesOk) def.places = r.best.fixedPlaces;
    def.symmetry = r.best.name;
  }
  POOLS[pool]?.push(def);
}
if (!POOLS.pvp.length) POOLS.pvp = POOLS.training;
if (!POOLS.training.length) POOLS.training = POOLS.pvp;

export function randomMap(index, pool = 'pvp') {
  const list = POOLS[pool] || POOLS.pvp;
  if (index === undefined || index === null) index = Math.floor(Math.random() * list.length);
  return new FightMap(list[index % list.length]);
}
