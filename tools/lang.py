#!/usr/bin/env python3
"""Run the data-building ActionScript of a Dofus lang SWF and dump the resulting objects as JSON.

  lang.py <file.swf> <out.json>
"""
import sys, struct, json, os
sys.path.insert(0, os.path.dirname(__file__))
from swfinfo import load, rect_len, tags


class Obj(dict):
    pass


def run(code, glob):
    pool, st, p = [], [], 0
    def pop():
        return st.pop() if st else None
    while p < len(code):
        op = code[p]; p += 1
        if op == 0:
            break
        ln = 0
        if op >= 0x80:
            ln = struct.unpack_from('<H', code, p)[0]; p += 2
        body = code[p:p + ln]; p += ln
        if op == 0x88:
            n = struct.unpack_from('<H', body)[0]; q = 2; pool = []
            for _ in range(n):
                e = body.index(b'\0', q); pool.append(body[q:e].decode('utf-8', 'replace')); q = e + 1
        elif op == 0x96:
            q = 0
            while q < len(body):
                t = body[q]; q += 1
                if t == 0: e = body.index(b'\0', q); st.append(body[q:e].decode('utf-8', 'replace')); q = e + 1
                elif t == 1: st.append(struct.unpack_from('<f', body, q)[0]); q += 4
                elif t in (2, 3): st.append(None)
                elif t == 4: st.append(None); q += 1
                elif t == 5: st.append(bool(body[q])); q += 1
                elif t == 6:
                    hi, lo = struct.unpack_from('<II', body, q)
                    v = struct.unpack('<d', struct.pack('<II', lo, hi))[0]
                    st.append(int(v) if v == int(v) else v); q += 8
                elif t == 7: st.append(struct.unpack_from('<i', body, q)[0]); q += 4
                elif t == 8: st.append(pool[body[q]]); q += 1
                elif t == 9: st.append(pool[struct.unpack_from('<H', body, q)[0]]); q += 2
                else: raise ValueError('push type %d' % t)
        elif op == 0x42:  # InitArray
            n = int(pop() or 0); st.append([pop() for _ in range(n)])
        elif op == 0x43:  # InitObject
            n = int(pop() or 0); o = Obj()
            for _ in range(n):
                v = pop(); k = pop(); o[str(k)] = v
            st.append(o)
        elif op == 0x1C:  # GetVariable
            name = pop()
            if name not in glob: glob[name] = Obj()
            st.append(glob[name])
        elif op == 0x1D:  # SetVariable
            v = pop(); glob[pop()] = v
        elif op == 0x4E:  # GetMember
            k = pop(); o = pop()
            if isinstance(o, dict):
                if str(k) not in o: o[str(k)] = Obj()
                st.append(o[str(k)])
            else:
                st.append(None)
        elif op == 0x4F:  # SetMember
            v = pop(); k = pop(); o = pop()
            if isinstance(o, dict): o[str(k)] = v
        elif op == 0x47:
            b = pop(); a = pop()
            try: st.append(a + b)
            except TypeError: st.append(str(a) + str(b))
        elif op == 0x17:
            pop()
        elif op == 0x40:  # NewObject
            pop(); n = int(pop() or 0); [pop() for _ in range(n)]; st.append(Obj())
        elif op == 0x52:  # CallMethod
            pop(); pop(); n = int(pop() or 0); [pop() for _ in range(n)]; st.append(None)
        elif op in (0x3A, 0x3B):
            pop()
            if op == 0x3A: pop()
            st.append(True)
        # anything else: ignore


def main(path, out):
    d = load(path)
    off = 8 + rect_len(d, 8) + 4
    glob = {}
    for c, o, l in tags(d, off, len(d)):
        if c == 12:
            run(d[o:o + l], glob)
        elif c == 59:
            run(d[o + 2:o + l], glob)
    json.dump(glob, open(out, 'w'), ensure_ascii=False)


if __name__ == '__main__':
    main(*sys.argv[1:3])
