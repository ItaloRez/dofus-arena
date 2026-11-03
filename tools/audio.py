#!/usr/bin/env python3
"""Export the Dofus 1.29 sounds for the web client.

  audio.py <client dir> <assets dir>

- audio/effects.swf -> <assets>/audio/fx/<name>.mp3 (name = lowercase AUEC key of lang audio, as used by SOMA.playSound)
- audio/musics.swf  -> <assets>/audio/music/<file>.mp3 (the fight musics of the arena maps)
- <assets>/audio/index.json: sounds played by the animations, read from the SOMA.playSound calls in the clips:
    sprites: { gfx: { animName: [[ms, name], ...] } }   (sprite SWFs, 60 fps)
    spells:  { fxId: [[ms, name], ...] }                (spell effect SWFs, 60 fps)
    maps:    { mapId: music }
"""
import sys, os, json, struct
sys.path.insert(0, os.path.dirname(__file__))
from swfinfo import load, rect_len, tags

FPS = 60


def swf_tags(d):
    return tags(d, 8 + rect_len(d, 8) + 4, len(d))


def exports_of(d):
    ex = {}
    for code, o, ln in swf_tags(d):
        if code == 56:
            n = struct.unpack_from('<H', d, o)[0]; p = o + 2
            for _ in range(n):
                cid = struct.unpack_from('<H', d, p)[0]; p += 2
                e = d.index(b'\0', p); ex[d[p:e].decode('latin1')] = cid; p = e + 1
    return ex


def dump_sounds(path, out_dir, rename, keep):
    d = load(path)
    names = {cid: n for n, cid in exports_of(d).items()}
    os.makedirs(out_dir, exist_ok=True)
    done = []
    for code, o, ln in swf_tags(d):
        if code != 14:
            continue
        sid, flags = struct.unpack_from('<HB', d, o)
        if flags >> 4 != 2 or sid not in names:  # MP3 only
            continue
        name = rename(names[sid])
        if not name or not keep(name):
            continue
        open(os.path.join(out_dir, name + '.mp3'), 'wb').write(d[o + 9:o + ln])  # skip id, flags, samples, seek
        done.append(name)
    return done


def strings_pushed(code):
    """Strings pushed by an AVM1 action block (enough to read SOMA.playSound("name") calls)."""
    pool, out, p = [], [], 0
    while p < len(code):
        op = code[p]; p += 1
        if op == 0:
            break
        ln = 0
        if op >= 0x80:
            ln = struct.unpack_from('<H', code, p)[0]; p += 2
        b = code[p:p + ln]; p += ln
        if op == 0x88:
            n = struct.unpack_from('<H', b)[0]; q = 2; pool = []
            for _ in range(n):
                e = b.index(b'\0', q); pool.append(b[q:e].decode('utf-8', 'replace')); q = e + 1
        elif op == 0x96:
            q = 0
            while q < len(b):
                t = b[q]; q += 1
                if t == 0: e = b.index(b'\0', q); out.append(b[q:e].decode('utf-8', 'replace')); q = e + 1
                elif t == 1 or t == 7: q += 4
                elif t in (4, 5): q += 1
                elif t == 6: q += 8
                elif t == 8: out.append(pool[b[q]] if b[q] < len(pool) else ''); q += 1
                elif t == 9:
                    i = struct.unpack_from('<H', b, q)[0]; out.append(pool[i] if i < len(pool) else ''); q += 2
    return out


def timelines(d):
    """sprite id (0 = root) -> {'frames': n, 'place': [(frame, child)], 'sound': [(frame, [names])]}"""
    res = {}

    def walk(sid, off, end):
        t = {'frames': 0, 'place': [], 'sound': []}
        res[sid] = t
        f = 0
        for code, o, ln in tags(d, off, end):
            if code == 1:
                f += 1
            elif code == 39:
                walk(struct.unpack_from('<H', d, o)[0], o + 4, o + ln)
            elif code == 26 and d[o] & 2:  # PlaceObject2 with a character
                p = o + 3
                t['place'].append((f, struct.unpack_from('<H', d, p)[0]))
            elif code == 70 and d[o] & 2:  # PlaceObject3
                p = o + 4
                if d[o + 1] & 8:  # class name
                    p = d.index(b'\0', p) + 1
                t['place'].append((f, struct.unpack_from('<H', d, p)[0]))
            elif code in (12, 59):
                s = strings_pushed(d[o + (2 if code == 59 else 0):o + ln])
                if 'playSound' in s:
                    i = s.index('playSound')
                    # arguments are pushed before the method name: keep the strings before it that are not the target
                    args = [x for x in s[:i] if x and x not in ('SOMA', '_root', '_global', '_parent', 'this')]
                    if args:
                        t['sound'].append((f, args))
        t['frames'] = max(f, 1)

    walk(0, 8 + rect_len(d, 8) + 4, len(d))
    return res


