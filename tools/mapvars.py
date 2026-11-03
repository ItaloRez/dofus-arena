#!/usr/bin/env python3
"""Read the variables (backgroundNum, ambianceId, ...) a Dofus map SWF sets in its DoAction."""
import sys, struct, os, re, json
sys.path.insert(0, os.path.dirname(__file__))
from swfinfo import load, rect_len, tags

def avm1_vars(a):
    pool, stack, out, p = [], [], {}, 0
    while p < len(a):
        op = a[p]; p += 1
        if op == 0: break
        ln = 0
        if op >= 0x80: ln = struct.unpack_from('<H', a, p)[0]; p += 2
        body = a[p:p + ln]; p += ln
        if op == 0x88:
            n = struct.unpack_from('<H', body)[0]; q = 2
            for _ in range(n): e = body.index(b'\0', q); pool.append(body[q:e].decode('latin1')); q = e + 1
        elif op == 0x96:
            q = 0
            while q < len(body):
                t = body[q]; q += 1
                if t == 0: e = body.index(b'\0', q); stack.append(body[q:e].decode('latin1')); q = e + 1
                elif t == 1: stack.append(struct.unpack_from('<f', body, q)[0]); q += 4
                elif t in (2, 3): stack.append(None)
                elif t == 4: stack.append(None); q += 1
                elif t == 5: stack.append(bool(body[q])); q += 1
                elif t == 6: hi, lo = struct.unpack_from('<II', body, q); stack.append(struct.unpack('<d', struct.pack('<II', lo, hi))[0]); q += 8
                elif t == 7: stack.append(struct.unpack_from('<i', body, q)[0]); q += 4
                elif t == 8: stack.append(pool[body[q]]); q += 1
                elif t == 9: stack.append(pool[struct.unpack_from('<H', body, q)[0]]); q += 2
        elif op == 0x4F and len(stack) >= 3:
            v = stack.pop(); k = stack.pop(); stack.pop(); out[k] = v
        elif op == 0x1D and len(stack) >= 2:
            v = stack.pop(); k = stack.pop(); out[k] = v
        elif op == 0x1C and stack:
            stack[-1] = ('var', stack[-1])
        elif op == 0x17 and stack: stack.pop()
    return out

def map_vars(path):
    d = load(path)
    off = 8 + rect_len(d, 8) + 4
    for c, o, l in tags(d, off, len(d)):
        if c == 12:
            return avm1_vars(d[o:o + l])
    return {}

if __name__ == '__main__':
    for p in sys.argv[1:]:
        v = map_vars(p); v.pop('mapData', None)
        print(os.path.basename(p), v)
