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
const VERSION = '1.0.0';
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
  return `  ${S.dim}${bits.join('　｜　')}${S.reset}`;
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
    return `  ${S.dim}正确${S.reset} ${this.correct}` +
           `   ${S.dim}错误${S.reset} ${this.wrong}` +
           `   ${S.dim}连击${S.reset} ${this.streak}` +
           `   ${S.dim}准确率${S.reset} ${this.accuracy}`;
  }
}

// ============ 终端工具 ============
function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
  flushKeys();
}

function randomOf(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============ 主题 ============
// 现代简约：一个强调色 + 灰阶层次，不用花哨的 emoji。
// NO_COLOR / 非终端环境自动降级为纯文本。
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;

function wrap(code) {
  return USE_COLOR ? `\x1b[${code}m` : '';
}

const S = {
  reset: wrap('0'),
  bold: wrap('1'),
  dim: wrap('2'),
  accent: wrap('36'),      // 青色：标题与选中项
  good: wrap('32'),        // 绿：正确
  bad: wrap('31'),         // 红：错误
  warn: wrap('33'),        // 黄：提示
  inverse: wrap('7'),      // 反显：当前选中行
  hide: wrap('?25l'),      // 隐藏光标
  show: wrap('?25h'),      // 显示光标
};

// 终端显示宽度（中日韩字符与 emoji 占两列），用于精确对齐
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f000 && cp <= 0x1f9ff);
    w += wide ? 2 : 1;
  }
  return w;
}

// 按显示宽度右侧补空格
function pad(s, n) {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, n - dispWidth(str)));
}

// 按显示宽度左侧补空格
function padL(s, n) {
  const str = String(s);
  return ' '.repeat(Math.max(0, n - dispWidth(str))) + str;
}

const UI_WIDTH = 62;

// 顶部分隔线（标题栏）
function bar(title) {
  const t = ` ${title} `;
  const left = '─'.repeat(2);
  const right = '─'.repeat(Math.max(0, UI_WIDTH - 2 - dispWidth(t)));
  return S.dim + left + S.reset + S.bold + S.accent + t + S.reset +
         S.dim + right + S.reset;
}

function rule() {
  return S.dim + '─'.repeat(UI_WIDTH) + S.reset;
}

function blank() {
  return '';
}

// ============ 输入层 ============
// 只用一套原始模式按键读取：高亮菜单与文本输入共用，
// 从根上避免「readline 双实例导致按键重复回显」那类问题。
let currentProgress = null;   // 主菜单持有的进度对象，供 SIGINT 时保存
let _gracefulExit = null;     // 由启动段注入的退出处理

// 解析一次按键（可能包含方向键的转义序列）
function parseKey(str) {
  if (str === '\x1b' || str === '\x1b\x1b') return { name: 'escape' };
  if (str === '\x1b[A' || str === '\x1bOA') return { name: 'up' };
  if (str === '\x1b[B' || str === '\x1bOB') return { name: 'down' };
  if (str === '\x1b[C' || str === '\x1bOC') return { name: 'right' };
  if (str === '\x1b[D' || str === '\x1bOD') return { name: 'left' };
  if (str === '\x1b[5~') return { name: 'pageup' };
  if (str === '\x1b[6~') return { name: 'pagedown' };
  if (str === '\r' || str === '\n') return { name: 'enter' };
  if (str === '\x7f' || str === '\b') return { name: 'backspace' };
  if (str === '\x03') return { name: 'ctrl-c' };
  if (str === '\x15') return { name: 'clear-line' };
  // 多字节可打印字符（含罗语变音符号）
  if (str.length >= 1 && str >= ' ') return { name: 'char', char: str };
  return { name: 'other' };
}

// 按键队列：管道/粘贴时一次数据可能含多个字符，
// 不能只取第一个就丢弃其余，否则后续输入会丢。
let _keyQueue = [];
let _keyWaiter = null;

function _feedKeys(str) {
  // 把转义序列切成一个个「按键」
  const keys = [];
  let i = 0;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      // 尝试匹配已知转义序列
      let matched = null;
      for (const seq of ['\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D',
                         '\x1bOA', '\x1bOB', '\x1bOC', '\x1bOD',
                         '\x1b[5~', '\x1b[6~']) {
        if (str.startsWith(seq, i)) { matched = seq; break; }
      }
      if (matched) { keys.push(matched); i += matched.length; continue; }
      keys.push('\x1b'); i += 1; continue;
    }
    // 其余按字符切（含多字节罗语字母）
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    keys.push(ch);
    i += ch.length;
  }
  _keyQueue.push(...keys);
  if (_keyWaiter && _keyQueue.length > 0) {
    const w = _keyWaiter;
    _keyWaiter = null;
    w();
  }
}