def sounds_from(tl, sid, known, limit, depth=0, seen=()):
    """[(frame, name)] heard while symbol sid plays its first `limit` frames."""
    t = tl.get(sid)
    if not t or depth > 12 or sid in seen:
        return []
    out = []
    for f, args in t['sound']:
        # playSound(name) or playSound(name, alt): pick the first argument that is a sound
        for a in reversed(args):
            if a.lower() in known:
                out.append((f, a.lower()))
                break
    for f, child in t['place']:
        if f >= limit:
            continue
        for cf, n in sounds_from(tl, child, known, limit - f, depth + 1, seen + (sid,)):
            out.append((f + cf, n))
    return sorted(set(x for x in out if x[0] < limit))


def thin(lst, gap=200, cap=6):
    """Clips that spawn many particles call playSound once per particle: keep one per name every `gap` ms."""
    last, out = {}, []
    for t, n in lst:
        if n in last and t - last[n] < gap:
            continue
        last[n] = t
        out.append([t, n])
    return out[:cap]


def lang_json(path):
    import subprocess, tempfile
    tmp = tempfile.mktemp(suffix='.json')
    subprocess.check_call([sys.executable, os.path.join(os.path.dirname(__file__), 'lang.py'), path, tmp], stdout=subprocess.DEVNULL)
    d = json.load(open(tmp)); os.remove(tmp)
    return d


def main(client, assets):
    lng = lang_json(os.path.join(client, 'lang/swf', [f for f in os.listdir(os.path.join(client, 'lang/swf')) if f.startswith('audio_pt_')][0]))
    by_id = {str(v): k.lower() for k, v in lng['AUEC'].items()}
    file_to_name = {e['f'][:-4]: by_id[i] for i, e in lng['AUE'].items() if i in by_id}

    out = os.path.join(assets, 'audio')
    fx = dump_sounds(os.path.join(client, 'audio/effects.swf'), os.path.join(out, 'fx'),
                     lambda n: file_to_name.get(n[:-4]) if n.endswith('.mp3') else None, lambda n: True)
    # fight music of each arena map: subarea 'm' in lang maps (the client plays it when the fight starts)
    lmaps = lang_json(os.path.join(client, 'lang/swf', [f for f in os.listdir(os.path.join(client, 'lang/swf')) if f.startswith('maps_pt_')][0]))['MA']
    files = {i: e['f'][:-4] for i, e in lng['AUM'].items()}
    map_music = {}
    for m in json.load(open(os.path.join(assets, '../../data/maps.json'))):
        sa = lmaps['sa'].get(str((lmaps['m'].get(str(m['id'])) or {}).get('sa')))
        ids = [str(x) for x in (sa or {}).get('m') or [] if str(x) in files]
        map_music[str(m['id'])] = files[ids[0]] if ids else 'fig_amakna'
    keep = set(map_music.values())
    mus = dump_sounds(os.path.join(client, 'audio/musics.swf'), os.path.join(out, 'music'),
                      lambda n: n[:-4] if n.endswith('.mp3') else None, lambda n: n in keep)
    known = set(fx)
    ms = lambda f: round(f * 1000 / FPS)

    index = {'sprites': {}, 'spells': {}, 'maps': map_music}
    for j in sorted(os.listdir(os.path.join(assets, 'sprites'))):
        if not j.endswith('.json'):
            continue
        gfx = j[:-5]
        p = os.path.join(client, 'clips/sprites', gfx + '.swf')
        if not os.path.exists(p):
            continue
        d = load(p); tl = timelines(d); meta = json.load(open(os.path.join(assets, 'sprites', j)))
        anims = {}
        for name, cid in exports_of(d).items():
            if name not in meta:
                continue
            s = sounds_from(tl, cid, known, meta[name].get('frames', 600))
            if s:
                anims[name] = thin([(ms(f), n) for f, n in s])
        if anims:
            index['sprites'][gfx] = anims
    ids = set(json.load(open(os.path.join(assets, 'fx/index.json'))))
    try:
        ids |= set(json.load(open(os.path.join(assets, 'fx/parts.json'))))
    except FileNotFoundError:
        pass
    for sp in sorted(ids, key=lambda x: int(x) if x.isdigit() else 0):
        p = os.path.join(client, 'clips/spells', sp + '.swf')
        if not os.path.exists(p):
            continue
        d = load(p); tl = timelines(d)
        s = sounds_from(tl, 0, known, 600)
        if s:
            index['spells'][sp] = thin([(ms(f), n) for f, n in s])
    used = {n for a in index['sprites'].values() for l in a.values() for _, n in l} | \
           {n for l in index['spells'].values() for _, n in l}
    # UI / fight sounds played by the client code itself
    used |= {'turn_start', 'start_fight', 'critical_hit', 'ok', 'bip'} & known
    for n in known - used:
        os.remove(os.path.join(out, 'fx', n + '.mp3'))
    index['fx'] = sorted(used & known)
    json.dump(index, open(os.path.join(out, 'index.json'), 'w'), separators=(',', ':'))
    print(f"fx {len(index['fx'])}/{len(known)} kept, music {len(mus)}, sprites {len(index['sprites'])}, spells {len(index['spells'])}")


if __name__ == '__main__':
    main(*sys.argv[1:3])
