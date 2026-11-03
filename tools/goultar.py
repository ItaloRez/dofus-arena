#!/usr/bin/env python3
"""Goultarminator arena maps (subarea 536 "Goultarminador" of the 1.29 lang): cells and start cells from the
StarLoco dump (map data ciphered with the map key, deciphered like the client's MapsServersManager), background
from the client map SWF. Writes tools/out/maps.json in the format of maps.py dump.

  goultar.py <starloco_game.sql> <client maps dir> [map ids...]
"""
import sys, os, json, glob
from urllib.parse import unquote
sys.path.insert(0, os.path.dirname(__file__))
from extract import table_rows
from maps import decode_cell, places

GOULTAR = list(range(12223, 12231))
HEX = '0123456789ABCDEF'


def prepare_key(k):
    return unquote(''.join(chr(int(k[i:i + 2], 16)) for i in range(0, len(k), 2)), encoding='latin1')


def checksum(s):
    return HEX[sum(ord(c) % 16 for c in s) % 16]


def decipher(data, key):
    k = prepare_key(key)
    c = int(checksum(k), 16) * 2
    out = ''.join(chr(int(data[i:i + 2], 16) ^ ord(k[(i // 2 + c) % len(k)])) for i in range(0, len(data), 2))
    return unquote(out, encoding='latin1')


def main(sql, maps_dir, ids):
    from mapvars import map_vars
    txt = open(sql, encoding='utf-8', errors='replace').read()
    want = set(ids or GOULTAR)
    res = {}
    for r in table_rows(txt, 'maps'):
        if r[0] not in want:
            continue
        mid, w, h, pl, key, data = r[0], r[2], r[3], r[4].strip(), r[5].strip(), r[6].strip()
        raw = decipher(data, key) if key else data
        if len(raw) % 10:
            print('bad data', mid, len(raw), file=sys.stderr); continue
        cells = [decode_cell(raw[i:i + 10]) for i in range(0, len(raw), 10)]
        f = sorted(glob.glob(f'{maps_dir}/{mid}_*.swf'))
        v = map_vars(f[-1]) if f else {}
        res[mid] = dict(id=mid, w=w, h=h, sub=536, x=0, y=0, places=places(pl), cells=cells,
                        bg=v.get('backgroundNum', 0), outdoor=bool(v.get('bOutdoor')))
    os.makedirs(os.path.dirname(os.path.abspath(__file__)) + '/out', exist_ok=True)
    out = os.path.dirname(os.path.abspath(__file__)) + '/out/maps.json'
    json.dump(res, open(out, 'w'))
    print('wrote', len(res), out)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2], [int(x) for x in sys.argv[3:]])
