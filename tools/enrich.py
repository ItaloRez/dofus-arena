#!/usr/bin/env python3
"""Add Portuguese names/descriptions and icon gfx ids from the client lang files to game.json.

  enrich.py game.json out/items_pt.json out/spells_pt.json out/itemsets_pt.json
"""
import sys, json

def main(game, items, spells, sets):
    g = json.load(open(game))
    I = json.load(open(items))['I']['u']
    S = json.load(open(spells))['S']
    IS = json.load(open(sets))['IS']
    n = 0
    for k, it in g['items'].items():
        li = I.get(k)
        if not li: continue
        it['gfx'] = li.get('g', 0)
        if li.get('n') and 'ES' not in li['n']: it['name'] = li['n']; n += 1
    for k, sp in g['spells'].items():
        ls = S.get(k)
        if not ls: continue
        if ls.get('n'): sp['name'] = ls['n']
        if ls.get('d'): sp['desc'] = ls['d']
    for k, st in g['sets'].items():
        if k in IS and IS[k].get('n'): st['name'] = IS[k]['n']
    json.dump(g, open(game, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('items renamed', n)

if __name__ == '__main__':
    main(*sys.argv[1:5])
