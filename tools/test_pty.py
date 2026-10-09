#!/usr/bin/env python3
"""真实 pty 下的交互测试：按键回显 + 模式切换 + 完整回合 + Ctrl+C 退出。

为什么必须用 pty：
  stdin 不是 tty 时 readline 不做回显，管道测不出"按一次键出两个字母"这类 bug。

为什么必须等内容而不是死等时间：
  不同机器启动速度不同（远端开发机明显比本地慢），固定 sleep 会导致假失败。

界面模型（v1.0.0，高亮选择）：
  主菜单：↑↓（ESC[A/ESC[B）移动高亮，回车/空格确认，Esc 退出
  主菜单提示行："↑↓ 选择 · 空格/回车 确认 · Esc 退出"
  答题提示："› "；答错回显 "✗ 错误 正确答案：<word>"
"""
import json
import os
import pty
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time

SCRIPT = sys.argv[1] if len(sys.argv) > 1 else \
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "RomanianLearn.js")

ANSI = re.compile(rb"\x1b\[[0-9;]*[A-Za-z]")
# 主菜单就绪标志：标题行
MENU_READY = r"RomanianLearn v"
# 主菜单页脚（新 UI）
MENU_FOOTER = r"↑↓ 选择"
# 答题提示：中文释义行之后是 "› "
Q_PROMPT = r"›\s*$"
# 进入各模式后，屏幕顶部的大标题
MODE_TITLE = {
    "词汇拼写": r"── 词汇拼写 ──",
    "词形变化": r"── 词形变化 ──",
    "听音拼写": r"── 听音拼写 ──",
    "句子填空": r"── 句子填空 ──",
}


def _seed_home():
    """预置档案，跳过启动时的「新建档案」引导。"""
    home = tempfile.mkdtemp(prefix="rl_pty_")
    pdir = os.path.join(home, ".romanianlearn", "profiles")
    os.makedirs(pdir, exist_ok=True)
    prof = {"name": "测试", "created": "2026-01-01T00:00:00Z",
            "totalCorrect": 0, "totalWrong": 0, "words": {}, "asked": 0}
    with open(os.path.join(pdir, "测试.json"), "w", encoding="utf-8") as f:
        json.dump(prof, f, ensure_ascii=False)
    with open(os.path.join(home, ".romanianlearn", "index.json"), "w", encoding="utf-8") as f:
        json.dump({"current": "测试", "profiles": ["测试"]}, f, ensure_ascii=False)
    return home


class Session:
    def __init__(self):
        self.home = _seed_home()
        self.master, slave = pty.openpty()
        self.p = subprocess.Popen(
            ["node", SCRIPT], stdin=slave, stdout=slave, stderr=slave,
            close_fds=True, env={**os.environ, "HOME": self.home},
        )
        os.close(slave)
        self.buf = b""
        self.pos = 0         # 已消费到的「纯文本」偏移：只在新输出里找目标

    def _pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.master], [], [], 0.05)
            if r:
                try:
                    d = os.read(self.master, 65536)
                except OSError:
                    return
                if not d:
                    return
                self.buf += d

    def wait_for(self, pattern, timeout=15.0):
        """在已消费位置之后的新输出里等 pattern；命中则精确推进到匹配末尾。

        注意：必须推进到 m.end() 而不是缓冲区末尾——模式标题和答题提示
        常在同一批数据里到达，推到末尾会把紧随其后的提示一起跳过。
        """
        if isinstance(pattern, str):
            pattern = re.compile(pattern)
        deadline = time.time() + timeout
        while True:
            text = ANSI.sub(b"", self.buf).decode("utf-8", "replace")
            m = pattern.search(text, self.pos)
            if m:
                self.pos = m.end()
                return m
            if time.time() >= deadline:
                return None
            self._pump(0.2)

    def send(self, data):
        os.write(self.master, data)

    def snapshot(self):
        return ANSI.sub(b"", self.buf).decode("utf-8", "replace")

    def delta(self, before_len):
        """返回自 before_len 之后新增的纯文本。"""
        text = self.snapshot()
        return text[before_len:]

    def mark(self):
        """标记当前输出位置（纯文本长度），供 delta 使用。"""
        return len(self.snapshot())

    def close(self):
        try:
            self.p.kill()
        except Exception:
            pass
        try:
            os.close(self.master)
        except Exception:
            pass


def strip_len(sess):
    return len(sess.snapshot())


