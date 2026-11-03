#!/usr/bin/env python3
"""
Extract Dofus 1.29 game data (class spells, items, item sets) from public SQL dumps into server/data/game.json.

Sources (pinned):
  codebreak_final_world.sql  github.com/hussein-aitlahcen/codebreak (1.29.1 spells, items, sets)
  starloco game.sql          github.com/StarLoco/StarLoco-Game (UTF-8 spell names)
Usage: python3 extract.py <codebreak.sql> <starloco.sql> <out.json>
"""
import json, re, sys

RACE_SPELLS = {
    1: [3, 6, 17, 4, 2, 1, 9, 18, 20, 14, 19, 5, 16, 8, 12, 11, 10, 7, 15, 13],
    2: [34, 21, 23, 26, 22, 35, 28, 37, 30, 27, 24, 33, 25, 38, 36, 32, 29, 39, 40, 31],
    3: [51, 43, 41, 49, 42, 47, 48, 45, 53, 46, 52, 44, 50, 54, 55, 56, 58, 59, 57, 60],
    4: [61, 72, 65, 66, 68, 63, 74, 64, 79, 78, 71, 62, 69, 77, 73, 67, 70, 75, 76, 80],
    5: [82, 81, 83, 84, 100, 92, 88, 93, 85, 96, 98, 86, 89, 90, 87, 94, 99, 95, 91, 97],
    6: [102, 103, 105, 109, 113, 111, 104, 119, 101, 107, 116, 106, 117, 108, 115, 118, 110, 112, 114, 120],
    7: [125, 128, 121, 124, 122, 126, 127, 123, 130, 131, 132, 133, 134, 135, 129, 136, 137, 138, 139, 140],
    8: [143, 141, 142, 144, 145, 146, 147, 148, 154, 150, 151, 155, 152, 153, 149, 156, 157, 158, 160, 159],
    9: [161, 169, 164, 163, 165, 172, 167, 168, 162, 170, 171, 166, 173, 174, 176, 175, 178, 177, 179, 180],
    10: [183, 200, 193, 198, 195, 182, 192, 197, 189, 181, 199, 191, 186, 196, 190, 194, 185, 184, 188, 187],
    11: [432, 431, 434, 444, 449, 436, 437, 439, 433, 443, 440, 442, 441, 445, 438, 446, 447, 448, 435, 450],
    12: [686, 692, 687, 689, 690, 691, 688, 693, 694, 695, 696, 697, 698, 699, 700, 701, 702, 703, 704, 705],
}
# Spells every class gets (Coup de poing is the "no weapon" attack)
COMMON_SPELLS = [0]

EQUIP_TYPES = {1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 16, 17, 18, 19, 21, 22, 23, 81, 82}
CONSUMABLE_TYPES = {12, 33}
ITEM_MAX_ID = 12000


def parse_values(text, pos):
    """Parse '(a, 'b', ...), (...);' starting at pos. Yields tuples."""
    n = len(text)
    rows = []
    while pos < n:
        c = text[pos]
        if c == '(':
            pos += 1
            row, cur, inq, buf_is_str = [], [], False, False
            while True:
                c = text[pos]
                if inq:
                    if c == '\\':
                        nxt = text[pos + 1]
                        cur.append({'n': '\n', 'r': '\r', 't': '\t', '0': '\0'}.get(nxt, nxt))
                        pos += 2
                        continue
                    if c == "'":
                        if text[pos + 1] == "'":
                            cur.append("'"); pos += 2; continue
                        inq = False; pos += 1; continue
                    cur.append(c); pos += 1; continue
                if c == "'":
                    inq = True; buf_is_str = True; pos += 1; continue
                if c in ',)':
                    v = ''.join(cur)
                    if not buf_is_str:
                        v = v.strip()
                        if v.upper() == 'NULL':
                            v = None
                        else:
                            try:
                                v = int(v)
                            except ValueError:
                                try:
                                    v = float(v)
                                except ValueError:
                                    pass
                    row.append(v)
                    cur, buf_is_str = [], False
                    pos += 1
                    if c == ')':
                        break
                    continue
                cur.append(c); pos += 1
            rows.append(row)
        elif c == ';':
            return rows, pos + 1
        else:
            pos += 1
    return rows, pos


def table_rows(text, table):
    out = []
    for m in re.finditer(r"INSERT INTO `%s`[^V]*VALUES\s*" % table, text):
        rows, _ = parse_values(text, m.end())
        out.extend(rows)
    return out


def parse_spell_effect(e):
    p = [x.strip() for x in e.split(';')]
    def num(i, d=0):
        try:
            return int(p[i])
        except (IndexError, ValueError):
            return d
    return {
        'id': num(0), 'min': num(1, -1), 'max': num(2, -1), 'special': num(3, -1),
        'duration': num(4), 'chance': num(5), 'dice': p[6] if len(p) > 6 else '',
    }


