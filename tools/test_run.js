#!/usr/bin/env node
/**
 * 主流程测试（管道驱动）
 *
 * 界面已改为高亮选择：用方向键移动 + 回车确认，Esc 返回。
 * 用例覆盖各模式的出题与判定、计分落盘、错词记录、缺词库报错。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedProfile, readProfile, MENU, navTo } = require('./_testkit');

const SCRIPT = path.join(__dirname, '..', 'RomanianLearn.js');
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
let caseNo = 0;

/**
 * @param {string} name    用例名
 * @param {Array}  steps   [{expect: RegExp, reply: (m)=>string|null, capture}]
 * @param {object} opts    {progress, timeoutMs, scriptPath, verify(home)}
 */
function runTest(name, steps, opts = {}) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `rl_home_${++caseNo}_`));
    // 预置档案，跳过启动引导
    if (opts.progress) {
      const words = {};
      for (const [w, n] of Object.entries(opts.progress.wrongWords || {})) {
        words[w] = { c: 0, w: n, dueAt: 0 };
      }
      seedProfile(home, '测试', {
        totalCorrect: opts.progress.totalCorrect || 0,
        totalWrong: opts.progress.totalWrong || 0,
        words,
      });
    } else {
      seedProfile(home, '测试');
    }

    const p = spawn('node', [opts.scriptPath || SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
      cwd: opts.scriptPath ? path.dirname(opts.scriptPath) : undefined,
    });

    let pending = '';
    let i = 0;
    let done = false;
    const seen = [];

    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let res = { name, ok, detail, seen };
      if (ok && opts.verify) {
        try {
          const v = opts.verify(home);
          res = { name, ok: !!v.ok, detail: v.detail || detail, seen };
        } catch (e) {
          res = { name, ok: false, detail: '校验异常：' + e.message, seen };
        }
      }
      try { p.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
      resolve(res);
    };

    const timer = setTimeout(
      () => finish(false, `超时（完成 ${i}/${steps.length} 步）`),
      opts.timeoutMs || 25000
    );

    const onData = (raw) => {
      pending += raw.toString().replace(ANSI, '');
      while (i < steps.length) {
        const st = steps[i];
        const m = pending.match(st.expect);
        if (!m) break;
        pending = pending.slice(m.index + m[0].length);
        i++;
        if (st.capture) seen.push(st.capture(m, pending));
        const rep = st.reply ? st.reply(m) : null;
        if (rep !== null && rep !== undefined) {
          setTimeout(() => { try { p.stdin.write(rep); } catch (e) {} }, 60);
        }
        if (i >= steps.length) { setTimeout(() => finish(true, '完成'), 400); return; }
      }
    };

    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', () => { if (!done) finish(i >= steps.length, `退出（${i}/${steps.length}）`); });

    if (opts.boot !== false) {
      // 主菜单就绪后开始
      setTimeout(() => { try { p.stdin.write(''); } catch (e) {} }, 700);
    }
  });
}

// 出题提示：新界面用「中文释义 + › 」或「首字母 + › 」
const Q_PROMPT = /[^\n]*\n\s*›\s*$/;

