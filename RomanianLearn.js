#!/usr/bin/env node
/**
 * RomanianLearn — 罗马尼亚语学习工具
 * 单文件 Node 脚本，一条命令跑
 *
 * 玩法模块：
 *   1. 频率射击 — 常见词快速浮出，输入消除
 *   2. 语法变体 — 同一词不同词尾形态
 *   3. 听音识词 — 播放发音，玩家拼写
 *   4. 句子拼装 — 补全句子
 *   5. 生词复习 — 只刷之前打错的词
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

// ============ 配置 ============
const SCRIPT_DIR = __dirname;

// 词库查找顺序：先内置精简词库，再回退到完整 CoRoLa 文件
const WORD_CANDIDATES = [
  path.join(SCRIPT_DIR, 'data', 'words.tsv'),
  path.join(SCRIPT_DIR, 'corola_word_freq_gte10.tsv'),
];
const LEMMA_CANDIDATES = [
  path.join(SCRIPT_DIR, 'data', 'lemmas.tsv'),
  path.join(SCRIPT_DIR, 'corola_lemma_freq_gte10.tsv'),
];
// 翻译表（构建时预生成，离线可用）
const TRANSLATION_CANDIDATES = [
  path.join(SCRIPT_DIR, 'data', 'translations.tsv'),
];

// 进度写到用户目录，避免安装目录只读
const PROGRESS_DIR = path.join(os.homedir(), '.romanianlearn');
const PROGRESS_FILE = path.join(PROGRESS_DIR, 'progress.json');

const MIN_WORD_LEN = 2;
const MAX_WORD_LEN = 24;
const WORD_LIMIT = 50000;

// ============ 词库加载 ============
function pickExisting(candidates) {
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function loadFreqTable(filePath, keyName, limit = WORD_LIMIT) {
  const items = [];
  const seen = new Set();
  const content = fs.readFileSync(filePath, 'utf-8');
  for (const line of content.split('\n')) {
    const parts = line.trim().split('\t');
    if (parts.length < 2) continue;
    const word = parts[0].trim();
    const freq = parseInt(parts[1], 10);
    if (!word || !Number.isFinite(freq) || freq <= 0) continue;
    if (word.length < MIN_WORD_LEN || word.length > MAX_WORD_LEN) continue;
    const key = word.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const item = {};
    item[keyName] = key;
    item.freq = freq;
    items.push(item);
    if (items.length >= limit) break;
  }
  return items;
}

function loadAll() {
  const wordFile = pickExisting(WORD_CANDIDATES);
  const lemmaFile = pickExisting(LEMMA_CANDIDATES);

  if (!wordFile || !lemmaFile) {
    console.error('\n❌ 找不到词库文件。\n');
    console.error('  脚本会在以下位置查找词库：');
    for (const p of WORD_CANDIDATES) console.error('    ' + p);
    for (const p of LEMMA_CANDIDATES) console.error('    ' + p);
    console.error('\n  如果你是从 GitHub 克隆的仓库，请确认 data/ 目录存在。');
    console.error('  如需自行生成词库，见 README 的「词库数据」一节。\n');
    process.exit(1);
  }

  const words = loadFreqTable(wordFile, 'word');
  const lemmas = loadFreqTable(lemmaFile, 'lemma');
  const translations = loadTranslations();
  return { words, lemmas, translations, wordFile, lemmaFile };
}

// 加载翻译表：word -> { zh, en }
function loadTranslations() {
  const file = pickExisting(TRANSLATION_CANDIDATES);
  const map = new Map();
  if (!file) return map;
  try {
    const content = fs.readFileSync(file, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;
      const word = parts[0].trim();
      const zh = (parts[1] || '').trim();
      const en = (parts[2] || '').trim();
      if (word) map.set(word.toLowerCase(), { zh, en });
    }
  } catch (e) { /* 翻译表缺失不影响游戏 */ }
  return map;
}

// 取一个词的翻译，返回可直接打印的一行（无翻译则返回空串）
function translationLine(word, translations) {
  if (!translations || translations.size === 0) return '';
  const t = translations.get(String(word).toLowerCase());
  if (!t || (!t.zh && !t.en)) return '';
  const bits = [];
  if (t.zh) bits.push(`中文：${t.zh}`);
  if (t.en) bits.push(`英文：${t.en}`);
  return '  📖 ' + bits.join('　｜　');
}