def parse_spell_level(level):
    if level is None:
        return None
    level = level.strip()
    if level in ('', '-1'):
        return None
    parts = [p.strip() for p in level.split(',')]
    if len(parts) < 20:
        return None
    if len(parts) > 20:
        parts = parts[:15] + parts[-5:]

    def effects(s):
        s = s.strip()
        if s in ('', '-1'):
            return []
        return [parse_spell_effect(e) for e in s.split('|') if e.strip()]

    def intv(s, d=0):
        try:
            return int(s)
        except ValueError:
            return d

    eff, crit = effects(parts[0]), effects(parts[1])
    areas = parts[15]
    zones = [areas[i:i + 2] for i in range(0, len(areas), 2)]
    nb = len(eff) + len(crit)
    zones = (zones + ['Pa'] * nb)[:nb]
    for i, e in enumerate(eff):
        e['area'] = zones[i]
    for i, e in enumerate(crit):
        e['area'] = zones[len(eff) + i]
    states = lambda s: [int(x) for x in re.findall(r'-?\d+', s) if x != '-1']
    return {
        'effects': eff, 'critical': crit, 'ap': intv(parts[2], 6), 'minRange': intv(parts[3]),
        'maxRange': max(intv(parts[4]), intv(parts[3])), 'critRate': intv(parts[5]), 'failRate': intv(parts[6]),
        'lineOnly': parts[7] == 'true', 'los': parts[8] == 'true', 'freeCell': parts[9] == 'true',
        'boostRange': parts[10] == 'true', 'perTurn': intv(parts[12]), 'perTarget': intv(parts[13]),
        'cooldown': intv(parts[14]), 'requiredStates': states(parts[16]), 'forbiddenStates': states(parts[17]),
        'minLevel': intv(parts[18]), 'endsTurnOnFail': parts[19].strip() == 'true',
    }


def parse_targets(targets):
    targets = (targets or '').replace(' ', '')
    if not targets:
        return [], []
    normal, _, critical = targets.partition(',')
    return [int(t) for t in normal.split(';') if t], [int(t) for t in critical.split(';') if t]


def parse_item_effects(s):
    out = []
    for e in (s or '').split(','):
        p = e.split('#')
        if len(p) < 3 or not p[0]:
            continue
        try:
            eid = int(p[0], 16)
            mn = int(p[1], 16) if p[1] else 0
            mx = int(p[2], 16) if p[2] else 0
        except ValueError:
            continue
        out.append([eid, mn, max(mx, mn)])
    return out


def parse_monster(r):
    if not r:
        return None
    grades = []
    gl = (r[4] or '').split('|')
    st = (r[6] or '').split('|')
    sp = (r[8] or '').split('|')
    life = (r[9] or '').split('|')
    pts = (r[10] or '').split('|')
    ini = (r[11] or '').split('|')
    for i, g in enumerate(gl):
        if '@' not in g:
            continue
        lvl, _, res = g.partition('@')
        res = [int(x) for x in res.split(';') if x.strip().lstrip('-').isdigit()]
        res = (res + [0] * 7)[:7]
        stats = [int(x) for x in (st[i] if i < len(st) else '0,0,0,0,0').split(',') if x.strip().lstrip('-').isdigit()]
        stats = (stats + [0] * 5)[:5]
        spells = []
        for x in (sp[i] if i < len(sp) else '').split(';'):
            if '@' in x:
                a, b = x.split('@')
                if a.isdigit() and b.isdigit():
                    spells.append([int(a), int(b)])
        ap, mp = ((pts[i] if i < len(pts) else '4;3').split(';') + ['3'])[:2]
        def iv(v, d):
            try:
                return int(v)
            except (ValueError, TypeError):
                return d
        grades.append({
            'level': iv(lvl, 1), 'life': iv(life[i] if i < len(life) else 50, 50),
            'ap': iv(ap, 4), 'mp': iv(mp, 3), 'init': iv(ini[i] if i < len(ini) else 0, 0),
            # resistances: neutral, earth, fire, water, air, dodge AP, dodge MP
            'res': res,
            # strength, wisdom, intelligence, luck, agility
            'stats': stats, 'spells': spells,
        })
    return {'id': r[0], 'name': r[1], 'gfx': r[2], 'grades': grades}


def plausible(effects, typ):
    """Filter out custom 'admin' items with absurd stats"""
    caps = {0x76: 300, 0x7e: 300, 0x7b: 300, 0x77: 300, 0x7c: 300, 0x7d: 700, 0x6f: 2 if typ != 23 else 1,
            0x80: 1, 0x75: 3, 0x70: 40, 0xb2: 60, 0xb6: 3, 0x73: 25}
    for eid, mn, mx in effects:
        if eid in caps and mx > caps[eid]:
            return False
    return True


