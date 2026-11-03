#!/usr/bin/env python3
"""Effect descriptions/icon categories and state names from the client lang files, for the fight HUD.

  uilang.py <effects_pt.json> <states_pt.json> server/public/assets/ui/lang.json
(the inputs come from lang.py)
"""
import sys, json

def main(eff, st, out):
    E = json.load(open(eff))['E']
    S = json.load(open(st))['ST']
    data = {
        'effects': {k: {'d': v.get('d', ''), 'c': v.get('c', -1), 'o': v.get('o', '')} for k, v in E.items()},
        'states': {k: v.get('n', '') for k, v in S.items()},
    }
    json.dump(data, open(out, 'w'), ensure_ascii=False, separators=(',', ':'))
    print('effects', len(data['effects']), 'states', len(data['states']))

if __name__ == '__main__':
    main(*sys.argv[1:4])
