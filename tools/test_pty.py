#!/usr/bin/env python3
"""真实 pty 下的交互测试：按键回显 + 模式切换 + 完整回合 + Ctrl+C 退出。

为什么必须用 pty：
  stdin 不是 tty 时 readline 不做回显，管道测不出"按一次键出两个字母"这类 bug。

为什么必须等内容而不是死等时间：
  不同机器启动速度不同（oracle 明显比本地慢），固定 sleep 会导致假失败。
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


class Session:
    def __init__(self):
        self.master, slave = pty.openpty()
        self.p = subprocess.Popen(
            ["node", SCRIPT], stdin=slave, stdout=slave, stderr=slave,
            close_fds=True,
        )
        os.close(slave)
        self.buf = b""
        self.cursor = 0      # 已消费到的位置：只在新输出里找目标，避免匹配到旧内容

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
        """在 cursor 之后的新输出里等 pattern；命中则把 cursor 推到匹配末尾。"""
        if isinstance(pattern, str):
            pattern = re.compile(pattern)
        deadline = time.time() + timeout
        while True:
            text = ANSI.sub(b"", self.buf[self.cursor:]).decode("utf-8", "replace")
            m = pattern.search(text)
            if m:
                # 把 cursor 推进到匹配结束（按纯文本长度估算，保守取整段）
                self.cursor = len(self.buf)
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
    print("测试 1: 各玩法模式首次进入的回显")
    for mode, name, prompt in [("1", "频率射击", r"✏️\s*>\s*$"),
                               ("2", "语法变体", r"完整形式\s*>\s*$"),
                               ("3", "听音识词", r"单词\s*>\s*$"),
                               ("4", "句子拼装", r"单词\s*>\s*$")]:
        s = Session()
        s.send(mode.encode() + b"\n")
        if not s.wait_for(prompt, 20):
            print(f"  ❌ {name}: 未出现输入提示（可能启动失败）")
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
    if s.wait_for(r"请选择", 20):
        for mode, name, prompt in [("1", "第1次进频率射击", r"✏️\s*>\s*$"),
                                   ("2", "切到语法变体", r"完整形式\s*>\s*$"),
                                   ("1", "切回频率射击", r"✏️\s*>\s*$")]:
            s.send(mode.encode() + b"\n")
            if not s.wait_for(prompt, 20):
                print(f"  ❌ {name}: 未出现输入提示")
                ok = False
                break
            n0 = s.mark()
            s.send(b"d")
            s._pump(0.6)
            new = s.delta(n0)
            if "dd" in new:
                print(f"  ❌ {name}: 双回显 -> {new!r}")
                ok = False
            else:
                print(f"  ✅ {name}: 无重复回显")
            s.send(b"\x15")     # Ctrl+U 清空当前输入行
            s._pump(0.3)
            s.send(b"q\n")
            s.wait_for(r"请选择", 15)
    else:
        print("  ❌ 未能进入主菜单")
        ok = False
    s.close()

    # ---------- 测试 3：频率射击完整答一轮 ----------
    print("\n测试 3: 频率射击完整答一轮")
    s = Session()
    if s.wait_for(r"请选择", 20):
        s.send(b"1\n")
        # 目标词行形如 "  🎯 cinci"，标题行含破折号需排除
        m = s.wait_for(r"🎯\s+([^\s—\r\n]+)\s*\r?\n", 20)
        if m:
            word = m.group(1)
            s.send(word.encode() + b"\n")
            if s.wait_for(r"正确", 15):
                print(f"  ✅ 答对 '{word}' 判定正确")
            else:
                print(f"  ❌ 答 '{word}' 未判定为正确")
                ok = False
        else:
            print("  ❌ 未能取到目标词")
            ok = False
    else:
        print("  ❌ 未能进入主菜单")
        ok = False
    s.close()

    # ---------- 测试 4：Ctrl+C 优雅退出并保存进度 ----------
    print("\n测试 4: Ctrl+C 优雅退出并保存进度")
    home = tempfile.mkdtemp(prefix="rl_ctrlc_")
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

    def wait_text(pattern, timeout=20.0):
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

    # 等主菜单 -> 进模式 1 -> 等出题 -> 故意答错 -> Ctrl+C
    reached = wait_text(r"请选择")
    if reached:
        os.write(master, b"1\n")
        reached = wait_text(r"✏️\s*>\s*$")
    if reached:
        os.write(master, b"zzzwrong\n")
        reached = wait_text(r"错误")
    if reached:
        os.write(master, b"\x03")
        pump(1.5)
    try:
        p.wait(timeout=6)
    except subprocess.TimeoutExpired:
        p.kill()

    pf = os.path.join(home, ".romanianlearn", "progress.json")
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
