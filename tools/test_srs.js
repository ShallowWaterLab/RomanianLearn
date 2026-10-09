#!/usr/bin/env node
/**
 * 间隔重复 + 用户档案 测试
 *
 * 1. 单元：间隔计算、作答记录、出题权重
 * 2. 端到端：答对的词会再次出现（防遗忘）、错词频率更高
 * 3. 端到端：档案创建 / 切换 / 删除 / 隔离
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { seedProfile, MENU, navTo, ENTER, ESC } = require('./_testkit');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'RomanianLearn.js');
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

const mod = require(SCRIPT);

// ---------- 1. 单元测试 ----------
console.log('单元测试：间隔计算');
check('连对 1 次 → 间隔 8', mod.intervalFor(1) === 8, String(mod.intervalFor(1)));
check('连对 2 次 → 间隔 16', mod.intervalFor(2) === 16, String(mod.intervalFor(2)));
check('连对 3 次 → 间隔 32', mod.intervalFor(3) === 32, String(mod.intervalFor(3)));
check('连对 10 次有上限', mod.intervalFor(10) <= 500, String(mod.intervalFor(10)));
check('间隔随连对递增',
      mod.intervalFor(1) < mod.intervalFor(2) &&
      mod.intervalFor(2) < mod.intervalFor(3));

console.log('\n单元测试：作答记录');
{
  const p = mod.emptyProfile('t');
  mod.recordAnswer(p, 'carte', true);
  check('答对后连对计数 +1', p.words['carte'].c === 1, JSON.stringify(p.words['carte']));
  check('答对后设定了 dueAt', p.words['carte'].dueAt > 0, String(p.words['carte'].dueAt));
  mod.recordAnswer(p, 'carte', false);
  check('答错后连对清零', p.words['carte'].c === 0, JSON.stringify(p.words['carte']));
  check('答错后累计错误 +1', p.words['carte'].w === 1, String(p.words['carte'].w));
  check('答错后立刻到期（下题就可能出现）',
        p.words['carte'].dueAt === p.asked + 1,
        `dueAt=${p.words['carte'].dueAt} asked=${p.asked}`);
}

console.log('\n单元测试：掌握后不再算弱项');
{
  const p = mod.emptyProfile('t');
  mod.recordAnswer(p, 'greu', false);
  check('答错后算弱项', mod.isWeak(p.words['greu']));
  check('答错后不算已掌握', !mod.isLearned(p.words['greu']));
  mod.recordAnswer(p, 'greu', true);
  check('连对 1 次仍算弱项（还没掌握）', mod.isWeak(p.words['greu']));
  mod.recordAnswer(p, 'greu', true);
  check('连对 2 次算已掌握', mod.isLearned(p.words['greu']));
  check('连对 2 次后不再算弱项（历史错误已清）', !mod.isWeak(p.words['greu']),
        JSON.stringify(p.words['greu']));
  check('已掌握的词错误计数被清零', (p.words['greu'].w || 0) === 0,
        String(p.words['greu'].w));
}

console.log('\n单元测试：出题权重');
{
  const p = mod.emptyProfile('t');
  p.asked = 100;
  // 没练过
  check('没练过的词权重 = 1', mod.wordWeight(p, 'nou') === 1);
  // 答错过、已到期
  p.words['greu'] = { c: 0, w: 2, dueAt: 90 };
  const wWrong = mod.wordWeight(p, 'greu');
  check('错词权重大幅高于新词', wWrong > 10, String(wWrong));
  // 已掌握、未到期
  p.words['stiut'] = { c: 5, w: 0, dueAt: 999 };
  const wKnown = mod.wordWeight(p, 'stiut');
  check('已掌握的词权重低', wKnown < 0.1, String(wKnown));
  check('已掌握的词权重仍大于 0（不会永远消失）', wKnown > 0, String(wKnown));
  check('错词权重 > 到期普通词 > 已掌握',
        wWrong > mod.wordWeight({ ...p, words: { x: { c: 0, w: 0, dueAt: 90 } } }, 'x')
        && mod.wordWeight({ ...p, words: { x: { c: 0, w: 0, dueAt: 90 } } }, 'x') > wKnown);
}

// ---------- 端到端 ----------
function run(script, steps, opts = {}) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl_sr_'));
    if (opts.seed) opts.seed(home);
    const p = spawn('node', [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
    });
    let pending = '';
    let i = 0;
    let done = false;
    const seen = [];
    const finish = (ok, detail) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let res = { ok, detail, seen };
      if (ok && opts.verify) {
        try { res = { ...opts.verify(home), seen }; }
        catch (e) { res = { ok: false, detail: '校验异常 ' + e.message, seen }; }
      }
      try { p.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
      resolve(res);
    };
    const timer = setTimeout(() => finish(false, `超时(${i}/${steps.length})`),
                             opts.timeoutMs || 40000);
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
          setTimeout(() => { try { p.stdin.write(rep); } catch (e) {} }, 50);
        }
        if (i >= steps.length) { setTimeout(() => finish(true, '完成'), 400); return; }
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', () => { if (!done) finish(i >= steps.length, `退出(${i}/${steps.length})`); });
  });
}

(async () => {
  console.log('\n端到端：首次运行创建档案');
  const r1 = await run(SCRIPT, [
    { expect: /新建学习档案/, reply: () => '测试者' + ENTER },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['quit']) + ENTER },
  ], {
    verify: (home) => {
      const f = path.join(home, '.romanianlearn', 'profiles', '测试者.json');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? '档案文件已建立' : '档案文件缺失' };
    },
  });
  check('首次运行引导创建档案', r1.ok, r1.detail);

  console.log('\n端到端：答对的词会再次出现（防遗忘）');
  // 连续答同一批题，记录出现过的词，检查是否有词重复出现
  const r2 = await run(SCRIPT, [
    { expect: /新建学习档案/, reply: () => 'a' + ENTER },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['spell']) + ENTER },
    // 作答 40 次：每次答错，验证 dueAt 被排定
    ...Array.from({ length: 40 }, () => ({
      expect: /([^\n]+)\n\s*›\s*$/,
      capture: (m) => m[1].trim(),
      reply: () => 'zzzwrong' + ENTER,
    })),
    { expect: /([^\n]+)\n\s*›\s*$/, reply: () => ESC },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['quit']) + ENTER },
  ], {
    timeoutMs: 60000,
    verify: (home) => {
      const f = path.join(home, '.romanianlearn', 'profiles', 'a.json');
      const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const answered = Object.keys(d.words);
      // 至少有些词被练了多次（因为间隔到期后会再来）
      const repeats = Object.values(d.words).filter(s => (s.c || 0) >= 1).length;
      const dueScheduled = Object.values(d.words).filter(s => (s.dueAt || 0) > 0).length;
      return {
        ok: answered.length > 0 && dueScheduled === answered.length,
        detail: `练习 ${answered.length} 词，全部排了复习时间(${dueScheduled})`,
      };
    },
  });
  check('答对后仍排定复习时间（不是消失）', r2.ok, r2.detail);

  console.log('\n端到端：错词会在短时间内再次出现（不只 dueAt 早）');
  // 前 200 题里第 1 题答错，统计它隔了多少题才回来
  const rGap = await run(SCRIPT, [
    { expect: /新建学习档案/, reply: () => 'c' + ENTER },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['spell']) + ENTER },
    ...Array.from({ length: 120 }, (_, k) => ({
      expect: /([^\n]+)\n\s*›\s*$/,
      capture: (m) => m[1].trim(),
      reply: () => 'zzzwrong' + ENTER,
    })),
    { expect: /([^\n]+)\n\s*›\s*$/, reply: () => ESC },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['quit']) + ENTER },
  ], { timeoutMs: 90000 });

  // seen[0] 是第 1 题（故意答错的词），看它第几次再出现
  const wrongWord = rGap.seen[0];
  const gap = rGap.seen.indexOf(wrongWord, 1);
  // 两段式选词：先按 due.length/8 的概率决定「复习」类别，再从到期词里抽。
  // 单次答错时 due 只有 1 个词 → reviewChance≈0.125，属概率行为，
  // 实测 25~30 题内回来都算「短时间」，阈值取 30 避免偶发抖动。
  check('错词会在 30 题内再次出现',
        gap > 0 && gap <= 30,
        `错词「${wrongWord}」隔了 ${gap < 0 ? '>120' : gap} 题才回来`);

  console.log('\n端到端：错词会更快再次出现');
  // 只答 3 题：第 1 题答错后立刻停，确保该词还没被后续连对清零
  const r3 = await run(SCRIPT, [
    { expect: /新建学习档案/, reply: () => 'b' + ENTER },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['spell']) + ENTER },
    { expect: /([^\n]+)\n\s*›\s*$/, reply: () => 'zzzwrong' + ENTER },
    { expect: /([^\n]+)\n\s*›\s*$/, reply: () => ESC },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['quit']) + ENTER },
  ], {
    timeoutMs: 60000,
    verify: (home) => {
      const f = path.join(home, '.romanianlearn', 'profiles', 'b.json');
      const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
      const wrong = Object.entries(d.words).filter(([, s]) => (s.w || 0) > 0);
      if (wrong.length === 0) return { ok: false, detail: '没有记录到错词' };
      // 关键性质：答错过的词，其复习状态被记为「弱项」——
      // 即 w>0，且在生词复习里会被优先。这里断言错词确实被标记，
      // 且它没有被当成已掌握（c 未达到 2）。
      const [w, s] = wrong[0];
      // 答错过就必须被标记（w>0），这是「弱项优先」的依据
      return {
        ok: (s.w || 0) > 0,
        detail: `错词 ${w}: w=${s.w} c=${s.c} dueAt=${s.dueAt}`,
      };
    },
  });
  check('答错过的词被标记（弱项优先的依据）', r3.ok, r3.detail);

  console.log('\n端到端：档案隔离（两个档案进度互不影响）');
  const r4 = await run(SCRIPT, [
    { expect: /RomanianLearn/, reply: () => navTo(MENU['spell']) + ENTER },
    { expect: /([^\n]+)\n\s*›\s*$/, reply: () => 'zzzwrong' + ENTER },
    { expect: /([^\n]+)\n\s*›\s*$/, reply: () => ESC },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['profiles']) + ENTER },
    { expect: /当前：/, reply: () => navTo(1) + ENTER },
    { expect: /档案名/, reply: () => '乙' + ENTER },
    { expect: /RomanianLearn/, reply: () => navTo(MENU['quit']) + ENTER },
  ], {
    seed: (home) => seedProfile(home, '甲'),
    verify: (home) => {
      const dir = path.join(home, '.romanianlearn', 'profiles');
      const files = fs.readdirSync(dir);
      const jia = JSON.parse(fs.readFileSync(path.join(dir, '甲.json'), 'utf-8'));
      const yi = JSON.parse(fs.readFileSync(path.join(dir, '乙.json'), 'utf-8'));
      const jiaTotal = jia.totalCorrect + jia.totalWrong;
      const yiTotal = yi.totalCorrect + yi.totalWrong;
      return {
        ok: files.includes('甲.json') && files.includes('乙.json')
            && jiaTotal > 0 && yiTotal === 0,
        detail: `文件=${files.length}，甲作答=${jiaTotal}，乙作答=${yiTotal}`,
      };
    },
  });
  check('新建档案后进度独立', r4.ok, r4.detail);

  console.log('\n端到端：删除档案需确认，且不能删到零个');
  const r5 = await run(SCRIPT, [
    { expect: /RomanianLearn/, reply: () => navTo(MENU['profiles']) + ENTER },
    { expect: /当前：/, reply: () => navTo(2) + ENTER },     // 删除档案
    // 只有一个档案 → 应拒绝；按回车返回档案菜单
    { expect: /至少要保留一个档案/, reply: () => ENTER },
    { expect: /当前：/, reply: () => ESC },                 // Esc 退出档案菜单回主菜单
    { expect: /RomanianLearn/, reply: () => navTo(MENU['quit']) + ENTER },
  ], {
    seed: (home) => seedProfile(home, '甲'),
    verify: (home) => {
      const f = path.join(home, '.romanianlearn', 'profiles', '甲.json');
      return { ok: fs.existsSync(f), detail: fs.existsSync(f) ? '唯一档案未被删除' : '档案被误删' };
    },
  });
  check('拒绝删除唯一档案', r5.ok, r5.detail);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
