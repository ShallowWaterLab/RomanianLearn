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

// 数据目录：档案与进度都放用户目录，避免安装目录只读
const DATA_DIR = path.join(os.homedir(), '.romanianlearn');
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const LEGACY_PROGRESS = path.join(DATA_DIR, 'progress.json');

const DEFAULT_PROFILE = '默认';

// ============ 档案 ============
function safeProfileName(name) {
  return String(name).trim().replace(/[\/\\:*?"<>|]/g, '_').slice(0, 40);
}

function profilePath(name) {
  return path.join(PROFILE_DIR, safeProfileName(name) + '.json');
}

function emptyProfile(name) {
  return {
    name: name,
    created: new Date().toISOString(),
    totalCorrect: 0,
    totalWrong: 0,
    words: {},          // word -> { c: 连续答对次数, w: 累计答错, dueAt: 该在第几题再出现 }
    asked: 0,           // 该档案累计出题数（用于计算 dueAt）
  };
}

function readIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      const d = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
      return {
        current: d.current || null,
        profiles: Array.isArray(d.profiles) ? d.profiles : [],
      };
    }
  } catch (e) { /* 损坏则重建 */ }
  return { current: null, profiles: [] };
}

function writeIndex(idx) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf-8');
  } catch (e) { /* 忽略 */ }
}

// 列出磁盘上真实存在的档案
function listProfiles() {
  const idx = readIndex();
  let files = [];
  try {
    if (fs.existsSync(PROFILE_DIR)) {
      files = fs.readdirSync(PROFILE_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => f.slice(0, -5));
    }
  } catch (e) { /* 忽略 */ }

  // 以磁盘为准，并保持索引中的顺序
  const ordered = [];
  for (const n of idx.profiles) if (files.includes(n)) ordered.push(n);
  for (const n of files) if (!ordered.includes(n)) ordered.push(n);
  return ordered;
}

function loadProfile(name) {
  try {
    const p = profilePath(name);
    if (fs.existsSync(p)) {
      const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
      return {
        name: name,
        created: d.created || new Date().toISOString(),
        totalCorrect: d.totalCorrect || 0,
        totalWrong: d.totalWrong || 0,
        words: d.words && typeof d.words === 'object' ? d.words : {},
        asked: d.asked || 0,
      };
    }
  } catch (e) { /* 损坏则新建 */ }
  return emptyProfile(name);
}

function saveProfile(profile) {
  try {
    fs.mkdirSync(PROFILE_DIR, { recursive: true });
    fs.writeFileSync(profilePath(profile.name),
                     JSON.stringify(profile, null, 2), 'utf-8');
    const idx = readIndex();
    if (!idx.profiles.includes(profile.name)) idx.profiles.push(profile.name);
    idx.current = profile.name;
    writeIndex(idx);
  } catch (e) { /* 存档失败不应中断游戏 */ }
}

function createProfile(name) {
  const n = safeProfileName(name) || DEFAULT_PROFILE;
  const p = emptyProfile(n);
  saveProfile(p);
  return p;
}