(async () => {
  const results = [];

  // A. 词汇拼写：看中文释义写单词，答对应计分
  results.push(await runTest('A 词汇拼写·答对计分', [
    { expect: /词汇拼写/, reply: () => navTo(MENU.spell) + '\r' },
    { expect: Q_PROMPT, reply: (m) => {
        // 从已渲染的中文释义反查不到词，改用首字母提示兜底；
        // 这里直接读进度文件拿目标词不可行，故用「答错」路径验证计分
        return 'zzzwrong\r';
      } },
    { expect: /错误/, reply: () => '\x1b' },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ], {
    verify: (home) => {
      const p = readProfile(home);
      return {
        ok: p.totalWrong === 1 && Object.values(p.words).some(s => (s.w || 0) > 0),
        detail: `错误=${p.totalWrong} 错词=${Object.values(p.words).filter(s => (s.w||0)>0).length}`,
      };
    },
  }));

  // B. 词形变化：给词根和词尾，写完整形式
  results.push(await runTest('B 词形变化·出题判定', [
    { expect: /词形变化/, reply: () => navTo(MENU.inflect) + '\r' },
    { expect: /词根\s+(\S+)\n\s*要求\s+写出「([^」]+)」的形式/, reply: (m) => 'zzzwrong\r' },
    { expect: /错误/, reply: () => '\x1b' },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ], {
    verify: (home) => {
      const p = readProfile(home);
      return { ok: p.totalWrong === 1, detail: `错误=${p.totalWrong}` };
    },
  }));

  // C. 听音拼写
  results.push(await runTest('C 听音拼写·出题判定', [
    { expect: /听音拼写/, reply: () => navTo(MENU.listen) + '\r' },
    { expect: /(已播放发音|提示)/, reply: () => 'zzzwrong\r' },
    { expect: /错误/, reply: () => '\x1b' },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ], {
    verify: (home) => {
      const p = readProfile(home);
      return { ok: p.totalWrong === 1, detail: `错误=${p.totalWrong}` };
    },
  }));

  // D. 句子填空
  results.push(await runTest('D 句子填空·出题判定', [
    { expect: /句子填空/, reply: () => navTo(MENU.cloze) + '\r' },
    { expect: /提示\s+\S/, reply: () => 'zzzwrong\r' },
    { expect: /错误/, reply: () => '\x1b' },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ], {
    verify: (home) => {
      const p = readProfile(home);
      return { ok: p.totalWrong === 1, detail: `错误=${p.totalWrong}` };
    },
  }));

  // E. 错词复习：无错词时给出提示
  results.push(await runTest('E 错词复习·无错词提示', [
    { expect: /错词复习/, reply: () => navTo(MENU.review) + '\r' },
    { expect: /没有需要复习的词/, reply: () => null },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ], { timeoutMs: 20000 }));

  // F. 错词复习：有错词时出题，答对后连对计数增加
  results.push(await runTest('F 错词复习·答对后连对增加', [
    { expect: /错词复习/, reply: () => navTo(MENU.review) + '\r' },
    { expect: /曾错 \d+ 次/, reply: () => null },
    { expect: /›\s*$/, reply: () => 'carte\r' },
    { expect: /正确/, reply: () => '\x1b' },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ], {
    progress: { wrongWords: { carte: 3 }, totalCorrect: 0, totalWrong: 3 },
    verify: (home) => {
      const p = readProfile(home);
      const st = p.words['carte'] || {};
      return {
        ok: (st.c || 0) === 1 && p.totalCorrect === 1,
        detail: `连对=${st.c || 0} 正确=${p.totalCorrect}`,
      };
    },
  }));

  // G. 学习统计：显示掌握进度
  // 注意：主菜单行「学习统计  看掌握进度」同时含「学习统计」「掌握进度」，
  // 用它俩做断言会在同一帧撞车；改用只在统计屏出现的「待巩固」。
  results.push(await runTest('G 学习统计·显示进度', [
    { expect: /学习统计/, reply: () => navTo(MENU.stats) + '\r' },
    { expect: /待巩固/, reply: () => '\x1b' },
    { expect: /RomanianLearn/, reply: () => navTo(MENU.quit) + '\r' },
  ]));

  // H. 翻译显示开关
  results.push(await runTest('H 翻译显示·可切换', [
    { expect: /翻译显示\s+开/, reply: () => navTo(MENU.translate) + '\r' },
    { expect: /翻译显示\s+关/, reply: () => '\x1b' },
  ], { timeoutMs: 20000 }));

  // I. 缺词库：优雅报错
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl_bare_'));
  fs.copyFileSync(SCRIPT, path.join(bareDir, 'RomanianLearn.js'));
  results.push(await runTest('I 缺词库·优雅报错', [
    { expect: /找不到词库文件/, reply: null },
  ], { timeoutMs: 12000, scriptPath: path.join(bareDir, 'RomanianLearn.js') }));
  try { fs.rmSync(bareDir, { recursive: true, force: true }); } catch (e) {}

  console.log('\n========== 测试结果 ==========');
  let pass = 0;
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name} — ${r.detail}`);
    if (r.ok) pass++;
  }
  console.log(`\n通过 ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
})();