def main():
    cb_path, sl_path, out_path = sys.argv[1:4]
    cb = open(cb_path, encoding='utf-8', errors='replace').read()
    sl = open(sl_path, encoding='utf-8', errors='replace').read()

    sl_spells = {r[0]: r for r in table_rows(sl, 'sorts')}
    cb_spells = {r[0]: r for r in table_rows(cb, 'sorts')}

    wanted = set(COMMON_SPELLS)
    for ids in RACE_SPELLS.values():
        wanted |= set(ids)
    sl_monsters = {r[0]: r for r in table_rows(sl, 'monsters')}
    monsters = {}
    spells, pending = {}, set(wanted)
    while pending:
        sid = pending.pop()
        if sid in spells:
            continue
        row = cb_spells.get(sid) or sl_spells.get(sid)
        if row is None:
            print('missing spell', sid, file=sys.stderr)
            continue
        name = (sl_spells.get(sid) or row)[1]
        if '?' in name and sid in sl_spells:
            name = sl_spells[sid][1]
        levels = [parse_spell_level(l) for l in row[4:10]]
        while levels and levels[-1] is None:
            levels.pop()
        if not levels or None in levels:
            levels = [l for l in levels if l]
        if not levels:
            print('no level', sid, file=sys.stderr)
            continue
        tn, tc = parse_targets(row[10])
        for lv in levels:
            for i, e in enumerate(lv['effects']):
                e['target'] = tn[i] if i < len(tn) else 0
            for i, e in enumerate(lv['critical']):
                e['target'] = tc[i] if i < len(tc) else (tn[i] if i < len(tn) else 0)
            for e in lv['effects'] + lv['critical']:
                if e['id'] in (400, 401, 402) and e['min'] > 0:
                    pending.add(e['min'])
        spells[sid] = {'id': sid, 'name': name.strip(), 'icon': row[2], 'sprite': row[2], 'spriteInfo': [int(x) for x in str(row[3]).split(',') if x.strip().lstrip('-').isdigit()], 'levels': levels}
        for lv in levels:
            for e in lv['effects'] + lv['critical']:
                if e['id'] in (181, 185, 405) and e['min'] > 0 and e['min'] not in monsters:
                    monsters[e['min']] = None
        # load newly referenced monsters and queue their spells
        for mid in [m for m, v in monsters.items() if v is None]:
            mon = parse_monster(sl_monsters.get(mid))
            monsters[mid] = mon or False
            if mon:
                for g in mon['grades']:
                    for msid, _ in g['spells']:
                        pending.add(msid)

    items = {}
    sl_items = {r[0]: r for r in table_rows(sl, 'item_template')}
    for r in table_rows(cb, 'itemtemplate'):
        iid, name, typ, level = r[0], r[1], r[2], r[3]
        if iid >= ITEM_MAX_ID or (typ not in EQUIP_TYPES and typ not in CONSUMABLE_TYPES):
            continue
        effects = parse_item_effects(r[13])
        if not effects:
            continue
        sl = sl_items.get(iid)
        if not sl or sl[2].strip().lower() != name.strip().lower():
            continue  # custom item of the codebreak dump
        if not plausible(effects, typ):
            continue
        it = {'id': iid, 'name': name.strip(), 'type': typ, 'level': level, 'set': r[14] if r[14] > 0 else 0,
              'effects': effects, 'cond': r[12] or ''}
        if typ in (2, 3, 4, 5, 6, 7, 8, 19, 20, 21, 22):
            it['weapon'] = {'ap': r[16], 'minRange': r[17], 'maxRange': r[18], 'critRate': r[19],
                            'failRate': r[20], 'critBonus': r[15], 'twoHands': bool(r[5])}
        items[iid] = it

    sets = {}
    for r in table_rows(cb, 'itemset'):
        bonus = {}
        for n, s in zip(range(2, 9), r[2:9]):
            effs = []
            for e in re.split(r'[;]', s or ''):
                p = e.split(',')
                if len(p) >= 2 and p[0].strip().isdigit():
                    try:
                        effs.append([int(p[0]), int(p[1])])
                    except ValueError:
                        pass
                # broken rows like '118,40;126,40,112,4'
                if len(p) == 4:
                    try:
                        effs.append([int(p[2]), int(p[3])])
                    except ValueError:
                        pass
            if effs:
                bonus[n] = effs
        name = r[1]
        sets[r[0]] = {'id': r[0], 'name': name, 'bonus': bonus}
    used_sets = {i['set'] for i in items.values() if i['set']}
    sets = {k: v for k, v in sets.items() if k in used_sets}
    for it in items.values():
        if it['set'] and it['set'] not in sets:
            it['set'] = 0

    monsters = {k: v for k, v in monsters.items() if v}
    data = {
        'monsters': monsters,
        'classSpells': RACE_SPELLS, 'commonSpells': COMMON_SPELLS,
        'spells': spells, 'items': items, 'sets': sets,
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'spells {len(spells)} items {len(items)} sets {len(sets)}')


if __name__ == '__main__':
    main()