function deleteProfile(name) {
  try {
    const p = profilePath(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
    const idx = readIndex();
    idx.profiles = idx.profiles.filter(x => x !== name);
    if (idx.current === name) idx.current = idx.profiles[0] || null;
    writeIndex(idx);
    return true;
  } catch (e) {
    return false;
  }
}

// 首次运行：把旧的单文件进度迁移成档案，避免老用户丢进度
function migrateLegacy() {
  try {
    if (!fs.existsSync(LEGACY_PROGRESS)) return;
    if (listProfiles().length > 0) return;
    const d = JSON.parse(fs.readFileSync(LEGACY_PROGRESS, 'utf-8'));
    const p = emptyProfile(DEFAULT_PROFILE);
    p.totalCorrect = d.totalCorrect || 0;
    p.totalWrong = d.totalWrong || 0;
    // 旧的 wrongWords 是 {词: 次数}，转成新结构
    for (const [w, n] of Object.entries(d.wrongWords || {})) {
      p.words[w] = { c: 0, w: n, dueAt: 0 };
    }
    saveProfile(p);
    fs.renameSync(LEGACY_PROGRESS, LEGACY_PROGRESS + '.migrated');
  } catch (e) { /* 迁移失败不阻塞启动 */ }
}

// ============ 间隔重复 ============
// 答对的词不会消失，而是"间隔"逐次拉长后再出现（防遗忘）；
// 答错的词立刻回到近期队列（弱项优先）。
const BASE_INTERVAL = 8;      // 首次答对后，隔多少题再出现
const MAX_INTERVAL = 500;

function intervalFor(streak) {
  // streak=1 → 8, 2 → 16, 3 → 32, 4 → 64 ... 上限 500
  const v = BASE_INTERVAL * Math.pow(2, Math.max(0, streak - 1));
  return Math.min(MAX_INTERVAL, Math.round(v));
}

// 记录一次作答，更新该词的复习状态
function recordAnswer(progress, word, correct) {
  const key = String(word).toLowerCase();
  progress.asked = (progress.asked || 0) + 1;
  let st = progress.words[key];
  if (!st) st = { c: 0, w: 0, dueAt: 0 };

  if (correct) {
    st.c = (st.c || 0) + 1;
    st.dueAt = progress.asked + intervalFor(st.c);
    // 连对 2 次即视为已掌握：清掉历史错误，否则这个词会永远挂在「待巩固」里
    if (st.c >= 2) st.w = 0;
  } else {
    st.c = 0;
    st.w = (st.w || 0) + 1;
    st.dueAt = progress.asked + 1;   // 下一题就可能再出现
  }
  progress.words[key] = st;
}

// 是否属于「待巩固」（答错过且尚未掌握）
function isWeak(st) {
  return (st.w || 0) > 0 && (st.c || 0) < 2;
}

// 是否已掌握
function isLearned(st) {
  return (st.c || 0) >= 2;
}

// 出题权重：错词最高，到期的词较高，已掌握的词随连对次数递减
function wordWeight(progress, word) {
  const st = progress.words[String(word).toLowerCase()];
  if (!st) return 1.0;                       // 没练过：正常引入
  const now = progress.asked || 0;
  const due = st.dueAt || 0;

  if (due <= now) {
    // 到期该复习了
    if (st.w > 0) return 60 + Math.min(st.w, 5) * 20;  // 错词：60~160
    return 12;                                         // 普通复习：12
  }
  // 还没到期：按连对次数压制，但仍保留极小权重（迟早还会出现）
  const streak = st.c || 0;
  return Math.max(0.02, 1 / Math.pow(2, streak));
}

// 按「词频 × 复习权重」抽取。
// 采用两段式：先决定这一题是「复习到期的词」还是「正常出题」，
// 否则少数到期词会被池子里上千个新词的权重稀释掉，导致错词迟迟不回来。
const REVIEW_SHARE = 0.7;     // 有到期词时，最多 70% 的题目用于复习
function pickWord(ctx, items, keyName) {
  const now = ctx.progress.asked || 0;

  // 找出所有「到期」的词（含答错后立刻到期的）
  const due = [];
  for (const [w, st] of Object.entries(ctx.progress.words)) {
    if ((st.dueAt || 0) <= now) {
      const it = items.find(x => String(x[keyName]).toLowerCase() === w);
      if (it) due.push(it);
    }
  }

  // 到期词足够多时，按比例优先复习；否则全部正常出题
  const reviewChance = due.length === 0 ? 0
    : Math.min(REVIEW_SHARE, due.length / 8);
  if (due.length > 0 && Math.random() < reviewChance) {
    return weightedOf(ctx, due, keyName);
  }

  // 正常出题池：前 2000 高频词 + 所有已练过的词
  const pool = items.slice(0, 2000);
  const seen = new Set(pool.map(it => String(it[keyName]).toLowerCase()));
  for (const w of Object.keys(ctx.progress.words)) {
    if (seen.has(w)) continue;
    const it = items.find(x => String(x[keyName]).toLowerCase() === w);
    if (it) pool.push(it);
  }
  return weightedOf(ctx, pool.length ? pool : items, keyName);
}

// 在给定集合里按「词频 × 复习权重」加权随机
function weightedOf(ctx, pool, keyName) {
  let total = 0;
  const weights = new Array(pool.length);
  for (let i = 0; i < pool.length; i++) {
    const it = pool[i];
    const f = Math.log((it.freq || 1) + 1);
    const w = f * wordWeight(ctx.progress, it[keyName]);
    weights[i] = w;
    total += w;
  }
  if (total <= 0) return pool[0];
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}

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

// words 与 lemmas 存在重叠（本身既是词形又是词根），
// 直接相加会虚高；这里按小写去重后给出真实词量
function countUniqueWords(words, lemmas) {
  const seen = new Set();
  for (const it of words) seen.add(it.word);
  for (const it of lemmas) seen.add(it.lemma);
  return seen.size;
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
  }

  // 无论对错都更新该词的复习状态：
  // 答对 → 间隔拉长后再出现（防遗忘）；答错 → 立刻回到近期队列
  recordAnswer(progress, expected, ok);
  if (ok && !exact) {
    // 无符号输入算对，但还没真正掌握拼写，间隔按较短的来
    const st = progress.words[String(expected).toLowerCase()];
    if (st) st.dueAt = (progress.asked || 0) + BASE_INTERVAL;
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
    const item = pickWord(ctx, ctx.words, 'word');
    process.stdout.write(`  🎯 ${item.word}\n  ✏️  > `);
    const answer = await reader.ask('');
    asked++;

    if (answer.toLowerCase() === 'q') break;
    judge(answer, item.word, ctx.progress, ctx.score, null, ctx);
    if (asked % 10 === 0) saveProfile(ctx.progress);
    console.log();
  }

  saveProfile(ctx.progress);
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
    const lemma = pickWord(ctx, ctx.lemmas, 'lemma').lemma;
    const v = randomOf(variants);
    const expected = lemma + v.suffix;

    console.log(`  📝 词根：${lemma}`);
    console.log(`  💡 加「${v.suffix}」（${v.hint}）`);
    process.stdout.write('  ✏️  完整形式 > ');
    const answer = await reader.ask('');

    asked++;
    if (answer.toLowerCase() === 'q') break;
    judge(answer, expected, ctx.progress, ctx.score, expected, ctx);
    if (asked % 10 === 0) saveProfile(ctx.progress);
    console.log();
  }

  saveProfile(ctx.progress);
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
    const item = pickWord(ctx, ctx.words, 'word');

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
    if (asked % 10 === 0) saveProfile(ctx.progress);
    console.log();
  }

  saveProfile(ctx.progress);
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
    if (asked % 10 === 0) saveProfile(ctx.progress);
    console.log();
  }

  saveProfile(ctx.progress);
}

