#!/usr/bin/env python3
"""Extract Dofus 1.29 maps (cells + fight placement) from the Codebreak dump.

  maps.py list            -> candidate fight maps
  maps.py dump ID [ID..]  -> writes tools/out/maps.json with decoded cells
"""
import re, sys, json, os

SQL = '/tmp/data/codebreak_final_world.sql'
B64 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'
IDX = {c: i for i, c in enumerate(B64)}


def rows():
    txt = open(SQL, encoding='latin1').read()
    start = txt.index('INSERT INTO `maptemplate`')
    end = txt.index('/*!40000 ALTER TABLE `maptemplate` ENABLE KEYS', start)
    for m in re.finditer(r"\((\d+), '([^']*)', '([^']*)', '([^']*)', '([^']*)', (\d+), (\d+), (-?\d+), (-?\d+), (\d+), (\d+)\)", txt[start:end]):
        g = m.groups()
        yield dict(id=int(g[0]), data=g[2], key=g[3], places=g[4], w=int(g[5]), h=int(g[6]), x=int(g[7]), y=int(g[8]), cap=int(g[9]), sub=int(g[10]))


def decode_cell(s):
    c = [IDX[ch] for ch in s]
    return dict(
        active=(c[0] & 32) >> 5,
        los=c[0] & 1,
        groundRot=(c[1] & 48) >> 4,
        groundLevel=c[1] & 15,
        movement=(c[2] & 56) >> 3,
        ground=((c[0] & 24) << 6) + ((c[2] & 7) << 6) + c[3],
        slope=(c[4] & 60) >> 2,
        groundFlip=(c[4] & 2) >> 1,
        obj1=((c[0] & 4) << 11) + ((c[4] & 1) << 12) + (c[5] << 6) + c[6],
        obj1Rot=(c[7] & 48) >> 4,
        obj1Flip=(c[7] & 8) >> 3,
        obj2Flip=(c[7] & 4) >> 2,
        obj2Interactive=(c[7] & 2) >> 1,
        obj2=((c[0] & 2) << 12) + ((c[7] & 1) << 12) + (c[8] << 6) + c[9],
    )


def places(p):
    teams = []
    for part in p.split('|')[:2]:
        cells = [IDX[part[i]] * 64 + IDX[part[i + 1]] for i in range(0, len(part) - 1, 2)]
        teams.append(cells)
    return teams


MAPS_DIR = '/home/claude/assets-src/maps'


def swf_vars(mid):
    import glob
    from mapvars import map_vars
    f = sorted(glob.glob(f'{MAPS_DIR}/{mid}_*.swf'))
    if not f:
        return {}
    v = map_vars(f[-1])
    return dict(bg=v.get('backgroundNum', 0), outdoor=bool(v.get('bOutdoor')))


def main():
    cmd = sys.argv[1]
    if cmd == 'list':
        out = []
        for r in rows():
            if len(r['data']) % 10 or r['w'] != 15 or r['h'] != 17:
                continue
            t = places(r['places']) if '|' in r['places'] else []
            if len(t) < 2 or min(len(t[0]), len(t[1])) < 3:
                continue
            cells = [decode_cell(r['data'][i:i + 10]) for i in range(0, len(r['data']), 10)]
            walk = sum(1 for c in cells if c['active'] and c['movement'] > 1)
            obst = sum(1 for c in cells if c['active'] and c['movement'] <= 1 and c['obj2'])
            out.append((r['id'], r['sub'], r['x'], r['y'], walk, obst, len(t[0]), len(t[1])))
        for o in out:
            print(*o)
        print(len(out), file=sys.stderr)
    elif cmd == 'dump':
        ids = set(map(int, sys.argv[2:]))
        res = {}
        for r in rows():
            if r['id'] in ids:
                cells = [decode_cell(r['data'][i:i + 10]) for i in range(0, len(r['data']), 10)]
                res[r['id']] = dict(id=r['id'], w=r['w'], h=r['h'], sub=r['sub'], x=r['x'], y=r['y'], places=places(r['places']), cells=cells, **swf_vars(r['id']))
        os.makedirs(os.path.dirname(__file__) + '/out', exist_ok=True)
        json.dump(res, open(os.path.dirname(__file__) + '/out/maps.json', 'w'))
        print('wrote', len(res))


if __name__ == '__main__':
    main()
