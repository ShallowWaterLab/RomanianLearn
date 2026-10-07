#!/usr/bin/env python3
"""把人工校正表合并进机器翻译结果。

用法：python3 tools/apply_overrides.py data

读取 data/translations.tsv 与 data/overrides.tsv，
用校正表覆盖对应词条，并报告覆盖率与高频词命中情况。
"""
import os
import sys


def read_tsv(path):
    rows = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip("\n")
            if not line.strip():
                continue
            parts = line.split("\t")
            while len(parts) < 3:
                parts.append("")
            rows.append(parts[:3])
    return rows


def main():
    data_dir = sys.argv[1] if len(sys.argv) > 1 else "data"
    tr_path = os.path.join(data_dir, "translations.tsv")
    ov_path = os.path.join(data_dir, "overrides.tsv")

    if not os.path.exists(tr_path):
        print(f"❌ 找不到 {tr_path}，请先运行 build_translations.py")
        return 1
    if not os.path.exists(ov_path):
        print(f"⚠️  找不到 {ov_path}，无校正可用")
        return 1

    tr = read_tsv(tr_path)
    ov = read_tsv(ov_path)

    overrides = {}
    for parts in ov:
        w = parts[0].strip()
        if w:
            overrides[w] = (parts[1].strip(), parts[2].strip())

    applied = 0
    missing_in_dict = []
    for row in tr:
        w = row[0]
        if w in overrides:
            zh, en = overrides[w]
            if zh:
                row[1] = zh
            if en:
                row[2] = en
            applied += 1

    # 校正表里有、但词库里没有的词
    dict_words = {r[0] for r in tr}
    for w in overrides:
        if w not in dict_words:
            missing_in_dict.append(w)

    with open(tr_path, "w", encoding="utf-8") as f:
        for row in tr:
            f.write("\t".join(row) + "\n")

    print(f"校正表词条: {len(overrides)}")
    print(f"实际应用:   {applied}")
    print(f"校正表有但词库无: {len(missing_in_dict)}")
    if missing_in_dict:
        print(f"  例: {missing_in_dict[:10]}")
    print(f"✅ 已更新 {tr_path}")

    # 抽查高频虚词
    print("\n抽查（前 20 高频词）:")
    for row in tr[:20]:
        print(f"  {row[0]:12s} {row[1]:16s} {row[2]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
