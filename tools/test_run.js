#!/usr/bin/env node
/**
 * RomanianLearn 自动测试驱动
 * 每个用例用独立 HOME 目录启动游戏，读屏后自动应答，验证流程、计分与落盘。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'RomanianLearn.js');
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
let caseNo = 0;

/**
 * @param {string} name     用例名
 * @param {string} modeKey  主菜单选项（'1'..'5'，null 表示不选）
 * @param {Array}  steps    [{expect: RegExp, reply?: (m)=>string|null}]
 * @param {object} opts     {progress, timeoutMs, scriptPath, verify(home)}
 */
function runTest(name, modeKey, steps, opts = {}) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), `rl_home_${++caseNo}_`));
    if (opts.progress) {
      const dir = path.join(home, '.romanianlearn');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'progress.json'), JSON.stringify(opts.progress));
    }

    const p = spawn('node', [opts.scriptPath || SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
      cwd: opts.scriptPath ? path.dirname(opts.scriptPath) : undefined,
    });

    let pending = '';
    let stepIdx = 0;
    let done = false;

    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let finalOk = ok;
      let finalDetail = detail;
      if (ok && opts.verify) {
        try {
          const v = opts.verify(home);
          finalOk = !!v.ok;
          finalDetail = v.detail || detail;
        } catch (e) {
          finalOk = false;
          finalDetail = '校验异常：' + e.message;
        }
      }
      try { p.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
      resolve({ name, ok: finalOk, detail: finalDetail });
    };

    const timer = setTimeout(
      () => finish(false, `超时（完成 ${stepIdx}/${steps.length} 步）`),
      opts.timeoutMs || 20000
    );

    const onChunk = (raw) => {
      pending += raw.toString().replace(ANSI, '');
      while (stepIdx < steps.length) {
        const step = steps[stepIdx];
        const m = pending.match(step.expect);
        if (!m) break;
        pending = pending.slice(m.index + m[0].length);
        stepIdx++;
        const reply = step.reply ? step.reply(m) : null;
        if (reply !== null && reply !== undefined) {
          setTimeout(() => { try { p.stdin.write(reply + '\n'); } catch (e) {} }, 50);
        }
        if (stepIdx >= steps.length) {
          setTimeout(() => finish(true, '全部步骤通过'), 400);
          return;
        }
      }
    };

    p.stdout.on('data', onChunk);
    p.stderr.on('data', onChunk);
    p.on('close', () => {
      if (!done) finish(stepIdx >= steps.length, `进程退出（完成 ${stepIdx}/${steps.length} 步）`);
    });

    if (modeKey !== null) {
      setTimeout(() => { try { p.stdin.write(modeKey + '\n'); } catch (e) {} }, 700);
    }
  });
}

function readProgress(home) {
  const f = path.join(home, '.romanianlearn', 'progress.json');
  return JSON.parse(fs.readFileSync(f, 'utf-8'));
}

(async () => {
  const results = [];

  results.push(await runTest('A 频率射击·答对计分', '1', [
    { expect: /🎯 ([^\n]+)\n\s*✏️\s*>/, reply: (m) => m[1].trim() },
    { expect: /✅ 正确/, reply: () => 'q' },
    { expect: /请选择/, reply: () => '0' },
  ], {
    verify: (home) => {
      const p = readProgress(home);
      return {
        ok: p.totalCorrect === 1 && p.totalWrong === 0,
        detail: `落盘正确=${p.totalCorrect} 错误=${p.totalWrong}`,
      };
    },
  }));

  results.push(await runTest('B 频率射击·答错记生词', '1', [
    { expect: /🎯 ([^\n]+)\n\s*✏️\s*>/, reply: () => 'zzzwrong' },
    { expect: /❌ 错误/, reply: () => 'q' },
    { expect: /请选择/, reply: () => '0' },
  ], {
    verify: (home) => {
      const p = readProgress(home);
      return {
        ok: p.totalWrong === 1 && Object.keys(p.wrongWords).length === 1,
        detail: `落盘错误=${p.totalWrong} 生词=${Object.keys(p.wrongWords).length}`,
      };
    },
  }));

  results.push(await runTest('C 语法变体·词尾判定', '2', [
    { expect: /词根：([^\n]+)\n\s*💡 加「([^」]+)」/, reply: (m) => m[1].trim() + m[2].trim() },
    { expect: /✅ 正确/, reply: () => 'q' },
    { expect: /请选择/, reply: () => '0' },
  ]));

  results.push(await runTest('D 句子拼装·出题判定', '4', [
    { expect: /🧩 [^\n]*\n\s*💡 [^\n]*\n\s*✏️[^>]*>/, reply: () => 'zzzwrong' },
    { expect: /❌ 错误/, reply: () => 'q' },
    { expect: /请选择/, reply: () => '0' },
  ]));

  results.push(await runTest('E 听音识词·发音或提示', '3', [
    { expect: /(已播放发音|首字母)/, reply: () => 'q' },
    { expect: /请选择/, reply: () => '0' },
  ]));

  results.push(await runTest('F 生词复习·空本提示', '5', [
    { expect: /生词本是空的/, reply: null },
    { expect: /请选择/, reply: () => '0' },
  ], { timeoutMs: 15000 }));

  results.push(await runTest('G 生词复习·答对移出并落盘', '5', [
    { expect: /📚 carte[^\n]*\n\s*✏️[^>]*>/, reply: () => 'carte' },
    { expect: /已移出生词本/, reply: () => 'q' },
    { expect: /请选择/, reply: () => '0' },
  ], {
    progress: { wrongWords: { carte: 3 }, totalCorrect: 0, totalWrong: 3 },
    verify: (home) => {
      const p = readProgress(home);
      return {
        ok: !('carte' in p.wrongWords) && p.totalCorrect === 1,
        detail: `生词已移除=${!('carte' in p.wrongWords)} 正确=${p.totalCorrect}`,
      };
    },
  }));

  // H: 无词库目录 → 优雅报错退出
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rl_bare_'));
  fs.copyFileSync(SCRIPT, path.join(bareDir, 'RomanianLearn.js'));
  results.push(await runTest('H 缺词库·优雅报错', null, [
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
