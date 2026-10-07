#!/usr/bin/env node
/**
 * RomanianLearn — 罗马尼亚语学习工具
 * 单文件 Node 脚本，一条命令跑
 * 
 * 玩法模块：
 *   1. 频率射击 — 常见词快速浮出，输入字母消除
 *   2. 语法变体 — 同一词飘出不同词尾形态
 *   3. 听音识词 — 播放发音，玩家拼写
 *   4. 句子拼装 — 先打关键词，再补全句子
 *   5. 生词复习 — 只刷之前打错的词
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync, spawn } = require('child_process');

// ============ 配置 ============
const DATA_DIR = path.join(__dirname);
const WORD_FREQ_FILE = path.join(DATA_DIR, 'corola_word_freq_gte10.tsv');
const LEMMA_FREQ_FILE = path.join(DATA_DIR, 'corola_lemma_freq_gte10.tsv');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const MAX_WORD_LEN = 30;
const MIN_WORD_LEN = 3;

// ============ 词库加载 ============
function loadWordFreq(filePath, limit = 50000) {
  const words = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const parts = line.trim().split('\t');
    if (parts.length >= 2) {
      const word = parts[0].trim();
      const freq = parseInt(parts[1], 10);
      if (word && freq > 0 && word.length >= MIN_WORD_LEN && word.length <= MAX_WORD_LEN) {
        words.push({ word, freq });
      }
    }
    if (words.length >= limit) break;
  }
  return words;
}

function loadLemmaFreq(filePath, limit = 50000) {
  const lemmas = [];
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  for (const line of lines) {
    const parts = line.trim().split('\t');
    if (parts.length >= 2) {
      const lemma = parts[0].trim();
      const freq = parseInt(parts[1], 10);
      if (lemma && freq > 0 && lemma.length >= MIN_WORD_LEN && lemma.length <= MAX_WORD_LEN) {
        lemmas.push({ lemma, freq });
      }
    }
    if (lemmas.length >= limit) break;
  }
  return lemmas;
}

// ============ 进度保存 ============
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return { wrongWords: {}, totalCorrect: 0, totalWrong: 0, sessions: 0 };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), 'utf-8');
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
    return total === 0 ? 0 : (this.correct / total * 100).toFixed(1);
  }
  display() {
    console.log(`  ✅ ${this.correct}  ❌ ${this.wrong}  🔥 ${this.streak}  📊 ${this.accuracy}%`);
  }
}

// ============ 终端工具 ============
function clearScreen() {
  console.clear();
}

function printHeader(title) {
  const width = 50;
  console.log('═'.repeat(width));
  console.log(`  ${title}`);
  console.log('═'.repeat(width));
}

function printMenu(items) {
  console.log();
  items.forEach((item, i) => {
    console.log(`  [${i + 1}] ${item}`);
  });
  console.log(`  [0] 退出`);
  console.log();
}

function askQuestion(rl, question) {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

// ============ 游戏模块 ============

// 模块 1: 频率射击
async function modeFrequencyShoot(words, progress, score) {
  clearScreen();
  printHeader('🎯 频率射击 — 常见词快速浮出');
  console.log('  输入字母消除飘出的单词，按 Enter 确认');
  console.log('  输入 q 返回主菜单\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = true;

  while (running) {
    // 随机选一个词
    const target = words[Math.floor(Math.random() * words.length)];
    const word = target.word;
    let input = '';

    console.log(`\n  🎯 目标词: ${word}`);
    process.stdout.write('  ✏️  输入: ');

    // 读取用户输入
    const answer = await new Promise(resolve => {
      const onData = (data) => {
        const str = data.toString();
        if (str.includes('\n') || str.includes('\r')) {
          process.stdin.removeListener('data', onData);
          resolve(input);
        } else if (str === '\x7f' || str === '\b') {
          input = input.slice(0, -1);
          process.stdout.write('\b \b');
        } else if (str.length === 1 && /[a-zăâîșț]/i.test(str)) {
          input += str.toLowerCase();
          process.stdout.write(str.toLowerCase());
        }
      };
      process.stdin.on('data', onData);
      process.stdin.setRawMode(true);
      process.stdin.resume();
    });

    process.stdin.setRawMode(false);

    if (answer.toLowerCase() === 'q') {
      running = false;
      break;
    }

    if (answer.toLowerCase() === word.toLowerCase()) {
      console.log('  ✅ 正确!');
      score.hit();
      progress.totalCorrect++;
    } else {
      console.log(`  ❌ 错误! 正确答案: ${word}`);
      score.miss();
      progress.totalWrong++;
      progress.wrongWords[word] = (progress.wrongWords[word] || 0) + 1;
    }
    score.display();
  }

  rl.close();
  saveProgress(progress);
}

// 模块 2: 语法变体
async function modeGrammarVariants(lemmas, progress, score) {
  clearScreen();
  printHeader('📝 语法变体 — 词尾变形挑战');
  console.log('  输入正确的词尾变体形式');
  console.log('  输入 q 返回主菜单\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = true;

  // 罗语常见词尾变化规则
  const variants = [
    { suffix: 'a', hint: '阴性单数定冠词' },
    { suffix: 'i', hint: '复数' },
    { suffix: 'e', hint: '阴性复数' },
    { suffix: 'ul', hint: '阳性单数定冠词' },
    { suffix: 'ului', hint: '阳性单数与格' },
  ];

  while (running) {
    const target = lemmas[Math.floor(Math.random() * lemmas.length)];
    const lemma = target.lemma;
    const variant = variants[Math.floor(Math.random() * variants.length)];
    const answer = lemma + variant.suffix;

    console.log(`\n  📝 词根: ${lemma}`);
    console.log(`  💡 提示: ${variant.hint}`);
    process.stdout.write('  ✏️  完整形式: ');

    const userAnswer = await askQuestion(rl, '');

    if (userAnswer.toLowerCase() === 'q') {
      running = false;
      break;
    }

    if (userAnswer.toLowerCase().trim() === answer.toLowerCase()) {
      console.log('  ✅ 正确!');
      score.hit();
      progress.totalCorrect++;
    } else {
      console.log(`  ❌ 错误! 正确答案: ${answer}`);
      score.miss();
      progress.totalWrong++;
      progress.wrongWords[answer] = (progress.wrongWords[answer] || 0) + 1;
    }
    score.display();
  }

  rl.close();
  saveProgress(progress);
}

// 模块 3: 听音识词
async function modeListenSpell(words, progress, score) {
  clearScreen();
  printHeader('🎧 听音识词 — 听发音拼写');
  console.log('  播放发音后输入你听到的单词');
  console.log('  输入 q 返回主菜单\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = true;

  while (running) {
    const target = words[Math.floor(Math.random() * words.length)];
    const word = target.word;

    // 尝试使用 espeak 播放发音
    try {
      execSync(`espeak -v ro "${word}" 2>/dev/null`, { stdio: 'ignore' });
    } catch (e) {
      console.log('  ⚠️  espeak 未安装，跳过发音');
    }

    console.log(`\n  🎧 请听发音...`);
    process.stdout.write('  ✏️  你听到的单词: ');

    const userAnswer = await askQuestion(rl, '');

    if (userAnswer.toLowerCase() === 'q') {
      running = false;
      break;
    }

    if (userAnswer.toLowerCase().trim() === word.toLowerCase()) {
      console.log('  ✅ 正确!');
      score.hit();
      progress.totalCorrect++;
    } else {
      console.log(`  ❌ 错误! 正确答案: ${word}`);
      score.miss();
      progress.totalWrong++;
      progress.wrongWords[word] = (progress.wrongWords[word] || 0) + 1;
    }
    score.display();
  }

  rl.close();
  saveProgress(progress);
}

// 模块 4: 句子拼装
async function modeSentenceBuild(words, progress, score) {
  clearScreen();
  printHeader('🧩 句子拼装 — 补全句子');
  console.log('  输入缺失的单词补全句子');
  console.log('  输入 q 返回主菜单\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = true;

  // 简单句子模板
  const templates = [
    { sentence: 'Eu ___ în România.', answer: 'locuiesc', hint: '居住' },
    { sentence: 'Ea ___ o carte.', answer: 'citește', hint: '读' },
    { sentence: 'Noi ___ la școală.', answer: 'mergem', hint: '去' },
    { sentence: 'Tu ___ foarte bine.', answer: 'cânti', hint: '唱' },
    { sentence: 'Ei ___ în parc.', answer: 'aleargă', hint: '跑' },
  ];

  while (running) {
    const template = templates[Math.floor(Math.random() * templates.length)];

    console.log(`\n  🧩 句子: ${template.sentence}`);
    console.log(`  💡 提示: ${template.hint}`);
    process.stdout.write('  ✏️  缺失的单词: ');

    const userAnswer = await askQuestion(rl, '');

    if (userAnswer.toLowerCase() === 'q') {
      running = false;
      break;
    }

    if (userAnswer.toLowerCase().trim() === template.answer.toLowerCase()) {
      console.log('  ✅ 正确!');
      score.hit();
      progress.totalCorrect++;
    } else {
      console.log(`  ❌ 错误! 正确答案: ${template.answer}`);
      score.miss();
      progress.totalWrong++;
      progress.wrongWords[template.answer] = (progress.wrongWords[template.answer] || 0) + 1;
    }
    score.display();
  }

  rl.close();
  saveProgress(progress);
}

// 模块 5: 生词复习
async function modeReview(progress, score) {
  clearScreen();
  printHeader('📚 生词复习 — 弱项巩固');
  console.log('  只刷之前打错的词');
  console.log('  输入 q 返回主菜单\n');

  const wrongWords = Object.entries(progress.wrongWords);
  if (wrongWords.length === 0) {
    console.log('  🎉 没有生词需要复习！');
    await new Promise(r => setTimeout(r, 2000));
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let running = true;

  while (running) {
    // 按错误次数排序，优先复习错误多的
    wrongWords.sort((a, b) => b[1] - a[1]);
    const [word, count] = wrongWords[Math.floor(Math.random() * Math.min(10, wrongWords.length))];

    console.log(`\n  📚 生词: ${word} (错误 ${count} 次)`);
    process.stdout.write('  ✏️  拼写: ');

    const userAnswer = await askQuestion(rl, '');

    if (userAnswer.toLowerCase() === 'q') {
      running = false;
      break;
    }

    if (userAnswer.toLowerCase().trim() === word.toLowerCase()) {
      console.log('  ✅ 正确! 该词已从生词本移除');
      score.hit();
      progress.totalCorrect++;
      delete progress.wrongWords[word];
    } else {
      console.log(`  ❌ 错误! 正确答案: ${word}`);
      score.miss();
      progress.totalWrong++;
    }
    score.display();
  }

  rl.close();
  saveProgress(progress);
}

// ============ 主菜单 ============
async function mainMenu() {
  const words = loadWordFreq(WORD_FREQ_FILE, 50000);
  const lemmas = loadLemmaFreq(LEMMA_FREQ_FILE, 50000);
  const progress = loadProgress();
  const score = new ScoreTracker();

  console.log(`\n  已加载 ${words.length} 个常用词, ${lemmas.length} 个词根`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    clearScreen();
    printHeader('🇷🇴 RomanianLearn — 罗马尼亚语学习工具');
    console.log(`  总正确: ${progress.totalCorrect}  总错误: ${progress.totalWrong}  生词: ${Object.keys(progress.wrongWords).length}`);
    console.log();
    printMenu([
      '🎯 频率射击 — 常见词快速浮出',
      '📝 语法变体 — 词尾变形挑战',
      '🎧 听音识词 — 听发音拼写',
      '🧩 句子拼装 — 补全句子',
      '📚 生词复习 — 弱项巩固',
    ]);

    const choice = await askQuestion(rl, '  请选择: ');

    switch (choice) {
      case '1': await modeFrequencyShoot(words, progress, score); break;
      case '2': await modeGrammarVariants(lemmas, progress, score); break;
      case '3': await modeListenSpell(words, progress, score); break;
      case '4': await modeSentenceBuild(words, progress, score); break;
      case '5': await modeReview(progress, score); break;
      case '0':
        console.log('\n  再见! La revedere! 👋\n');
        rl.close();
        process.exit(0);
      default:
        console.log('  无效选择，请重试');
        await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ============ 启动 ============
if (require.main === module) {
  mainMenu().catch(err => {
    console.error('发生错误:', err);
    process.exit(1);
  });
}

module.exports = { loadWordFreq, loadLemmaFreq, loadProgress, saveProgress, ScoreTracker };