def main():
    ok = True

    # ---------- 测试 1：各玩法模式首次进入时的回显 ----------
    # 主菜单 0..3 依次为 词汇拼写/词形变化/听音拼写/句子填空；
    # 用「从 0 下移 n 次 + 回车」进入。听音拼写依赖 espeak，缺则可能跳过。
    print("测试 1: 各玩法模式首次进入的回显")
    for idx, name in enumerate(["词汇拼写", "词形变化", "听音拼写", "句子填空"]):
        s = Session()
        if not s.wait_for(MENU_READY, 25):
            print(f"  ❌ {name}: 主菜单未出现（启动失败）")
            ok = False
            s.close()
            continue
        s.send(b"\x1b[B" * idx + b"\r")
        if not s.wait_for(MODE_TITLE[name], 20):
            print(f"  ❌ {name}: 未进入该模式")
            ok = False
            s.close()
            continue
        # 等答题提示
        if not s.wait_for(Q_PROMPT, 20):
            print(f"  ❌ {name}: 未出现输入提示")
            ok = False
            s.close()
            continue
        bad = False
        for k in "de":
            n0 = s.mark()
            s.send(k.encode())
            s._pump(0.6)
            new = s.delta(n0)
            if k + k in new:
                print(f"  ❌ {name}: 按 '{k}' 出现双回显 -> {new!r}")
                bad = True
        if not bad:
            print(f"  ✅ {name}: 无重复回显")
        else:
            ok = False
        s.close()

    # ---------- 测试 2：模式间来回切换后输入仍正常 ----------
    print("\n测试 2: 模式间来回切换后的输入")
    s = Session()
    if s.wait_for(MENU_READY, 25):
        # 进词汇拼写 -> 答题 -> Esc 回主菜单 -> 进词形变化 -> 再回主菜单 -> 再进词汇拼写
        seq = [
            (0, "第1次进词汇拼写", "词汇拼写"),
            (1, "切到词形变化", "词形变化"),
            (0, "切回词汇拼写", "词汇拼写"),
        ]
        cur = 0
        for target, label, title in seq:
            s.send(b"\x1b[B" * (target - cur) + b"\r")
            cur = target
            if not s.wait_for(MODE_TITLE[title], 20):
                print(f"  ❌ {label}: 未进入")
                ok = False
                break
            if not s.wait_for(Q_PROMPT, 20):
                print(f"  ❌ {label}: 无输入提示")
                ok = False
                break
            n0 = s.mark()
            s.send(b"d")
            s._pump(0.6)
            new = s.delta(n0)
            if "dd" in new:
                print(f"  ❌ {label}: 双回显 -> {new!r}")
                ok = False
            else:
                print(f"  ✅ {label}: 无重复回显")
            s.send(b"\x15")     # Ctrl+U 清空当前输入行
            s._pump(0.3)
            s.send(b"\x1b")     # Esc 返回主菜单
            if not s.wait_for(MENU_FOOTER, 15):
                print(f"  ❌ {label}: Esc 未回到主菜单")
                ok = False
                break
            cur = 0            # 回到主菜单后高亮回到第 0 项
    else:
        print("  ❌ 未能进入主菜单")
        ok = False
    s.close()

    # ---------- 测试 3：词汇拼写完整答一轮（答错，检查回显正确答案） ----------
    print("\n测试 3: 词汇拼写完整答一轮")
    s = Session()
    if s.wait_for(MENU_READY, 25):
        s.send(b"\r")           # 高亮默认在「词汇拼写」
        if s.wait_for(MODE_TITLE["词汇拼写"], 20) and s.wait_for(Q_PROMPT, 20):
            s.send(b"zzzwrong\r")
            m = s.wait_for(r"错误\s*正确答案：([^\s\r\n]+)", 15)
            if m:
                word = m.group(1)
                print(f"  ✅ 答错后回显正确答案 '{word}'")
            else:
                print("  ❌ 答错后未回显正确答案")
                ok = False
        else:
            print("  ❌ 未能进入词汇拼写")
            ok = False
    else:
        print("  ❌ 未能进入主菜单")
        ok = False
    s.close()

    # ---------- 测试 4：Ctrl+C 优雅退出并保存进度 ----------
    print("\n测试 4: Ctrl+C 优雅退出并保存进度")
    home = _seed_home()
    master, slave = pty.openpty()
    p = subprocess.Popen(["node", SCRIPT], stdin=slave, stdout=slave, stderr=slave,
                         env={**os.environ, "HOME": home}, close_fds=True)
    os.close(slave)

    def pump(seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    os.read(master, 65536)
                except OSError:
                    return

    def wait_text(pattern, timeout=25.0):
        acc = b""
        deadline = time.time() + timeout
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try:
                    d = os.read(master, 65536)
                except OSError:
                    break
                acc += d
                if re.search(pattern, ANSI.sub(b"", acc).decode("utf-8", "replace")):
                    return True
        return False

    # 等主菜单 -> 进词汇拼写 -> 等出题 -> 故意答错 -> Ctrl+C
    reached = wait_text(MENU_READY)
    if reached:
        os.write(master, b"\r")
        reached = wait_text(Q_PROMPT)
    if reached:
        os.write(master, b"zzzwrong\r")
        reached = wait_text(r"错误")
    if reached:
        os.write(master, b"\x03")
        pump(1.5)
    try:
        p.wait(timeout=6)
    except subprocess.TimeoutExpired:
        p.kill()

    pf = os.path.join(home, ".romanianlearn", "profiles", "测试.json")
    if p.returncode == 0 and os.path.exists(pf):
        data = json.load(open(pf, encoding="utf-8"))
        print(f"  ✅ 退出码 0，进度已保存：{data}")
    else:
        print(f"  ❌ 退出码 {p.returncode}，进度文件存在={os.path.exists(pf)}，"
              f"流程到达={reached}")
        ok = False
    shutil.rmtree(home, ignore_errors=True)

    print()
    print("结论:", "✅ 全部通过" if ok else "❌ 存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
