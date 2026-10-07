#!/usr/bin/env node
/**
 * 翻译显示测试
 *
 * 1. 翻译表完整性：词库中的词有多少有翻译
 * 2. 端到端：答对后应显示「📖 中文：… ｜ 英文：…」
 * 3. 开关：主菜单按 t 可关闭翻译显示
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'RomanianLearn.js');
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ---------- 1. 翻译表完整性 ----------
console.log('翻译表完整性:');
function readWords(p) {
  return fs.readFileSync(p, 'utf-8').split('\n')
    .map(l => l.split('\t')[0].trim()).filter(Boolean);
}
const words = readWords(path.join(ROOT, 'data', 'words.tsv'));
const lemmas = readWords(path.join(ROOT, 'data', 'lemmas.tsv'));
const trFile = path.join(ROOT, 'data', 'translations.tsv');
const tr = new Map();
for (const line of fs.readFileSync(trFile, 'utf-8').split('\n')) {
  if (!line.trim()) continue;
  const p = line.split('\t');
  if (p.length >= 2) tr.set(p[0].trim().toLowerCase(), { zh: (p[1] || '').trim(), en: (p[2] || '').trim() });
}

const uniq = [...new Set([...words, ...lemmas])];
const withZh = uniq.filter(w => tr.get(w.toLowerCase())?.zh).length;
const withEn = uniq.filter(w => tr.get(w.toLowerCase())?.en).length;
const withBoth = uniq.filter(w => {
  const t = tr.get(w.toLowerCase());
  return t && t.zh && t.en;
}).length;

console.log(`  唯一词数: ${uniq.length}`);
console.log(`  有中文: ${withZh} (${(withZh / uniq.length * 100).toFixed(1)}%)`);
console.log(`  有英文: ${withEn} (${(withEn / uniq.length * 100).toFixed(1)}%)`);
console.log(`  中英俱全: ${withBoth} (${(withBoth / uniq.length * 100).toFixed(1)}%)`);
check('中英俱全覆盖率 ≥ 99%', withBoth / uniq.length >= 0.99,
      `${(withBoth / uniq.length * 100).toFixed(1)}%`);

// 高频虚词必须人工校正正确
console.log('\n高频虚词校正:');
const mustFix = {
  'mai': { zh: /更|还/, en: /more|still/ },
  'se': { zh: /反身/, en: /reflexive/i },
  'al': { zh: /所有格|冠词/, en: /possessive|article/i },
  'este': { zh: /是/, en: /\bis\b/ },
  'de': { zh: /的/, en: /of/ },
  'și': { zh: /和/, en: /and/ },
};
for (const [w, want] of Object.entries(mustFix)) {
  const t = tr.get(w);
  const okZh = t && want.zh.test(t.zh);
  const okEn = t && want.en.test(t.en);
  check(`'${w}' 翻译正确`, okZh && okEn,
        t ? `得到 zh=${t.zh} en=${t.en}` : '无条目');
}

// ---------- 2. 端到端：答对后显示翻译 ----------
console.log('\n端到端: 答对后显示翻译');

function runOnce(modeKey, extra = []) {
  return new Promise((resolve) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rl_tr_'));
    const p = spawn('node', [SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home },
    });
    let pending = '';
    let done = false;
    const out = { translationSeen: null, answered: false, toggleSeen: false };

    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { p.kill('SIGKILL'); } catch (e) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (e) {}
      resolve(out);
    };
    const timer = setTimeout(finish, 30000);

    const onData = (raw) => {
      pending += raw.toString().replace(ANSI, '');

      for (const cmd of extra) {
        if (!out.toggleSeen && /请选择/.test(pending) && cmd.when === 'menu') {
          out.toggleSeen = true;
          pending = pending.slice(pending.indexOf('请选择') + 3);
          setTimeout(() => { try { p.stdin.write(cmd.send + '\n'); } catch (e) {} }, 50);
          return;
        }
      }

      const q = pending.match(/🎯\s+([^\s—\r\n]+)\s*\r?\n\s*✏️\s*>\s*$/);
      if (q) {
        const w = q[1];
        pending = pending.slice(q.index + q[0].length);
        out.answered = true;
        setTimeout(() => { try { p.stdin.write(w + '\n'); } catch (e) {} }, 40);
        return;
      }

      const trMatch = pending.match(/📖\s*中文：([^\s｜]+)\s*｜\s*英文：([^\r\n]+)/);
      if (trMatch) {
        out.translationSeen = { zh: trMatch[1].trim(), en: trMatch[2].trim() };
        finish();
      }
    };

    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', finish);

    setTimeout(() => { try { p.stdin.write(modeKey + '\n'); } catch (e) {} }, 700);
  });
}

(async () => {
  const r1 = await runOnce('1');
  check('频率射击答对后显示翻译', !!r1.translationSeen,
        r1.translationSeen ? `zh=${r1.translationSeen.zh} en=${r1.translationSeen.en}` : '未见翻译行');

  // 关闭翻译后不应再显示
  const r2 = await runOnce('1', [{ when: 'menu', send: 't' }]);
  check('按 t 关闭后不再显示翻译', r2.toggleSeen && !r2.translationSeen,
        `toggleSeen=${r2.toggleSeen} translationSeen=${!!r2.translationSeen}`);

  console.log(`\n通过 ${pass}，失败 ${fail}`);
  process.exit(fail === 0 ? 0 : 1);
})();
