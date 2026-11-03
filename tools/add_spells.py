#!/usr/bin/env python3
"""Add the 1.29 spells the arena was missing to server/data/game.json, without touching the rest:
the special (quest) spell of each class, the Dopple summon of each class and the common spells any class can learn.
Spell levels, sprites and targets come from the same dumps as extract.py; names/descriptions from the client lang.

  add_spells.py <codebreak.sql> <starloco.sql> <spells_pt.json> server/data/game.json
"""
import sys, json, os
sys.path.insert(0, os.path.dirname(__file__))
from extract import table_rows, parse_spell_level, parse_targets, parse_monster

# class -> special spell (from the "Parchemin de Sort Spécial" items, condition PG=<class>), Dopple summon
SPECIAL = {1: 422, 2: 420, 3: 425, 4: 416, 5: 424, 6: 412, 7: 427, 8: 410, 9: 418, 10: 426, 11: 421, 12: 423}
DOPPLE = {c: 1900 + c for c in range(1, 13)}
# common spells (learned by quests / dolmens in 1.29, usable by every class)
COMMON = [350, 362, 363, 364, 366, 367, 368, 369, 370, 373, 1560, 1580, 1600, 1620]


def main(cb_path, sl_path, lang_path, game_path):
    cb = open(cb_path, encoding='utf-8', errors='replace').read()
    sl = open(sl_path, encoding='utf-8', errors='replace').read()
    L = json.load(open(lang_path))['S']
    g = json.load(open(game_path))
    cb_spells = {r[0]: r for r in table_rows(cb, 'sorts')}
    sl_spells = {r[0]: r for r in table_rows(sl, 'sorts')}
    sl_monsters = {r[0]: r for r in table_rows(sl, 'monsters')}

    pending = set(SPECIAL.values()) | set(DOPPLE.values()) | set(COMMON)
    added = []
    while pending:
        sid = pending.pop()
        if str(sid) in g['spells']:
            continue
        row = cb_spells.get(sid) or sl_spells.get(sid)
        if row is None:
            print('missing spell', sid, file=sys.stderr); continue
        levels = [l for l in (parse_spell_level(x) for x in row[4:10]) if l]
        if not levels:
            print('no levels', sid, file=sys.stderr); continue
        tn, tc = parse_targets(row[10])
        for lv in levels:
            for i, e in enumerate(lv['effects']):
                e['target'] = tn[i] if i < len(tn) else 0
            for i, e in enumerate(lv['critical']):
                e['target'] = tc[i] if i < len(tc) else (tn[i] if i < len(tn) else 0)
            for e in lv['effects'] + lv['critical']:
                if e['id'] in (400, 401, 402, 787) and e['min'] > 0:
                    pending.add(e['min'])
                if e['id'] in (181, 185, 405) and e['min'] > 0 and str(e['min']) not in g['monsters']:
                    mon = parse_monster(sl_monsters.get(e['min']))
                    if mon:
                        g['monsters'][str(e['min'])] = mon
                        for gr in mon['grades']:
                            for msid, _ in gr['spells']:
                                pending.add(msid)
                    else:
                        print('missing monster', e['min'], 'for', sid, file=sys.stderr)
        ls = L.get(str(sid), {})
        sprite = row[2] if isinstance(row[2], int) else -1
        info = [int(x) for x in str(row[3]).split(',') if x.strip().lstrip('-').isdigit()]
        sp = {'id': sid, 'name': (ls.get('n') or row[1]).strip(), 'icon': sprite, 'sprite': sprite, 'spriteInfo': info, 'levels': levels}
        if ls.get('d'):
            sp['desc'] = ls['d']
        g['spells'][str(sid)] = sp
        added.append(sid)

    for c in range(1, 13):
        lst = g['classSpells'][str(c)]
        for sid in (SPECIAL[c], DOPPLE[c]):
            if str(sid) in g['spells'] and sid not in lst:
                lst.append(sid)
    for sid in COMMON:
        if str(sid) in g['spells'] and sid not in g['commonSpells']:
            g['commonSpells'].append(sid)
    json.dump(g, open(game_path, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('added spells', sorted(added))


if __name__ == '__main__':
    main(*sys.argv[1:5])
