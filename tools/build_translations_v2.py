#!/usr/bin/env python3
"""RomanianLearn 翻译表生成 —— 整合版（一次跑完，顺序正确）。

流程:
  1. kaikki 罗语维基词典 -> 英文义项（带词性、词形还原）
  2. ECDICT 英汉词典 -> 中文释义（按词性匹配）
  3. 人工校正表覆盖（最高优先级）
  4. 变形词从还原形继承
  5. 输出 translations.tsv

用法: python3 build_all.py <工作目录>
"""
import csv
import json
import os
import re
import sqlite3
import sys

W = sys.argv[1] if len(sys.argv) > 1 else "."

KADB = os.path.join(W, "kaikki.db")
ECD = os.path.join(W, "ecdict.csv")
WORDS = os.path.join(W, "words.tsv")
LEMMAS = os.path.join(W, "lemmas.tsv")
OV1 = os.path.join(W, "overrides_all.tsv")
OV2 = os.path.join(W, "overrides_missing.tsv")
OUT = os.path.join(W, "translations_final.tsv")

# ---------- 正则 ----------
FORM_RE = re.compile(
    r"(?:^|\s)(?:form|spelling|singular|plural|participle|inflection|"
    r"indicative|subjunctive|imperative|gerund)\s+of\b", re.I)
PURE_TAG_RE = re.compile(
    r"^(?:(?:definite|indefinite|plural|singular|nominative|accusative|"
    r"genitive|dative|vocative|masculine|feminine|neuter|first|second|third|"
    r"present|past|future|imperative|participle|subjunctive|indicative|"
    r"comparative|superlative|alternative)[\s,/\-]*)+$", re.I)
OF_RE = re.compile(r"\bof\s+([a-zăâîșț\-]+)", re.I)
TAG_RE = re.compile(r"\[(?:计|网络|医|化|法|经|机|电|物|数|生|农|军|海|冶|纺|建|矿|商|律|俚|古|诗|方)\]")
DEMOTE = {"name", "contraction", "abbrev", "phrase", "interj", "punct"}
POS_MAP = {
    "noun": ["n.", "n", "pl."], "verb": ["v.", "vt.", "vi.", "v", "aux."],
    "adj": ["adj.", "a.", "adj", "a"], "adv": ["adv.", "ad.", "adv", "ad"],
    "prep": ["prep.", "prep"], "conj": ["conj.", "conj"],
    "pron": ["pron.", "pron"], "det": ["det.", "pron.", "adj.", "a."],
    "article": ["art.", "a.", "pron."], "num": ["num.", "n.", "a."],
    "particle": ["adv.", "part.", "int."], "phrase": ["phr.", "n."],
    "interj": ["int.", "interj.", "n."], "contraction": ["n.", "abbr."],
}
SUFFIX = [("ului", "u"), ("ului", ""), ("ul", "u"), ("ul", ""),
          ("ilor", "i"), ("ilor", ""), ("ilor", "e"), ("ele", "ă"),
          ("ele", "e"), ("le", "ă"), ("le", "e"), ("le", ""), ("lor", ""),
          ("lor", "ă"), ("ei", "ă"), ("ei", "e"), ("ii", "iu"), ("ii", "ie"),
          ("i", ""), ("ea", "e"), ("a", "ă"), ("a", ""), ("ă", ""),
          ("e", ""), ("u", ""), ("i", "")]


# ---------- 步骤 1: kaikki -> 英文义 ----------
def step1_kaikki():
    con = sqlite3.connect(KADB)

    def entry_of(w):
        r = con.execute("SELECT data FROM entries WHERE word=?", (w,)).fetchone()
        return json.loads(r[0]) if r else []

    def form_base(w):
        r = con.execute("SELECT base FROM forms WHERE form=? LIMIT 1", (w,)).fetchone()
        return r[0] if r and r[0] and r[0] != w else None

    def real_cands(cands):
        out = []
        for c in cands:
            gl = [g for g in c["glosses"]
                  if not FORM_RE.search(g) and not PURE_TAG_RE.match(g.strip())]
            if gl:
                out.append({"pos": c["pos"], "glosses": gl})
        return out

    def best_of(cs):
        o = [c for c in cs if c["pos"] not in DEMOTE] + \
            [c for c in cs if c["pos"] in DEMOTE]
        return o[0] if o else None

    def reduce_rules(w):
        for suf, rep in SUFFIX:
            if w.endswith(suf) and len(w) - len(suf) >= 2:
                stem = w[:-len(suf)] + rep
                if stem != w and entry_of(stem):
                    return stem
        return None

    def lookup(word):
        w = word.lower()
        cands = entry_of(w)
        real = real_cands(cands)
        b = best_of(real) if real else None
        if (not real) or (b and b["pos"] in DEMOTE):
            for base in (form_base(w), reduce_rules(w)):
                if not base:
                    continue
                bc = real_cands(entry_of(base))
                if bc:
                    bb = best_of(bc)
                    return {"pos": bb["pos"], "en": ", ".join(bb["glosses"][:3]),
                            "base": base}
        if not real:
            for c in cands:
                for g in c["glosses"]:
                    m = OF_RE.search(g)
                    if m:
                        bc = real_cands(entry_of(m.group(1)))
                        if bc:
                            bb = best_of(bc)
                            return {"pos": bb["pos"],
                                    "en": ", ".join(bb["glosses"][:3]),
                                    "base": m.group(1)}
            return None
        return {"pos": b["pos"], "en": ", ".join(b["glosses"][:3])}

    words = collect_words()
    out = {}
    for w in words:
        r = lookup(w)
        if r:
            out[w] = r
    con.close()
    print(f"  kaikki 命中 {len(out)}/{len(words)}", flush=True)
    return out


