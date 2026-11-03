#!/usr/bin/env python3
"""Inspect SWF files: header, tag counts, exported symbols, sprite frame counts."""
import sys, zlib, struct, collections

TAGS = {0:'End',1:'ShowFrame',2:'DefineShape',4:'PlaceObject',5:'RemoveObject',6:'DefineBits',8:'JPEGTables',9:'SetBackgroundColor',
 10:'DefineFont',11:'DefineText',12:'DoAction',13:'DefineFontInfo',14:'DefineSound',20:'DefineBitsLossless',21:'DefineBitsJPEG2',
 22:'DefineShape2',24:'Protect',26:'PlaceObject2',28:'RemoveObject2',32:'DefineShape3',33:'DefineText2',34:'DefineButton2',
 35:'DefineBitsJPEG3',36:'DefineBitsLossless2',37:'DefineEditText',39:'DefineSprite',43:'FrameLabel',46:'DefineMorphShape',
 48:'DefineFont2',56:'ExportAssets',57:'ImportAssets',59:'DoInitAction',62:'DefineFontInfo2',69:'FileAttributes',70:'PlaceObject3',
 71:'ImportAssets2',73:'DefineFontAlignZones',74:'CSMTextSettings',75:'DefineFont3',77:'Metadata',83:'DefineShape4',84:'DefineMorphShape2',
 86:'DefineSceneAndFrameLabelData',88:'DefineFontName'}

def load(path):
    d = open(path, 'rb').read()
    sig = d[:3]
    if sig == b'CWS':
        d = d[:8] + zlib.decompress(d[8:])
    elif sig != b'FWS':
        raise ValueError('not swf %r' % sig)
    return d

def rect_len(d, off):
    nbits = d[off] >> 3
    return (5 + nbits * 4 + 7) // 8

def tags(d, off, end):
    while off < end:
        code_len = struct.unpack_from('<H', d, off); off += 2
        code, ln = code_len[0] >> 6, code_len[0] & 0x3f
        if ln == 0x3f:
            ln = struct.unpack_from('<I', d, off)[0]; off += 4
        yield code, off, ln
        off += ln
        if code == 0:
            break

def main(path):
    d = load(path)
    ver = d[3]
    off = 8 + rect_len(d, 8)
    rate, count = struct.unpack_from('<HH', d, off); off += 4
    print(f'{path}: v{ver} fps {rate/256} frames {count} size {len(d)}')
    cnt = collections.Counter()
    exports = {}
    sprites = {}
    labels = []
    for code, o, ln in tags(d, off, len(d)):
        cnt[TAGS.get(code, code)] += 1
        if code == 56:
            n = struct.unpack_from('<H', d, o)[0]; p = o + 2
            for _ in range(n):
                cid = struct.unpack_from('<H', d, p)[0]; p += 2
                e = d.index(b'\0', p); exports[d[p:e].decode('latin1')] = cid; p = e + 1
        if code == 39:
            sid, frames = struct.unpack_from('<HH', d, o)
            inner = collections.Counter(TAGS.get(c, c) for c, _, _ in tags(d, o + 4, o + ln))
            fl = []
            for c, oo, l in tags(d, o + 4, o + ln):
                if c == 43: fl.append(d[oo:oo+l].split(b'\0')[0].decode('latin1'))
            sprites[sid] = (frames, dict(inner), fl)
        if code == 43:
            labels.append(d[o:o+ln].split(b'\0')[0].decode('latin1'))
    print(' tags', dict(cnt))
    print(' root labels', labels[:20])
    print(' exports', len(exports), list(exports.items())[:40])
    for name, cid in list(exports.items())[:12]:
        if cid in sprites:
            print('  ', name, cid, sprites[cid])

if __name__ == '__main__':
    for p in sys.argv[1:]:
        main(p)