// ============ 进度保存 ============
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
      return {
        wrongWords: data.wrongWords || {},
        totalCorrect: data.totalCorrect || 0,
        totalWrong: data.totalWrong || 0,
      };
    }
  } catch (e) { /* 损坏则重置 */ }
  return { wrongWords: {}, totalCorrect: 0, totalWrong: 0 };
}

function saveProgress(progress) {
  try {
    fs.mkdirSync(PROGRESS_DIR, { recursive: true });
    fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
  } catch (e) {
    // 进度保存失败不应中断游戏
  }
}

// ============ 计分系统 ============
class ScoreTracker {
  constructor() {
    this.correct = 0;
    this.wrong = 0;
    this.streak = 0;
    this.bestStreak = 0;
  }
  hit() {
    this.correct++;
    this.streak++;
    if (this.streak > this.bestStreak) this.bestStreak = this.streak;
  }
  miss() {
    this.wrong++;
    this.streak = 0;
  }
  get accuracy() {
    const total = this.correct + this.wrong;
    return total === 0 ? '—' : (this.correct / total * 100).toFixed(1) + '%';
  }
  line() {
    return `  ✅ ${this.correct}   ❌ ${this.wrong}   🔥 连击 ${this.streak}   📊 准确率 ${this.accuracy}`;
  }
}

// ============ 终端工具 ============
const WIDTH = 52;

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function printHeader(title) {
  console.log('═'.repeat(WIDTH));
  console.log(`  ${title}`);
  console.log('═'.repeat(WIDTH));
}

function randomOf(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 全局唯一的行输入接口。
// 关键：整个进程只能有一个 readline 实例 —— 若主菜单与玩法各建一个，
// 两个实例会同时回显按键，导致按一次键出现两个相同字母。
let _reader = null;
let currentProgress = null;   // 主菜单持有的进度对象，供 SIGINT 时保存
let _gracefulExit = null;     // 由启动段注入的退出处理

function getReader() {
  if (!_reader) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: process.stdin.isTTY,
    });
    // readline 处于 terminal 模式时会自行吞掉 Ctrl+C，
    // 只在 process 上监听 SIGINT 是收不到的，必须同时挂在 rl 上。
    rl.on('SIGINT', () => {
      if (_gracefulExit) _gracefulExit();
    });
    _reader = {
      ask: (q) => new Promise(resolve => rl.question(q, a => resolve((a || '').trim()))),
      close: () => {
        try { rl.close(); } catch (e) { /* 忽略 */ }
        _reader = null;
      },
    };
  }
  return _reader;
}

// ============ 变音符号容错 ============
// 普通键盘打不出 ă â î ș ț，因此比对时把变音符号折叠为基本字母，
// 用户输入无符号形式（a i s t）同样判对。
// 代价：少数词会因此无法区分（sau/său、ca/că），答对后回显正确拼写。
const FOLD_MAP = {
  'ă': 'a', 'â': 'a', 'î': 'i',
  'ș': 's', 'ş': 's',          // 含 cedilla 变体以防外部数据
  'ț': 't', 'ţ': 't',
  'á': 'a', 'à': 'a', 'ã': 'a', 'ä': 'a',
  'é': 'e', 'è': 'e', 'ê': 'e', 'ë': 'e',
  'í': 'i', 'ì': 'i', 'ï': 'i',
  'ó': 'o', 'ò': 'o', 'ô': 'o', 'ö': 'o',
  'ú': 'u', 'ù': 'u', 'û': 'u', 'ü': 'u',
};

function foldDiacritics(s) {
  let out = '';
  for (const ch of s.toLowerCase()) {
    out += FOLD_MAP[ch] !== undefined ? FOLD_MAP[ch] : ch;
  }
  return out;
}

// 折叠后是否等价
function sameFolded(a, b) {
  return foldDiacritics(a) === foldDiacritics(b);
}

// 答案本身是否含变音符号（用于提示用户注意拼写）
function hasDiacritics(s) {
  for (const ch of s.toLowerCase()) {
    if (FOLD_MAP[ch] !== undefined) return true;
  }
  return false;
}