# ---------- 步骤 2: ECDICT 英 -> 中 ----------
def split_senses(t):
    if not t:
        return []
    t = t.replace("\\n", "\n").replace("\\r", "").replace("\r", "")
    segs = []
    for raw in t.split("\n"):
        s = raw.strip()
        if not s:
            continue
        if TAG_RE.search(s):
            s = TAG_RE.split(s)[0].strip()
        if not s:
            continue
        m = re.match(r"^((?:[a-z]{1,5}\.\s*)+)(.*)$", s, re.I)
        if m:
            pf = re.findall(r"[a-z]{1,5}\.", m.group(1).strip().lower())
            segs.append((pf, m.group(2).strip()))
        else:
            segs.append(([], s))
    return segs


# 词形说明（"xxx的过去分词"/"（end的过去式）"）对学习者无用，删掉
MORPH_RE = re.compile(
    r"[（(][^）)]*(?:过去式|过去分词|现在分词|的ing形式|名词复数|复数形式|"
    r"第三人称单数|比较级|最高级|变体)[^）)]*[）)]")
# 中文里混入的英文原形标注，如 "bring的过去式和过去分词"
MORPH2_RE = re.compile(
    r"[a-zA-Z]{2,}\s*的\s*(?:过去式|过去分词|现在分词|ing形式|名词复数|复数形式)")
# 括号内纯英文注释
PAREN_EN_RE = re.compile(r"[（(][a-zA-Z][^）)]*[）)]")


def clean_body(body):
    body = MORPH_RE.sub("", body)
    body = MORPH2_RE.sub("", body)
    body = PAREN_EN_RE.sub("", body)
    parts = [p.strip() for p in re.split(r"[；;，,]", body) if p.strip()]
    parts = [p for p in parts if not re.fullmatch(r"[a-z]{1,5}\.", p, flags=re.I)]
    # 去掉开头残留的动词原形（"bring" 之类）
    parts = [re.sub(r"^[a-zA-Z]{2,}\s*", "", p).strip() or p for p in parts]
    # 去掉清理后残留的 "和过去分词" / "的过去式" 等碎片
    parts = [re.sub(r"^和?\s*(?:过去式|过去分词|现在分词|ing形式)\s*$", "", p).strip()
             for p in parts]
    parts = [p for p in parts if p]
    # 去掉 "[昆虫]" 这类学科标签
    parts = [re.sub(r"^\[[^\]]*\]", "", p).strip() for p in parts]
    parts = [p for p in parts if p]
    line = "；".join(parts[:3]).strip("；，,。 ")
    if len(line) > 30:
        line = line[:30].rstrip("；，, ") + "…"
    return line


def step2_ecdict(en_map):
    print("  加载 ECDICT...", flush=True)
    ec = {}
    for row in csv.DictReader(open(ECD, encoding="utf-8")):
        w = (row.get("word") or "").strip().lower()
        if not w or w in ec:
            continue
        t = (row.get("translation") or "").strip()
        if t:
            ec[w] = t
    print(f"  ECDICT {len(ec)} 条", flush=True)

    def pick(text, pos):
        segs = split_senses(text)
        if not segs:
            return ""
        want = POS_MAP.get(pos, [])
        if want:
            for pf, b in segs:
                if any(p in want for p in pf):
                    z = clean_body(b)
                    if z:
                        return z
        for pf, b in segs:
            if not pf:
                z = clean_body(b)
                if z:
                    return z
        return clean_body(segs[0][1])

    out = {}
    for w, v in en_map.items():
        en, pos = v.get("en", ""), v.get("pos", "")
        cands = [en] + [p.strip() for p in en.split(",") if p.strip()]
        cands += [p.strip() for p in re.split(r"[;；]", en) if p.strip()]
        cands += re.findall(r"[a-zA-Z][a-zA-Z\-' ]{1,24}", en)
        zh = ""
        for c in cands:
            cl = c.lower().strip(" .,;:")
            if not cl:
                continue
            # 剥离冠词/不定式/修饰语，提高 ECDICT 命中率
            variants = [cl,
                        re.sub(r"^to\s+", "", cl),
                        re.sub(r"^(?:a|an|the|some)\s+", "", cl),
                        re.sub(r"^(?:a|an|the|some)\s+", "", re.sub(r"^to\s+", "", cl)),
                        re.sub(r"\s+of\s+.*$", "", cl),
                        re.sub(r"\s*\(.*$", "", cl)]
            # 再去掉 "someone known" 这类补充说明，只留首个名词短语
            variants += [re.split(r",|\s+(?:someone|somebody|that|which|who)\b", v)[0].strip()
                         for v in variants]
            for k in variants:
                if k and k in ec:
                    zh = pick(ec[k], pos)
                    if zh:
                        break
            if zh:
                break
        # 兜底：去掉英文义里的修饰语，只查核心名词/动词
        if not zh:
            core = []
            for c in cands:
                cl = c.lower().strip(" .,;:")
                cl = re.sub(r"^(?:to|a|an|the|of or relating to|having|relative to)\s+", "", cl)
                # 取最后一个实词（英文释义常以核心词结尾）
                toks = [t for t in re.findall(r"[a-z\-]{3,}", cl)]
                if toks:
                    core.append(toks[-1])
                    core.append(toks[0])
            for k in core:
                if k in ec:
                    zh = pick(ec[k], pos)
                    if zh:
                        break
        out[w] = {"pos": pos, "en": en, "zh": zh, "src": "auto"}
    hit = sum(1 for v in out.values() if v["zh"])
    print(f"  中文命中 {hit}/{len(out)}", flush=True)
    return out


