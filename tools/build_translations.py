#!/usr/bin/env python3
"""为 RomanianLearn 词库生成中文/英文翻译对照表。

输出 data/translations.tsv，格式：word<TAB>zh<TAB>en

设计要点：
- 构建时预生成并打包进仓库 → 运行时离线可用、瞬时响应
- 批量翻译（默认 120 词/批），行数不匹配时降级为逐词翻译
- 带重试与本地缓存，中断后可续跑
"""
import argparse
import json
import os
import sys
import time
import urllib.parse
import urllib.request

ENDPOINT = "https://translate.googleapis.com/translate_a/single"
BATCH_SIZE = 120
CACHE_FILE = ".translate_cache.json"


def translate_batch(words, tl, sl="ro", retries=4, timeout=30):
    """翻译一批词，返回与输入等长的列表；失败返回 None。"""
    q = "\n".join(words)
    url = (f"{ENDPOINT}?client=gtx&sl={sl}&tl={tl}&dt=t&q="
           + urllib.parse.quote(q))
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(url, timeout=timeout) as r:
                data = json.load(r)
            text = "".join(seg[0] for seg in data[0] if seg and seg[0])
            lines = text.split("\n")
            if len(lines) == len(words):
                return [ln.strip() for ln in lines]
        except Exception as e:
            print(f"      重试 {attempt+1}/{retries}: {e}", flush=True)
        time.sleep(1.5 * (attempt + 1))
    return None


def translate_one(word, tl, sl="ro"):
    """逐词翻译（批量失败时的降级路径）。"""
    for attempt in range(3):
        try:
            url = (f"{ENDPOINT}?client=gtx&sl={sl}&tl={tl}&dt=t&q="
                   + urllib.parse.quote(word))
            with urllib.request.urlopen(url, timeout=20) as r:
                data = json.load(r)
            text = "".join(seg[0] for seg in data[0] if seg and seg[0])
            return text.strip()
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    return ""


def load_cache(path):
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def save_cache(path, cache):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)


def collect_words(*paths):
    """从词库文件收集所有词（去重，保持出现顺序）。"""
    seen = set()
    out = []
    for p in paths:
        if not os.path.exists(p):
            print(f"  ⚠️ 跳过不存在的文件: {p}")
            continue
        with open(p, encoding="utf-8") as f:
            for line in f:
                w = line.split("\t")[0].strip()
                if w and w not in seen:
                    seen.add(w)
                    out.append(w)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data_dir", help="含 words.tsv / lemmas.tsv 的目录")
    ap.add_argument("-o", "--output", default=None, help="输出文件（默认 <data_dir>/translations.tsv）")
    ap.add_argument("-n", "--limit", type=int, default=0, help="只处理前 N 个词（调试用）")
    ap.add_argument("--batch", type=int, default=BATCH_SIZE)
    args = ap.parse_args()

    data_dir = args.data_dir
    out_path = args.output or os.path.join(data_dir, "translations.tsv")
    cache_path = os.path.join(data_dir, CACHE_FILE)

    words = collect_words(
        os.path.join(data_dir, "words.tsv"),
        os.path.join(data_dir, "lemmas.tsv"),
    )
    if args.limit:
        words = words[:args.limit]
    print(f"待翻译词数: {len(words)}")

    cache = load_cache(cache_path)

    for tl in ("zh-CN", "en"):
        key = tl
        done = cache.setdefault(key, {})
        todo = [w for w in words if w not in done or done[w] == ""]
        print(f"\n[{tl}] 已有 {len(done)} 条，待处理 {len(todo)} 条")

        i = 0
        while i < len(todo):
            chunk = todo[i:i + args.batch]
            res = translate_batch(chunk, tl)
            if res is None:
                print(f"    批量失败，降级为逐词翻译（{len(chunk)} 词）", flush=True)
                res = []
                for w in chunk:
                    res.append(translate_one(w, tl))
                    time.sleep(0.12)
            for w, t in zip(chunk, res):
                done[w] = t
            i += len(chunk)
            save_cache(cache_path, cache)
            pct = i / len(todo) * 100 if todo else 100
            print(f"    进度 {i}/{len(todo)} ({pct:.1f}%)", flush=True)
            time.sleep(0.25)

    # 写出最终文件
    zh = cache.get("zh-CN", {})
    en = cache.get("en", {})
    missing = 0
    with open(out_path, "w", encoding="utf-8") as f:
        for w in words:
            z = zh.get(w, "")
            e = en.get(w, "")
            if not z or not e:
                missing += 1
            f.write(f"{w}\t{z}\t{e}\n")

    size = os.path.getsize(out_path)
    print(f"\n✅ 已写出 {out_path}")
    print(f"   词条 {len(words)}，其中缺翻译 {missing}，文件 {size} 字节 ({size/1024:.1f} KB)")
    if missing:
        print("   ⚠️ 存在缺翻译的词，可重跑本脚本补全（有缓存）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