// ============ 通用回合处理 ============
// ctx 可选：带 translations 时，判定后附带中文/英文翻译
function judge(userAnswer, expected, progress, score, shownAnswer, ctx) {
  const exact = userAnswer.toLowerCase() === expected.toLowerCase();
  // 无符号输入也判对（普通键盘友好）
  const ok = exact || sameFolded(userAnswer, expected);

  if (ok) {
    if (exact) {
      console.log('  ✅ 正确！');
    } else {
      // 用户用了无符号写法：判对，但把正确拼写显示出来帮助记忆
      console.log(`  ✅ 正确！（无符号输入）正确拼写：${expected}`);
    }
    score.hit();
    progress.totalCorrect++;
  } else {
    console.log(`  ❌ 错误！正确答案：${shownAnswer || expected}`);
    score.miss();
    progress.totalWrong++;
    progress.wrongWords[expected.toLowerCase()] =
      (progress.wrongWords[expected.toLowerCase()] || 0) + 1;
  }
  // 无论对错都给出翻译，帮助建立词义关联（可在主菜单用 t 开关）
  if (ctx && ctx.translations && ctx.showTranslation !== false) {
    const line = translationLine(expected, ctx.translations);
    if (line) console.log(line);
  }
  console.log(score.line());
  return ok;
}

// ============ 模块 1: 频率射击 ============
async function modeFrequencyShoot(ctx) {
  clearScreen();
  printHeader('🎯 频率射击 — 常见词');
  console.log('  看到单词后输入它，回车确认。输入 q 返回主菜单。');
  console.log('  ℹ️  打不出 ă â î ș ț 时，直接输入 a i s t 也算对。\n');

  const reader = getReader();
  let asked = 0;

  while (true) {
    const item = weightedPick(ctx.words);
    process.stdout.write(`  🎯 ${item.word}\n  ✏️  > `);
    const answer = await reader.ask('');
    asked++;

    if (answer.toLowerCase() === 'q') break;
    judge(answer, item.word, ctx.progress, ctx.score, null, ctx);
    if (asked % 10 === 0) saveProgress(ctx.progress);
    console.log();
  }

  saveProgress(ctx.progress);
}

// 按频次加权抽取（高频词出现概率更高）
function weightedPick(items) {
  if (items.length <= 2000) return randomOf(items);
  // 只在前 2000 高频词里做加权，避免长尾词几乎不出现
  const pool = items.slice(0, 2000);
  const total = pool.reduce((s, it) => s + Math.log(it.freq + 1), 0);
  let r = Math.random() * total;
  for (const it of pool) {
    r -= Math.log(it.freq + 1);
    if (r <= 0) return it;
  }
  return pool[0];
}

// ============ 模块 2: 语法变体 ============
async function modeGrammarVariants(ctx) {
  clearScreen();
  printHeader('📝 语法变体 — 词尾变化');
  console.log('  给词根加上正确的词尾，输入完整形式。输入 q 返回。');
  console.log('  ℹ️  打不出 ă â î ș ț 时，直接输入 a i s t 也算对。\n');

  // 罗语常见词尾变化（简化示意版）
  const variants = [
    { suffix: 'ul', hint: '阳性单数·定冠词' },
    { suffix: 'ului', hint: '阳性单数·属格/与格' },
    { suffix: 'a', hint: '阴性单数·定冠词' },
    { suffix: 'i', hint: '复数' },
    { suffix: 'le', hint: '阴性复数·定冠词' },
  ];

  const reader = getReader();
  let asked = 0;

  while (true) {
    const lemma = randomOf(ctx.lemmas).lemma;
    const v = randomOf(variants);
    const expected = lemma + v.suffix;

    console.log(`  📝 词根：${lemma}`);
    console.log(`  💡 加「${v.suffix}」（${v.hint}）`);
    process.stdout.write('  ✏️  完整形式 > ');
    const answer = await reader.ask('');

    asked++;
    if (answer.toLowerCase() === 'q') break;
    judge(answer, expected, ctx.progress, ctx.score, expected, ctx);
    if (asked % 10 === 0) saveProgress(ctx.progress);
    console.log();
  }

  saveProgress(ctx.progress);
}