// ============ 模块 5: 生词复习 ============
async function modeReview(ctx) {
  clearScreen();
  printHeader('📚 生词复习 — 弱项巩固');
  console.log('  只刷答错过的词，连对后间隔拉长。输入 q 返回。\n');

  // 生词 = 答错过、且尚未连对两次的词
  const weakWords = () => Object.entries(ctx.progress.words)
    .filter(([, st]) => isWeak(st))
    .sort((a, b) => (b[1].w || 0) - (a[1].w || 0));

  if (weakWords().length === 0) {
    console.log('  🎉 没有生词需要复习，先去别的模式练练吧！');
    await sleep(1800);
    return;
  }

  const reader = getReader();
  let asked = 0;

  while (true) {
    const list = weakWords();
    if (list.length === 0) {
      console.log('  🎉 生词都巩固好了！');
      await sleep(1200);
      break;
    }

    // 错得越多的越优先（前 10 个里随机，避免每次顺序完全一样）
    const [word, st] = randomOf(list.slice(0, 10));
    const missed = st.w || 0;
    const streak = st.c || 0;

    console.log(`  📚 ${word}   （曾错 ${missed} 次${streak ? `，已连对 ${streak} 次` : ''}）`);
    process.stdout.write('  ✏️  拼写 > ');
    const answer = await reader.ask('');

    asked++;
    if (answer.toLowerCase() === 'q') break;

    const exact = answer.toLowerCase() === word.toLowerCase();
    const folded = !exact && sameFolded(answer, word);

    if (exact) {
      console.log('  ✅ 正确！');
    } else if (folded) {
      console.log(`  ✅ 正确！（无符号输入）正确拼写：${word}`);
    } else {
      console.log(`  ❌ 错误！正确答案：${word}`);
    }
    if (exact) ctx.score.hit();
    else if (folded) ctx.score.hit();
    else ctx.score.miss();

    if (exact) ctx.progress.totalCorrect++;
    else if (folded) ctx.progress.totalCorrect++;
    else ctx.progress.totalWrong++;

    recordAnswer(ctx.progress, word, exact || folded);
    if (folded) {
      // 无符号输入还没真正掌握拼写，缩短间隔
      const s2 = ctx.progress.words[word.toLowerCase()];
      if (s2) s2.dueAt = (ctx.progress.asked || 0) + BASE_INTERVAL;
    }
    const after = ctx.progress.words[word.toLowerCase()] || {};
    if (exact && (after.c || 0) >= 2) {
      console.log('     ℹ️  已连对 2 次，间隔拉长，稍后再见');
    }

    // 复习时也给出翻译
    if (ctx.translations && ctx.showTranslation !== false) {
      const line = translationLine(word, ctx.translations);
      if (line) console.log(line);
    }
    console.log(ctx.score.line());
    if (asked % 10 === 0) saveProfile(ctx.progress);
    console.log();
  }

  saveProfile(ctx.progress);
}