let _stdinHooked = false;
function _hookStdin() {
  if (_stdinHooked) return;
  _stdinHooked = true;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => _feedKeys(String(d)));
  if (process.stdin.isTTY) {
    try { process.stdin.setRawMode(true); } catch (e) { /* 忽略 */ }
  }
  process.stdin.resume();
}

// 读一次按键。原始模式，读完不恢复（全程保持），避免状态来回切换。
function readKey() {
  _hookStdin();
  return new Promise((resolve) => {
    const take = () => resolve(parseKey(_keyQueue.shift()));
    if (_keyQueue.length > 0) { take(); return; }
    _keyWaiter = take;
  });
}

// 丢弃队列中残留的按键（切屏时调用，避免上一次的按键漏到下一屏）
function flushKeys() {
  _keyQueue = [];
}

// 行输入：自实现的行编辑（可打印字符 / 退格 / 回车 / Esc 取消）
async function askText(prompt, opts = {}) {
  let buf = '';
  process.stdout.write(prompt);
  while (true) {
    const k = await readKey();
    if (k.name === 'enter') {
      process.stdout.write('\n');
      return buf.trim();
    }
    if (k.name === 'ctrl-c') {
      process.stdout.write('\n');
      if (_gracefulExit) _gracefulExit();
      return '';
    }
    if (k.name === 'escape') {
      process.stdout.write('\n');
      return opts.escapeReturnsNull ? null : '';
    }
    if (k.name === 'backspace') {
      if (buf.length > 0) {
        buf = buf.slice(0, -1);
        process.stdout.write('\b \b');
      }
      continue;
    }
    if (k.name === 'clear-line') {
      process.stdout.write('\b \b'.repeat(buf.length));
      buf = '';
      continue;
    }
    if (k.name === 'char') {
      buf += k.char;
      process.stdout.write(k.char);
    }
  }
}