// ============ 模块 3: 听音识词 ============
async function modeListenSpell(ctx) {
  clearScreen();
  printHeader('🎧 听音识词 — 听发音拼写');
  console.log('  听发音，输入你听到的单词。输入 q 返回。');
  console.log('  ℹ️  打不出 ă â î ș ț 时，直接输入 a i s t 也算对。\n');

  const hasEspeak = (() => {
    try {
      execSync('command -v espeak', { stdio: 'ignore' });
      return true;
    } catch (e) { return false; }
  })();

  if (!hasEspeak) {
    console.log('  ⚠️  未检测到 espeak，将只显示首字母提示。');
    console.log('     安装后可听发音：sudo apt install espeak\n');
  }

  const reader = getReader();
  let asked = 0;

  while (true) {
    const item = weightedPick(ctx.words);

    if (hasEspeak) {
      try {
        execSync(`espeak -v ro -q "${item.word.replace(/"/g, '')}"`, { stdio: 'ignore' });
        console.log('  🔊 （已播放发音）');
      } catch (e) { /* 静默忽略 */ }
    } else {
      console.log(`  💡 提示：首字母「${item.word[0]}」，共 ${item.word.length} 个字母`);
    }

    process.stdout.write('  ✏️  你听到的单词 > ');
    const answer = await reader.ask('');

    asked++;
    if (answer.toLowerCase() === 'q') break;
    judge(answer, item.word, ctx.progress, ctx.score, null, ctx);
    if (asked % 10 === 0) saveProgress(ctx.progress);
    console.log();
  }

  saveProgress(ctx.progress);
}

// ============ 模块 4: 句子拼装 ============
async function modeSentenceBuild(ctx) {
  clearScreen();
  printHeader('🧩 句子拼装 — 补全句子');
  console.log('  输入缺失的单词补全句子。输入 q 返回。\n');

  const templates = [
    { sentence: 'Eu ___ în România.', answer: 'locuiesc', hint: '居住（我）' },
    { sentence: 'Ea ___ o carte.', answer: 'citește', hint: '读（她）' },
    { sentence: 'Noi ___ la școală.', answer: 'mergem', hint: '去（我们）' },
    { sentence: 'Tu ___ foarte bine.', answer: 'cânți', hint: '唱（你）' },
    { sentence: 'Ei ___ în parc.', answer: 'aleargă', hint: '跑（他们）' },
    { sentence: 'Vreau ___ apă.', answer: 'o', hint: '不定冠词（阴性）' },
    { sentence: 'El ___ un student.', answer: 'este', hint: '是（他）' },
    { sentence: 'Mulțumesc ___ ajutor.', answer: 'pentru', hint: '为了 / 因为' },
  ];

  const reader = getReader();
  let asked = 0;

  while (true) {
    const t = randomOf(templates);
    console.log(`  🧩 ${t.sentence}`);
    console.log(`  💡 ${t.hint}`);
    process.stdout.write('  ✏️  缺失的单词 > ');
    const answer = await reader.ask('');

    asked++;
    if (answer.toLowerCase() === 'q') break;
    judge(answer, t.answer, ctx.progress, ctx.score, null, ctx);
    if (asked % 10 === 0) saveProgress(ctx.progress);
    console.log();
  }

  saveProgress(ctx.progress);
}