// ============ 学习概览 ============
function showStats(ctx) {
  clearScreen();
  printHeader('📊 学习概览');
  const p = ctx.progress;
  const st = Object.values(p.words);
  const learned = st.filter(isLearned).length;
  const learning = st.filter(s => (s.c || 0) === 1).length;
  const weak = st.filter(isWeak).length;
  const total = p.totalCorrect + p.totalWrong;

  console.log(`  档案：${p.name}`);
  console.log(`  累计作答：${total} 题（正确 ${p.totalCorrect} · 错误 ${p.totalWrong}）`);
  if (total > 0) {
    console.log(`  正确率：${(p.totalCorrect / total * 100).toFixed(1)}%`);
  }
  console.log();
  console.log(`  ✅ 已掌握（连对 2 次以上）：${learned}`);
  console.log(`  📖 学习中（连对 1 次）：${learning}`);
  console.log(`  ⚠️  待巩固（答错过）：${weak}`);
  console.log(`  🆕 尚未练习：${countUniqueWords(ctx.words, ctx.lemmas) - st.length}`);
  console.log();
  console.log('  按回车返回主菜单');
}

// ============ 档案界面 ============
function profileSummary(name) {
  const p = loadProfile(name);
  const total = p.totalCorrect + p.totalWrong;
  const learned = Object.values(p.words).filter(isLearned).length;
  return { total, learned };
}

async function chooseProfile(reader) {
  while (true) {
    const names = listProfiles();

    if (names.length === 0) {
      clearScreen();
      printHeader('👤 新建学习档案');
      console.log('  第一次使用，先给自己起个名字（不同档案进度独立保存）。');
      console.log('  直接回车使用「' + DEFAULT_PROFILE + '」。\n');
      const input = await reader.ask('  档案名 > ');
      const name = safeProfileName(input) || DEFAULT_PROFILE;
      const p = createProfile(name);
      console.log(`  ✅ 已创建档案「${p.name}」`);
      await sleep(900);
      return p;
    }

    if (names.length === 1) {
      const p = loadProfile(names[0]);
      saveProfile(p);   // 记入 index
      return p;
    }

    // 多个档案：让用户选
    clearScreen();
    printHeader('👤 选择学习档案');
    names.forEach((n, i) => {
      const s = profileSummary(n);
      console.log(`  [${i + 1}] ${n}   累计 ${s.total} 题 · 已掌握 ${s.learned} 词`);
    });
    console.log(`  [n] 新建档案`);
    console.log();

    const choice = await reader.ask('  请选择 > ');
    const c = choice.toLowerCase();

    if (c === 'n') {
      const input = await reader.ask('  新档案名 > ');
      const name = safeProfileName(input) || DEFAULT_PROFILE;
      if (names.includes(name)) {
        console.log(`  ⚠️  档案「${name}」已存在`);
        await sleep(1200);
        continue;
      }
      const p = createProfile(name);
      console.log(`  ✅ 已创建档案「${p.name}」`);
      await sleep(900);
      return p;
    }

    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < names.length) {
      const p = loadProfile(names[idx]);
      saveProfile(p);
      return p;
    }
    console.log('  ⚠️  无效选择');
    await sleep(800);
  }
}

