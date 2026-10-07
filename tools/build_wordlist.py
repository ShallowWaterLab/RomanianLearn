#!/usr/bin/env python3
"""从 CoRoLa 词频表生成精简内置词库（仅罗马尼亚语字母、去重、去噪）。"""
import re
import sys
import os

RO = re.compile(r'^[a-zăâîșțşţA-ZĂÂÎȘȚŞŢ]+$')
MIN_LEN = 2
MAX_LEN = 20


def load(path, n):
    seen = set()
    out = []
    with open(path, encoding='utf-8') as f:
        for line in f:
            parts = line.rstrip('\n').split('\t')
            if len(parts) < 2:
                continue
            w = parts[0].strip()
            fr = parts[1].strip()
            if not RO.match(w):
                continue
            if not (MIN_LEN <= len(w) <= MAX_LEN):
                continue
            key = w.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append((key, fr))
            if len(out) >= n:
                break
    return out


def main():
    src_dir = sys.argv[1]
    dst_dir = sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 5000
    os.makedirs(dst_dir, exist_ok=True)

    words = load(os.path.join(src_dir, 'corola_word_freq_gte10.tsv'), n)
    lemmas = load(os.path.join(src_dir, 'corola_lemma_freq_gte10.tsv'), n)

    wp = os.path.join(dst_dir, 'words.tsv')
    lp = os.path.join(dst_dir, 'lemmas.tsv')
    with open(wp, 'w', encoding='utf-8') as f:
        for w, fr in words:
            f.write(f'{w}\t{fr}\n')
    with open(lp, 'w', encoding='utf-8') as f:
        for w, fr in lemmas:
            f.write(f'{w}\t{fr}\n')

    print(f'words.tsv : {len(words)} 词, {os.path.getsize(wp)} 字节')
    print(f'lemmas.tsv: {len(lemmas)} 词, {os.path.getsize(lp)} 字节')
    print('前10词:', ', '.join(w for w, _ in words[:10]))


if __name__ == '__main__':
    main()