// ============ 模块 5: 生词复习 ============
async function modeReview(ctx) {
  clearScreen();
  printHeader('📚 生词复习 — 弱项巩固');
  console.log('  只刷之前打错的词，答对即移出生词本。输入 q 返回。\n');

  if (Object.keys(ctx.progress.wrongWords).length === 0) {
    console.log('  🎉 生词本是空的，先去别的模式练练吧！');
    await sleep(1800);
    return;
  }

  const reader = getReader();
  let asked = 0;

  while (true) {
    const entries = Object.entries(ctx.progress.wrongWords);
    if (entries.length === 0) {
      console.log('  🎉 生词本清空了！');
      await sleep(1200);
      break;
    }

    // 错得越多的越优先
    entries.sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, 10);
    const [word, count] = randomOf(top);

    console.log(`  📚 ${word}   （曾错 ${count} 次）`);
    process.stdout.write('  ✏️  拼写 > ');
    const answer = await reader.ask('');

    asked++;
    if (answer.toLowerCase() === 'q') break;

    if (answer.toLowerCase() === word.toLowerCase()) {
      console.log('  ✅ 正确！已移出生词本');
      ctx.score.hit();
      ctx.progress.totalCorrect++;
      delete ctx.progress.wrongWords[word];
    } else if (sameFolded(answer, word)) {
      // 无符号输入也判对，但保留在生词本里多练一次
      console.log(`  ✅ 正确！（无符号输入）正确拼写：${word}`);
      console.log('     ℹ️  该词仍留在生词本，再练一次加深记忆');
      ctx.score.hit();
      ctx.progress.totalCorrect++;
    } else {
      console.log(`  ❌ 错误！正确答案：${word}`);
      ctx.score.miss();
      ctx.progress.totalWrong++;
      ctx.progress.wrongWords[word] = count + 1;
    }
    // 复习时也给出翻译
    if (ctx.translations && ctx.showTranslation !== false) {
      const line = translationLine(word, ctx.translations);
      if (line) console.log(line);
    }
    console.log(ctx.score.line());
    if (asked % 10 === 0) saveProgress(ctx.progress);
    console.log();
  }

  saveProgress(ctx.progress);
}

// ============ 主菜单 ============
const MODES = [
  { key: '1', label: '🎯 频率射击', desc: '常见词快速识别', run: modeFrequencyShoot },
  { key: '2', label: '📝 语法变体', desc: '词尾变化练习', run: modeGrammarVariants },
  { key: '3', label: '🎧 听音识词', desc: '听发音拼写', run: modeListenSpell },
  { key: '4', label: '🧩 句子拼装', desc: '补全句子', run: modeSentenceBuild },
  { key: '5', label: '📚 生词复习', desc: '弱项巩固', run: modeReview },
];

async function mainMenu() {
  const { words, lemmas, translations } = loadAll();
  const progress = loadProgress();
  const ctx = { words, lemmas, translations, progress, score: new ScoreTracker(), showTranslation: true };
  currentProgress = progress;   // 供 SIGINT 处理器保存

  const reader = getReader();

  while (true) {
    clearScreen();
    printHeader('🇷🇴 RomanianLearn — 罗马尼亚语学习工具');
    console.log(`  词库：${words.length} 常用词 · ${lemmas.length} 词根`);
    console.log(`  累计：正确 ${progress.totalCorrect} · 错误 ${progress.totalWrong} · 生词 ${Object.keys(progress.wrongWords).length}`);
    console.log();
    for (const m of MODES) {
      console.log(`  [${m.key}] ${m.label} — ${m.desc}`);
    }
    console.log(`  [t] 翻译显示：${ctx.showTranslation ? '开' : '关'}`);
    console.log('  [0] 退出');
    console.log();

    const choice = await reader.ask('  请选择 > ');
    const mode = MODES.find(m => m.key === choice);

    if (choice === '0' || choice.toLowerCase() === 'q') {
      saveProgress(progress);
      clearScreen();
      console.log('\n  La revedere! 👋\n');
      reader.close();
      return;
    }

    if (choice.toLowerCase() === 't') {
      ctx.showTranslation = !ctx.showTranslation;
      console.log(`  ℹ️  翻译显示已${ctx.showTranslation ? '开启' : '关闭'}`);
      await sleep(700);
      continue;
    }

    if (mode) {
      await mode.run(ctx);
    } else {
      console.log('  ⚠️  无效选择');
      await sleep(800);
    }
  }
}

// ============ 启动 ============
if (require.main === module) {
  // Ctrl+C：保存进度后干净退出，不留残缺终端状态
  let quitting = false;
  _gracefulExit = () => {
    if (quitting) process.exit(1);
    quitting = true;
    try { saveProgress(currentProgress || loadProgress()); } catch (e) { /* 忽略 */ }
    try { if (_reader) _reader.close(); } catch (e) { /* 忽略 */ }
    process.stdout.write('\n\n  La revedere! 👋\n\n');
    process.exit(0);
  };
  process.on('SIGINT', _gracefulExit);

  mainMenu().catch(err => {
    console.error('\n发生错误：', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = { loadFreqTable, pickExisting, ScoreTracker, weightedPick, foldDiacritics, sameFolded, hasDiacritics };