// 高亮选择菜单：↑↓（或 j/k）移动，空格/回车确认，Esc 返回。
// 返回选中项，Esc 返回 null。
async function selectMenu(items, opts = {}) {
  flushKeys(); // 清空残留按键，避免上一次回车/方向键被误收
  const { footer = '', initial = 0, header = '' } = opts;
  let idx = Math.min(Math.max(0, initial), items.length - 1);
  const lines = [];

  const draw = (first) => {
    const out = [];
    if (first) {
      if (header) out.push(header);
      out.push('');
    }
    items.forEach((it, i) => {
      const cur = i === idx;
      const mark = cur ? '▸' : ' ';
      const label = pad(it.label, 18);
      // 选中行不能内嵌 reset，否则会提前结束反显
      const row = cur
        ? `  ${mark} ${label} ${it.desc || ''}`
        : `  ${mark} ${label} ${S.dim}${it.desc || ''}${S.reset}`;
      out.push(cur ? S.inverse + row + S.reset : row);
    });
    if (footer) {
      out.push('');
      out.push(S.dim + '  ' + footer + S.reset);
    }
    return out;
  };

  if (items.length === 0) return null;

  // 首次绘制：清屏 + 光标归位
  process.stdout.write('\x1b[2J\x1b[H');
  const first = draw(true);
  process.stdout.write(first.join('\n') + '\n');

  while (true) {
    const k = await readKey();
    let moved = false;
    if (k.name === 'up' || (k.name === 'char' && k.char === 'k')) {
      idx = (idx - 1 + items.length) % items.length;
      moved = true;
    } else if (k.name === 'down' || (k.name === 'char' && k.char === 'j')) {
      idx = (idx + 1) % items.length;
      moved = true;
    } else if (k.name === 'enter' || (k.name === 'char' && k.char === ' ')) {
      process.stdout.write(S.show);
      return items[idx];
    } else if (k.name === 'escape') {
      process.stdout.write(S.show);
      return null;
    } else if (k.name === 'ctrl-c') {
      if (_gracefulExit) _gracefulExit();
      return null;
    }

    if (moved) {
      // 只重画选项区：光标上移 items.length + 页脚行数后覆盖
      const back = items.length + (footer ? 2 : 0);
      process.stdout.write(`\x1b[${back}A`);
      const rows = draw(false);
      rows.forEach(r => process.stdout.write(r + '\x1b[K\n'));
    }
  }
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
      console.log(`  ${S.good}✓${S.reset} 正确`);
    } else {
      // 用户用了无符号写法：判对，但把正确拼写显示出来帮助记忆
      console.log(`  ${S.good}✓${S.reset} 正确 ${S.dim}（无符号输入）正确拼写：${S.reset}${S.bold}${expected}${S.reset}`);
    }
    score.hit();
    progress.totalCorrect++;
  } else {
    console.log(`  ${S.bad}✗${S.reset} 错误 ${S.dim}正确答案：${S.reset}${S.bold}${shownAnswer || expected}${S.reset}`);
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
  const out = [
    bar('词汇拼写'),
    '',
    `  ${S.dim}看中文释义，写出对应的罗马尼亚语单词。${S.reset}`,
    `  ${S.dim}打不出 ă â î ș ț 时，直接输入 a i s t 也算对。${S.reset}`,
    `  ${S.dim}Esc 返回主菜单${S.reset}`,
    '',
    // ── 定冠词（后缀形式）──
    { sentence: 'Văd ___ în parc.', answer: 'omul', hint: '那个人（阳性单数定冠词）' },
    { sentence: 'Ea merge la ___.', answer: 'școala', hint: '学校（阴性单数定冠词）' },
    { sentence: 'Noi vedem ___.', answer: 'copiii', hint: '孩子们（阳性复数定冠词）' },
    // ── 指示形容词 ──
    { sentence: '___ carte este interesantă.', answer: 'Această', hint: '这（阴性单数）' },
    { sentence: 'Citesc ___ cărți.', answer: 'aceste', hint: '这些（阴性复数）' },
    { sentence: '___ oameni sunt prietenoși.', answer: 'Acești', hint: '这些（阳性复数）' },
    // ── 形容词一致（性/数）──
    { sentence: 'Este o fată ___.', answer: 'frumoasă', hint: '漂亮（阴性单数）' },
    { sentence: 'Am un prieten ___.', answer: 'bun', hint: '好（阳性单数）' },
    { sentence: 'Văd două case ___.', answer: 'mari', hint: '大（阴性复数）' },
    { sentence: 'Sunt ___.', answer: 'fericit', hint: '高兴（阳性单数）' },
    { sentence: 'Ea este ___.', answer: 'fericită', hint: '高兴（阴性单数）' },
    { sentence: 'Copiii sunt ___.', answer: 'fericiți', hint: '高兴（阳性复数）' },
    // ── 介词（la, în, cu, pentru, de）──
    { sentence: 'Merg ___ școală.', answer: 'la', hint: '去（学校）' },
    { sentence: 'Locuiesc ___ București.', answer: 'în', hint: '在（城市）' },
    { sentence: 'Vorbesc ___ prietenii.', answer: 'cu', hint: '和/跟' },
    { sentence: 'Cumpăr ___ pâine.', answer: 'de', hint: '从/买（面包）' },
    { sentence: 'Mulțumesc ___ ajutor.', answer: 'pentru', hint: '为了 / 因为' },
    { sentence: 'Ea scrie ___ stilou.', answer: 'cu', hint: '用（笔）' },
    // ── 代词（主格/宾格/与格）──
    { sentence: '___ vorbesc română.', answer: 'Eu', hint: '我（主格）' },
    { sentence: '___ văd pe el.', answer: 'Îl', hint: '他（宾格）' },
    { sentence: '___ dau cartea.', answer: 'Îi', hint: '给他（与格）' },
    { sentence: '___ îmi place cafeaua.', answer: 'Îmi', hint: '给我（与格）' },
    { sentence: '___ ne place muzica.', answer: 'Ne', hint: '给我们（与格）' },
    { sentence: '___ te iubesc.', answer: 'Te', hint: '你（宾格）' },
    // ── 否定 ──
    { sentence: '___ vreau să plec.', answer: 'Nu', hint: '不' },
    { sentence: 'Ea ___ înțelege.', answer: 'nu', hint: '不' },
    { sentence: '___ am văzut filmul.', answer: 'Nu', hint: '不' },
    // ── 疑问 ──
    { sentence: '___ vrei să mănânci?', answer: 'Ce', hint: '什么' },
    { sentence: '___ locuiești?', answer: 'Unde', hint: '哪里' },
    { sentence: '___ ai venit?', answer: 'Când', hint: '什么时候' },
    // ── 过去时（am + 过去分词）──
    { sentence: 'Ieri ___ la mare.', answer: 'am mers', hint: '去了（我）' },
    { sentence: 'Eu ___ filmul.', answer: 'am văzut', hint: '看了（我）' },
    { sentence: 'Ea ___ acasă.', answer: 'a fost', hint: '在（她）' },
    { sentence: 'Noi ___ cartea.', answer: 'am citit', hint: '读了（我们）' },
  ];
  clearScreen();
  process.stdout.write(out.join('\n'));

  let asked = 0;
  while (true) {
    const item = pickWord(ctx, ctx.words, 'word');
    const word = item.word;
    const t = ctx.translations.get(word.toLowerCase());

    // 用中文释义提示，让用户主动回忆拼写（照抄不产生记忆）
    if (t && t.zh && ctx.showTranslation) {
      process.stdout.write(`  ${S.accent}${t.zh}${S.reset}\n`);
    } else {
      // 没有释义时退化为首字母提示
      process.stdout.write(`  ${S.dim}首字母「${word[0]}」，共 ${word.length} 个字母${S.reset}\n`);
    }
    process.stdout.write(`  ${S.dim}›${S.reset} `);
    const answer = await askText('', { escapeReturnsNull: true });
    if (answer === null) break;          // Esc 返回
    asked++;
    if (answer.toLowerCase() === 'q') break;

    console.log();
    judge(answer, word, ctx.progress, ctx.score, null, ctx);
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


// ============ 词形变化生成器 ============
function genVariants(word) {
  const w = word.toLowerCase();
  const variants = [];

  // 阴性名词 -e 结尾 (carte, floare, câine)
  if (w.endsWith('e')) {
    const base = w.slice(0, -1);
    variants.push({ word: base + 'ea', hint: '阴性单数·定冠词' });
    variants.push({ word: base + 'ii', hint: '阴性单数·属格/与格' });
    variants.push({ word: base + 'ile', hint: '阴性复数·定冠词' });
    variants.push({ word: base + 'lor', hint: '阴性复数·属格/与格' });
  }
  // 阴性名词 -ă 结尾 (casă, pisică, fată)
  else if (w.endsWith('ă')) {
    const base = w.slice(0, -1);
    variants.push({ word: base + 'a', hint: '阴性单数·定冠词' });
    variants.push({ word: base + 'ei', hint: '阴性单数·属格/与格' });
    variants.push({ word: base + 'le', hint: '阴性复数·定冠词' });
    variants.push({ word: base + 'lor', hint: '阴性复数·属格/与格' });
  }
  // 中性名词 -i 结尾
  else if (w.endsWith('i')) {
    variants.push({ word: w + 'ul', hint: '中性单数·定冠词' });
    variants.push({ word: w + 'ului', hint: '中性单数·属格/与格' });
    variants.push({ word: w + 'i', hint: '中性复数·定冠词' });
    variants.push({ word: w + 'ilor', hint: '中性复数·属格/与格' });
  }
  // 阳性名词 辅音结尾 (om, student, profesor)
  else if (!/[aeiouăâî]$/.test(w)) {
    variants.push({ word: w + 'ul', hint: '阳性单数·定冠词' });
    variants.push({ word: w + 'ului', hint: '阳性单数·属格/与格' });
    variants.push({ word: w + 'i', hint: '阳性复数·定冠词' });
    variants.push({ word: w + 'ilor', hint: '阳性复数·属格/与格' });
  }

  return variants;
}

// ============ 模块 2: 语法变体 ============
async function modeGrammarVariants(ctx) {
  clearScreen();
  process.stdout.write([
    bar('词形变化'),
    '',
    `  ${S.dim}给出词根和词尾，写出完整形式。${S.reset}`,
    `  ${S.dim}打不出 ă â î ș ț 时，直接输入 a i s t 也算对。${S.reset}`,
    `  ${S.dim}Esc 返回主菜单${S.reset}`,
    '',
  ].join('\n'));

  let asked = 0;

  while (true) {
    const lemma = pickWord(ctx, ctx.lemmas, 'lemma').lemma;
    const allVariants = genVariants(lemma);
    if (allVariants.length === 0) continue;
    const v = randomOf(allVariants);

    console.log(`  ${S.dim}词根${S.reset}  ${S.bold}${lemma}${S.reset}`);
    console.log(`  ${S.dim}要求${S.reset}  写出「${v.hint}」的形式`);
    process.stdout.write(`  ${S.dim}›${S.reset} `);
    const answer = await askText('', { escapeReturnsNull: true });
    if (answer === null) break;

    asked++;
    if (answer.toLowerCase() === 'q') break;
    judge(answer, v.word, ctx.progress, ctx.score, v.word, ctx);
    if (asked % 10 === 0) saveProfile(ctx.progress);
    console.log();
  }

  saveProfile(ctx.progress);
}


// ============ TTS 后端管理 ============
const TTS_BACKENDS = [
  { name: 'espeak', cmd: w => `espeak -v ro -q "${w}"` },
  { name: 'espeak-ng', cmd: w => `espeak-ng -v ro -q "${w}"` },
  { name: 'festival', cmd: w => `echo "${w}" | festival --tts --language romanian` },
  { name: 'pico2wave', cmd: w => `pico2wave -l ro-RO -w /tmp/rl_tts.wav "${w}" && aplay /tmp/rl_tts.wav 2>/dev/null` },
  { name: 'flite', cmd: w => `flite -t "${w}"` },
  { name: 'say', cmd: w => `say -v Ioana "${w}"` },
];

let _ttsBackend = null;
let _ttsChecked = false;

function detectTTS() {
  if (_ttsChecked) return _ttsBackend;
  _ttsChecked = true;
  for (const b of TTS_BACKENDS) {
    try {
      execSync(`command -v ${b.name}`, { stdio: 'ignore' });
      _ttsBackend = b;
      break;
    } catch (e) { /* not available */ }
  }
  return _ttsBackend;
}

function speak(word) {
  const backend = detectTTS();
  if (!backend) return false;
  try {
    execSync(backend.cmd(word.replace(/"/g, '')), { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

// ============ 模块 3: 听音识词 ============
async function modeListenSpell(ctx) {
  clearScreen();
  process.stdout.write([
    bar('听音拼写'),
    '',
    `  ${S.dim}听发音，写出你听到的单词。${S.reset}`,
    `  ${S.dim}打不出 ă â î ș ț 时，直接输入 a i s t 也算对。${S.reset}`,
    `  ${S.dim}Esc 返回主菜单${S.reset}`,
    '',
  ].join('\n'));

  const ttsBackend = detectTTS();

  if (!ttsBackend) {
    console.log('  ⚠️  未检测到 TTS 引擎，将只显示首字母提示。');
    console.log('     安装后可听发音：sudo apt install espeak\n');
  }

  let asked = 0;

  while (true) {
    const item = pickWord(ctx, ctx.words, 'word');

    if (ttsBackend) {
      const ok = speak(item.word);
      if (ok) {
        console.log(`  ${S.accent}♪${S.reset} ${S.dim}已播放发音${S.reset}`);
      } else {
        console.log(`  ${S.dim}提示  首字母「${item.word[0]}」，共 ${item.word.length} 个字母${S.reset}`);
      }
    } else {
      console.log(`  ${S.dim}提示  首字母「${item.word[0]}」，共 ${item.word.length} 个字母${S.reset}`);
    }

    process.stdout.write(`  ${S.dim}›${S.reset} `);
    const answer = await askText('', { escapeReturnsNull: true });
    if (answer === null) break;

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
  process.stdout.write([
    bar('句子填空'),
    '',
    `  ${S.dim}补全句子中缺失的单词。${S.reset}`,
    `  ${S.dim}Esc 返回主菜单${S.reset}`,
    '',
  ].join('\n'));

    const templates = [
    // ── 动词变位（现在时）──
    { sentence: 'Eu ___ în România.', answer: 'locuiesc', hint: '居住（我）' },
    { sentence: 'Tu ___ foarte bine.', answer: 'cânți', hint: '唱（你）' },
    { sentence: 'Ea ___ o carte.', answer: 'citește', hint: '读（她）' },
    { sentence: 'El ___ un student.', answer: 'este', hint: '是（他）' },
    { sentence: 'Noi ___ la școală.', answer: 'mergem', hint: '去（我们）' },
    { sentence: 'Voi ___ la magazin.', answer: 'cumpărați', hint: '买（你们）' },
    { sentence: 'Ei ___ în parc.', answer: 'aleargă', hint: '跑（他们）' },
    { sentence: 'Ele ___ română.', answer: 'învață', hint: '学习（她们）' },
    { sentence: 'Eu ___ o mașină.', answer: 'am', hint: '有（我）' },
    { sentence: 'Tu ___ mulți prieteni.', answer: 'ai', hint: '有（你）' },
    { sentence: 'El ___ o casă mare.', answer: 'are', hint: '有（他）' },
    { sentence: 'Noi ___ trei copii.', answer: 'avem', hint: '有（我们）' },
    { sentence: 'Voi ___ nevoie de ajutor.', answer: 'aveți', hint: '有（你们）' },
    { sentence: 'Ei ___ un câine.', answer: 'au', hint: '有（他们）' },
    // ── 不定冠词 ──
    { sentence: 'Vreau ___ apă.', answer: 'o', hint: '不定冠词（阴性）' },
    { sentence: 'El citește ___ carte.', answer: 'o', hint: '不定冠词（阴性）' },
    { sentence: 'Am ___ câine.', answer: 'un', hint: '不定冠词（阳性）' },
    { sentence: 'Ea are ___ pisică.', answer: 'o', hint: '不定冠词（阴性）' },
    // ── 介词 ──
    { sentence: 'Mulțumesc ___ ajutor.', answer: 'pentru', hint: '为了 / 因为' },
    { sentence: 'Merg ___ școală.', answer: 'la', hint: '去（学校）' },
    { sentence: 'Locuiesc ___ București.', answer: 'în', hint: '在（城市）' },
    { sentence: 'Vorbesc ___ prietenii.', answer: 'cu', hint: '和/跟' },
    { sentence: 'Cumpăr ___ pâine.', answer: 'de', hint: '从/买（面包）' },
  ];

  let asked = 0;

  while (true) {
    const t = randomOf(templates);
    console.log(`  ${S.bold}${t.sentence}${S.reset}`);
    console.log(`  ${S.dim}提示  ${t.hint}${S.reset}`);
    process.stdout.write(`  ${S.dim}›${S.reset} `);
    const answer = await askText('', { escapeReturnsNull: true });
    if (answer === null) break;

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
  process.stdout.write([
    bar('错词复习'),
    '',
    `  ${S.dim}只练答错过的词，连对 2 次后毕业。${S.reset}`,
    `  ${S.dim}Esc 返回主菜单${S.reset}`,
    '',
  ].join('\n'));

  // 生词 = 答错过、且尚未连对两次的词
  const weakWords = () => Object.entries(ctx.progress.words)
    .filter(([, st]) => isWeak(st))
    .sort((a, b) => (b[1].w || 0) - (a[1].w || 0));

  if (weakWords().length === 0) {
    console.log(`  ${S.dim}没有需要复习的词，先去别的模式练练吧。${S.reset}`);
    await sleep(1500);
    return;
  }

  let asked = 0;

  while (true) {
    const list = weakWords();
    if (list.length === 0) {
      console.log(`  ${S.good}错词都巩固好了。${S.reset}`);
      await sleep(1200);
      break;
    }

    // 错得越多的越优先（前 10 个里随机，避免每次顺序完全一样）
    const [word, st] = randomOf(list.slice(0, 10));
    const missed = st.w || 0;
    const streak = st.c || 0;

    // 用中文释义提示，让用户回忆拼写；答错过的词才重点练
    const t = ctx.translations.get(word.toLowerCase());
    console.log(`  ${S.dim}曾错 ${missed} 次${streak ? ` · 已连对 ${streak} 次` : ''}${S.reset}`);
    if (t && t.zh && ctx.showTranslation) {
      process.stdout.write(`  ${S.accent}${t.zh}${S.reset}\n`);
    } else {
      process.stdout.write(`  ${S.dim}首字母「${word[0]}」，共 ${word.length} 个字母${S.reset}\n`);
    }
    process.stdout.write(`  ${S.dim}›${S.reset} `);
    const answer = await askText('', { escapeReturnsNull: true });
    if (answer === null) break;

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

// ============ 学习统计 ============
async function showStats(ctx) {
  const p = ctx.progress;
  const st = Object.values(p.words);
  const learned = st.filter(isLearned).length;
  const learning = st.filter(s => (s.c || 0) === 1).length;
  const weak = st.filter(isWeak).length;
  const total = p.totalCorrect + p.totalWrong;
  const uniqTotal = countUniqueWords(ctx.words, ctx.lemmas);
  const fresh = uniqTotal - st.length;
  const acc = total > 0 ? (p.totalCorrect / total * 100).toFixed(1) + '%' : '—';

  const out = [];
  out.push(bar('学习统计'));
  out.push('');
  out.push(`  ${S.dim}档案${S.reset}      ${p.name}`);
  out.push(`  ${S.dim}累计作答${S.reset}  ${total} 题`);
  out.push(`  ${S.dim}正确率${S.reset}    ${acc}`);
  out.push('');
  out.push(rule());
  out.push('');
  // 掌握进度条
  const barW = 30;
  const done = Math.round(learned / uniqTotal * barW);
  const meter = S.good + '█'.repeat(done) + S.reset +
                S.dim + '░'.repeat(barW - done) + S.reset;
  out.push(`  ${S.dim}掌握进度${S.reset}  ${meter}  ${learned}/${uniqTotal}`);
  out.push('');
  out.push(`  ${S.good}已掌握${S.reset}    ${padL(String(learned), 6)}  ${S.dim}连对 2 次以上${S.reset}`);
  out.push(`  ${S.accent}学习中${S.reset}    ${padL(String(learning), 6)}  ${S.dim}连对 1 次${S.reset}`);
  out.push(`  ${S.warn}待巩固${S.reset}    ${padL(String(weak), 6)}  ${S.dim}答错过，需重练${S.reset}`);
  out.push(`  ${S.dim}未练习${S.reset}    ${padL(String(fresh), 6)}${S.reset}`);
  out.push('');
  out.push(S.dim + '  Esc / 回车 返回' + S.reset);
  out.push('');

  clearScreen();
  process.stdout.write(out.join('\n'));

  // 等一个键（Esc 或回车）
  while (true) {
    const k = await readKey();
    if (k.name === 'escape' || k.name === 'enter' || k.name === 'char' ||
        k.name === 'ctrl-c') break;
  }
}

// ============ 档案界面 ============
function profileSummary(name) {
  const p = loadProfile(name);
  const total = p.totalCorrect + p.totalWrong;
  const learned = Object.values(p.words).filter(isLearned).length;
  return { total, learned };
}

// 首次运行：引导创建档案
async function createFirstProfile() {
  clearScreen();
  process.stdout.write([
    bar('新建学习档案'),
    '',
    `  第一次使用，先给自己起个名字。`,
    `  ${S.dim}不同档案的进度相互独立，适合多人共用一台电脑。${S.reset}`,
    '',
    `  ${S.dim}直接回车使用「${DEFAULT_PROFILE}」，Esc 取消${S.reset}`,
    '',
  ].join('\n'));
  const input = await askText(`  ${S.accent}档案名${S.reset} > `, { escapeReturnsNull: true });
  if (input === null) return null;
  const name = safeProfileName(input) || DEFAULT_PROFILE;
  const p = createProfile(name);
  process.stdout.write(`  ${S.good}已创建「${p.name}」${S.reset}\n`);
  await sleep(700);
  return p;
}

// 选择档案（启动时）：0 个 → 引导新建；1 个 → 直接进；多个 → 高亮选择
async function chooseProfile() {
  while (true) {
    const names = listProfiles();
    if (names.length === 0) {
      const p = await createFirstProfile();
      if (p) return p;
      continue;
    }
    if (names.length === 1) {
      const p = loadProfile(names[0]);
      saveProfile(p);
      return p;
    }

    const items = names.map(n => {
      const s = profileSummary(n);
      return { label: n, desc: `累计 ${s.total} 题 · 已掌握 ${s.learned} 词`, kind: 'pick', name: n };
    });
    items.push({ label: '新建档案', desc: '用新名字开始', kind: 'new' });

    const picked = await selectMenu(items, {
      header: [bar('选择学习档案'), '', `  ${S.dim}多个档案，选一个继续${S.reset}`, ''].join('\n'),
      footer: '↑↓ 选择 · 空格/回车 确认 · Esc 新建',
    });

    if (picked === null) {
      const p = await createFirstProfile();
      if (p) return p;
      continue;
    }
    if (picked.kind === 'new') {
      const p = await createFirstProfile();
      if (p) return p;
      continue;
    }
    const p = loadProfile(picked.name);
    saveProfile(p);
    return p;
  }
}

// 档案管理（主菜单进入）：新建 / 切换 / 删除
async function manageProfiles(ctx) {
  while (true) {
    const names = listProfiles();
    const items = names.map(n => {
      const s = profileSummary(n);
      const cur = n === ctx.progress.name ? ' ←当前' : '';
      return { label: n, desc: `累计 ${s.total} 题 · 已掌握 ${s.learned} 词${cur}`, kind: 'pick', name: n };
    });
    items.push({ label: '新建档案', desc: '用新名字开始', kind: 'new' });
    items.push({ label: '删除档案', desc: '删除前会二次确认', kind: 'del' });
    items.push({ label: '返回', desc: '', kind: 'back' });

    const picked = await selectMenu(items, {
      header: [bar('学习档案'), '', `  ${S.dim}当前：${ctx.progress.name}${S.reset}`, ''].join('\n'),
      footer: '↑↓ 选择 · 空格/回车 确认 · Esc 返回',
    });

    if (picked === null || picked.kind === 'back') return;

    if (picked.kind === 'pick') {
      if (picked.name === ctx.progress.name) return;
      saveProfile(ctx.progress);            // 先保存当前
      const p = loadProfile(picked.name);
      saveProfile(p);
      ctx.progress = p;
      currentProgress = p;
      return;
    }

    if (picked.kind === 'new') {
      clearScreen();
      process.stdout.write([bar('新建档案'), '', ''].join('\n'));
      const input = await askText(`  ${S.accent}档案名${S.reset} > `, { escapeReturnsNull: true });
      if (input === null) continue;
      const name = safeProfileName(input) || DEFAULT_PROFILE;
      if (names.includes(name)) {
        process.stdout.write(`  ${S.warn}「${name}」已存在${S.reset}\n`);
        await sleep(1000);
        continue;
      }
      saveProfile(ctx.progress);
      const p = createProfile(name);
      ctx.progress = p;
      currentProgress = p;
      process.stdout.write(`  ${S.good}已创建并切换到「${p.name}」${S.reset}\n`);
      await sleep(800);
      return;
    }

    if (picked.kind === 'del') {
      if (names.length <= 1) {
        clearScreen();
        process.stdout.write([bar('删除档案'), '',
          `  ${S.warn}至少要保留一个档案${S.reset}`, '',
          S.dim + '  Esc / 回车 返回' + S.reset, ''].join('\n'));
        while (true) {
          const k = await readKey();
          if (k.name === 'escape' || k.name === 'enter') break;
        }
        continue;
      }
      // 二次确认：先选要删的，再确认
      const delItems = names.map(n => ({
        label: n,
        desc: `${profileSummary(n).total} 题${n === ctx.progress.name ? ' · 当前档案' : ''}`,
        kind: 'target', name: n,
      }));
      delItems.push({ label: '取消', desc: '', kind: 'cancel' });
      const target = await selectMenu(delItems, {
        header: [bar('删除档案'), '', `  ${S.warn}选择要删除的档案${S.reset}`, ''].join('\n'),
        footer: '↑↓ 选择 · 空格/回车 确认 · Esc 取消',
      });
      if (!target || target.kind === 'cancel') continue;

      const name = target.name;
      const confirmItems = [
        { label: '取消', desc: '保留档案', kind: 'no' },
        { label: `删除「${name}」`, desc: '不可恢复', kind: 'yes' },
      ];
      const conf = await selectMenu(confirmItems, {
        header: [bar('确认删除'), '',
          `  ${S.warn}档案「${name}」及其全部学习进度将被删除，无法恢复。${S.reset}`, ''].join('\n'),
        footer: '↑↓ 选择 · 空格/回车 确认 · Esc 取消',
      });
      if (!conf || conf.kind === 'no') continue;

      const wasCurrent = name === ctx.progress.name;
      saveProfile(ctx.progress);            // 防止删除后 index 被覆盖
      if (deleteProfile(name)) {
        if (wasCurrent) {
          const rest = listProfiles();
          const p = rest.length ? loadProfile(rest[0]) : createProfile(DEFAULT_PROFILE);
          saveProfile(p);
          ctx.progress = p;
          currentProgress = p;
        }
      }
      continue;
    }
  }
}

// ============ 主菜单 ============
// 分组：练习在前，其他在后；用高亮选择而非数字键。
const MODES = [
  { label: '词汇拼写', desc: '高频词，看词拼写', run: modeFrequencyShoot },
  { label: '词形变化', desc: '给词根，写变形', run: modeGrammarVariants },
  { label: '听音拼写', desc: '听发音，写单词', run: modeListenSpell },
  { label: '句子填空', desc: '补全句子', run: modeSentenceBuild },
  { label: '错词复习', desc: '只练答错的词', run: modeReview },
];

function menuHeader(ctx) {
  const p = ctx.progress;
  const st = Object.values(p.words);
  const learned = st.filter(isLearned).length;
  const weak = st.filter(isWeak).length;
  const uniqTotal = countUniqueWords(ctx.words, ctx.lemmas);

  const out = [];
  out.push(bar('RomanianLearn v' + VERSION));
  out.push('');
  // 顶部信息压成两行两列
  out.push(`  ${S.dim}档案${S.reset}  ${pad(p.name, 20)}${S.dim}词库${S.reset}  ${uniqTotal} 词`);
  out.push(`  ${S.dim}正确${S.reset}  ${pad(String(p.totalCorrect), 20)}${S.dim}已掌握${S.reset}  ${learned} 词`);
  out.push('');
  return out.join('\n');
}

async function mainMenu() {
  const { words, lemmas, translations } = loadAll();

  // 首次运行：迁移旧版单文件进度
  migrateLegacy();
  // 选档案（多个时让用户选，只有一个直接进）
  const progress = await chooseProfile();

  const ctx = {
    words, lemmas, translations, progress,
    score: new ScoreTracker(), showTranslation: true,
  };
  currentProgress = progress;   // 供 SIGINT 处理器保存

  while (true) {
    const st = Object.values(progress.words);
    const weak = st.filter(isWeak).length;

    // 选项列表：5 个练习模式 + 3 个功能项
    const items = MODES.map(m => ({ ...m, kind: 'mode' }));
    items.push({ label: '学习统计', desc: '看掌握进度', kind: 'stats' });
    items.push({ label: '学习档案', desc: '新建 / 切换 / 删除', kind: 'profiles' });
    items.push({
      label: '翻译显示',
      desc: ctx.showTranslation ? '开' : '关',
      kind: 'toggle',
    });
    items.push({ label: '退出', desc: '', kind: 'quit' });

    const picked = await selectMenu(items, {
      header: menuHeader(ctx),
      footer: '↑↓ 选择 · 空格/回车 确认 · Esc 退出',
      initial: 0,
    });

    if (picked === null || picked.kind === 'quit') {
      saveProfile(progress);
      clearScreen();
      console.log(`\n  ${S.dim}La revedere!${S.reset}\n`);
      return;
    }

    if (picked.kind === 'toggle') {
      ctx.showTranslation = !ctx.showTranslation;
      continue;
    }

    if (picked.kind === 'stats') {
      await showStats(ctx);
      continue;
    }

    if (picked.kind === 'profiles') {
      await manageProfiles(ctx);
      continue;
    }

    await picked.run(ctx);
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
    try { if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch (e) { /* 忽略 */ }
    process.stdout.write(S.show + '\n\n  La revedere!\n\n');
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