# ---------- 工具 ----------
def collect_words():
    ws = []
    seen = set()
    for p in (WORDS, LEMMAS):
        if not os.path.exists(p):
            continue
        for line in open(p, encoding="utf-8"):
            w = line.split("\t")[0].strip()
            if w and w.lower() not in seen:
                seen.add(w.lower())
                ws.append(w)
    return ws


def load_overrides():
    ov = {}
    for p in (OV1, OV2):
        if not os.path.exists(p):
            continue
        for line in open(p, encoding="utf-8"):
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 2 or not parts[0].strip():
                continue
            w = parts[0].strip()
            ov[w] = {"zh": parts[1].strip(),
                     "en": parts[2].strip() if len(parts) > 2 else ""}
    return ov


def main():
    words = collect_words()
    print(f"词库 {len(words)} 条", flush=True)

    print("[1] kaikki -> 英文义", flush=True)
    en_map = step1_kaikki()

    print("[2] ECDICT -> 中文", flush=True)
    zh_map = step2_ecdict(en_map)

    print("[3] 人工校正覆盖", flush=True)
    ov = load_overrides()
    n = 0
    for w, o in ov.items():
        cur = zh_map.get(w, {"pos": "", "en": ""})
        zh_map[w] = {"pos": cur.get("pos", ""),
                     "en": o["en"] or cur.get("en", ""),
                     "zh": o["zh"], "src": "manual"}
        n += 1
    print(f"  覆盖 {n} 条", flush=True)

    print("[4] 变形词继承", flush=True)
    wset = set(w.lower() for w in words)
    lower = {w.lower(): w for w in words}
    inh = 0
    for w in words:
        if zh_map.get(w, {}).get("zh"):
            continue
        lw = w.lower()
        for suf, rep in SUFFIX:
            if lw.endswith(suf) and len(lw) - len(suf) >= 2:
                cand = lw[:-len(suf)] + rep
                if cand != lw and cand in wset:
                    base = lower[cand]
                    bz = zh_map.get(base, {})
                    if bz.get("zh"):
                        zh_map[w] = {"pos": bz.get("pos", ""),
                                     "en": bz.get("en", ""),
                                     "zh": bz["zh"], "src": f"inherit:{base}"}
                        inh += 1
                        break
    print(f"  继承 {inh} 条", flush=True)

    missing = [w for w in words if not zh_map.get(w, {}).get("zh")]
    print(f"[5] 输出（缺中文 {len(missing)}）", flush=True)

    # 英文释义里的交叉引用描述对学习者无用，去掉
    XREF_RE = re.compile(
        r"\s*,?\s*(?:synonym of|equivalent to|alternative form of|"
        r"see also|compare with)\s+[^,;]+", re.I)

    with open(OUT, "w", encoding="utf-8") as f:
        for w in words:
            v = zh_map.get(w, {})
            z = (v.get("zh") or "").strip()
            e = (v.get("en") or "").strip()
            e = XREF_RE.sub("", e).strip(" ,;")
            if not e:
                e = (v.get("en") or "").strip()   # 全被清空则保留原值
            if len(e) > 70:
                e = e[:70].rstrip(" ,;") + "…"
            f.write(f"{w}\t{z}\t{e}\n")

    print(f"\n✅ {OUT}")
    print(f"   词条 {len(words)}，缺中文 {len(missing)}，"
          f"{os.path.getsize(OUT)/1024:.1f} KB")
    if missing:
        print(f"   缺中文样例: {missing[:20]}")
    json.dump(zh_map, open(os.path.join(W, "zh_final.json"), "w", encoding="utf-8"),
              ensure_ascii=False)


if __name__ == "__main__":
    main()
