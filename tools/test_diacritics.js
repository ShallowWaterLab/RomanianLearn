#!/usr/bin/env node
/**
 * 变音符号容错测试
 *
 * 1. 单元测试：折叠函数对各种输入的行为
 * 2. 端到端：驱动真实游戏，出到含变音符的词时输入无符号形式，
 *    断言判对、且正确拼写被回显
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'RomanianLearn.js');
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const DIAC = /[ăâîșț]/;
const { seedProfile } = require('./_testkit');

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ---------- 1. 单元测试 ----------
const { foldDiacritics, sameFolded, hasDiacritics } = require(SCRIPT);

console.log('单元测试：折叠函数');
check("'său' -> 'sau'", foldDiacritics('său') === 'sau', foldDiacritics('său'));
check("'în' -> 'in'", foldDiacritics('în') === 'in', foldDiacritics('în'));
check("'țară' -> 'tara'", foldDiacritics('țară') === 'tara', foldDiacritics('țară'));
check("'București' -> 'bucuresti'", foldDiacritics('București') === 'bucuresti',
      foldDiacritics('București'));
check("'â' -> 'a'（罗语 â 与 a 同归）", foldDiacritics('â') === 'a', foldDiacritics('â'));
check("'î' -> 'i'（罗语 î 与 i 同归）", foldDiacritics('î') === 'i', foldDiacritics('î'));
check("无变音符原样保留", foldDiacritics('carte') === 'carte', foldDiacritics('carte'));
check("大小写不敏感", foldDiacritics('ȘI') === 'si', foldDiacritics('ȘI'));

console.log('\n单元测试：等价判定');
check("'sau' ≡ 'său'", sameFolded('sau', 'său'));
check("'in' ≡ 'în'", sameFolded('in', 'în'));
check("'carte' ≢ 'parte'", !sameFolded('carte', 'parte'));
check("'tara' ≡ 'țară'", sameFolded('tara', 'țară'));

console.log('\n单元测试：含变音符检测');
check("'său' 含变音符", hasDiacritics('său'));
check("'carte' 不含变音符", !hasDiacritics('carte'));

// ---------- 2. 端到端 ----------
console.log('\n端到端测试：无符号输入应判对并回显正确拼写');

function run() {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl_fold_'));
    seedProfile(home, '测试');
    const p = spawn('node', [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
    });

    let pending = '';
    let hits = 0, tried = 0, echoed = 0, missing = 0;
    let done = false;

    const finish = (outcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
      resolve({ hits, tried, echoed, missing, outcome });
    };

    const timer = setTimeout(() => finish('超时'), 60000);

    const onData = (raw) => {
      pending += raw.toString().replace(ANSI, '');

      // 出题：形如 "  🎯 cuvânt\n  ✏️  > "
      const q = pending.match(/🎯\s+([^\s—\r\n]+)\s*\r?\n\s*✏️\s*>\s*$/);
      if (q) {
        const word = q[1];
        pending = pending.slice(q.index + q[0].length);
        tried++;
        if (DIAC.test(word)) {
          hits++;
          // 关键：输入去掉变音符号的形式
          const folded = foldDiacritics(word);
          setTimeout(() => { try { p.stdin.write(folded + '\n'); } catch (e) {} }, 40);
        } else {
          setTimeout(() => { try { p.stdin.write(word + '\n'); } catch (e) {} }, 40);
        }
        return;
      }

      // 判定结果
      const okNoDia = pending.match(/✅ 正确！（无符号输入）正确拼写：([^\r\n]+)/);
      if (okNoDia) {
        pending = pending.slice(okNoDia.index + okNoDia[0].length);
        if (okNoDia[1].trim()) echoed++;
        else missing++;
        if (hits >= 5) finish('完成');
        return;
      }
      // 无符号输入若被判错，说明折叠失效
      if (/❌ 错误/.test(pending) && hits > 0) {
        pending = pending.slice(pending.indexOf('❌ 错误') + 4);
        missing++;
        if (hits >= 5) finish('完成');
      }
    };

    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', () => finish('进程退出'));

    setTimeout(() => { try { p.stdin.write('1\n'); } catch (e) {} }, 700);
  });
}

(async () => {
  const r = await run();
  console.log(`  出题 ${r.tried} 次，命中含变音符词 ${r.hits} 次（${r.outcome}）`);
  check('无符号输入被判对', r.hits >= 3 && r.missing === 0,
        `hits=${r.hits} missing=${r.missing}`);
  check('答对后回显正确拼写', r.echoed >= Math.max(1, r.hits - 1),
        `echoed=${r.echoed}/${r.hits}`);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