async function manageProfiles(ctx, reader) {
  clearScreen();
  printHeader('👤 档案管理');
  const names = listProfiles();
  names.forEach((n, i) => {
    const s = profileSummary(n);
    const mark = n === ctx.progress.name ? ' ←当前' : '';
    console.log(`  [${i + 1}] ${n}   累计 ${s.total} 题 · 已掌握 ${s.learned} 词${mark}`);
  });
  console.log('  [n] 新建档案');
  console.log('  [d] 删除档案');
  console.log('  [回车] 返回');
  console.log();

  const choice = await reader.ask('  请选择 > ');
  const c = choice.toLowerCase();

  if (c === 'n') {
    const input = await reader.ask('  新档案名 > ');
    const name = safeProfileName(input) || DEFAULT_PROFILE;
    if (names.includes(name)) {
      console.log(`  ⚠️  档案「${name}」已存在`);
      await sleep(1200);
      return;
    }
    saveProfile(ctx.progress);      // 先保存当前
    const p = createProfile(name);
    ctx.progress = p;
    currentProgress = p;
    console.log(`  ✅ 已创建并切换到「${p.name}」`);
    await sleep(1000);
    return;
  }

  if (c === 'd') {
    if (names.length <= 1) {
      console.log('  ⚠️  至少要保留一个档案');
      await sleep(1200);
      return;
    }
    const input = await reader.ask('  要删除哪个（输入编号）> ');
    const idx = parseInt(input, 10) - 1;
    if (idx < 0 || idx >= names.length) {
      console.log('  ⚠️  无效编号');
      await sleep(1000);
      return;
    }
    const target = names[idx];
    const confirm = await reader.ask(`  确认删除档案「${target}」及其全部进度？(yes/N) > `);
    if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
      console.log('  已取消');
      await sleep(900);
      return;
    }
    const wasCurrent = target === ctx.progress.name;
    saveProfile(ctx.progress);      // 防止删除后 index 被覆盖
    if (deleteProfile(target)) {
      console.log(`  ✅ 已删除「${target}」`);
      if (wasCurrent) {
        const rest = listProfiles();
        const p = rest.length ? loadProfile(rest[0]) : createProfile(DEFAULT_PROFILE);
        saveProfile(p);
        ctx.progress = p;
        currentProgress = p;
        console.log(`  已切换到「${p.name}」`);
      }
    } else {
      console.log('  ⚠️  删除失败');
    }
    await sleep(1200);
    return;
  }

  const idx = parseInt(choice, 10) - 1;
  if (idx >= 0 && idx < names.length) {
    saveProfile(ctx.progress);      // 先保存当前档案
    const p = loadProfile(names[idx]);
    saveProfile(p);
    ctx.progress = p;
    currentProgress = p;
    console.log(`  ✅ 已切换到「${p.name}」`);
    await sleep(900);
  }
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
  const reader = getReader();

  // 首次运行：迁移旧版单文件进度
  migrateLegacy();
  // 选档案（多个时让用户选，只有一个直接进）
  const progress = await chooseProfile(reader);

  const ctx = {
    words, lemmas, translations, progress,
    score: new ScoreTracker(), showTranslation: true,
  };
  currentProgress = progress;   // 供 SIGINT 处理器保存

  while (true) {
    clearScreen();
    printHeader('🇷🇴 RomanianLearn — 罗马尼亚语学习工具');
    // words 与 lemmas 有重叠，直接相加会虚高；这里报告去重后的总数
    const uniqTotal = countUniqueWords(words, lemmas);
    console.log(`  档案：${progress.name}`);
    console.log(`  词库：${uniqTotal} 个词（${words.length} 词形 · ${lemmas.length} 词根）`);
    const st = Object.values(progress.words);
    const learned = st.filter(isLearned).length;
    const weak = st.filter(isWeak).length;
    console.log(`  累计：正确 ${progress.totalCorrect} · 错误 ${progress.totalWrong} · 已掌握 ${learned} · 待巩固 ${weak}`);
    console.log();
    for (const m of MODES) {
      console.log(`  [${m.key}] ${m.label} — ${m.desc}`);
    }
    console.log(`  [s] 📊 学习概览`);
    console.log(`  [p] 👤 档案管理`);
    console.log(`  [t] 翻译显示：${ctx.showTranslation ? '开' : '关'}`);
    console.log('  [0] 退出');
    console.log();

    const choice = await reader.ask('  请选择 > ');
    const mode = MODES.find(m => m.key === choice);
    const c = choice.toLowerCase();

    if (choice === '0' || c === 'q') {
      saveProfile(progress);
      clearScreen();
      console.log('\n  La revedere! 👋\n');
      reader.close();
      return;
    }

    if (c === 't') {
      ctx.showTranslation = !ctx.showTranslation;
      console.log(`  ℹ️  翻译显示已${ctx.showTranslation ? '开启' : '关闭'}`);
      await sleep(700);
      continue;
    }

    if (c === 's') {
      showStats(ctx);
      await reader.ask('');
      continue;
    }

    if (c === 'p') {
      await manageProfiles(ctx, reader);
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
    try { if (currentProgress) saveProfile(currentProgress); } catch (e) { /* 忽略 */ }
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

module.exports = {
  loadFreqTable, pickExisting, ScoreTracker, weightedPick,
  foldDiacritics, sameFolded, hasDiacritics,
  intervalFor, wordWeight, recordAnswer, emptyProfile, isWeak, isLearned,
  safeProfileName, listProfiles, loadProfile, saveProfile,
  createProfile, deleteProfile,
};
