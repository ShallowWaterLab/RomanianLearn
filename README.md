# 🇷🇴 RomanianLearn — 罗马尼亚语学习工具

> 单文件 Node 脚本，一条命令跑。通过游戏化方式学习罗马尼亚语词汇和语法。

> A single-file Node.js script for learning Romanian through gamified vocabulary and grammar practice.

## ✨ 特性 / Features

- **🎯 频率射击** — 常见词按频次加权浮出，输入拼写（认词 / 反应速度）
- **📝 语法变体** — 给定词根和词尾，写出完整变形（词尾掌握）
- **🎧 听音识词** — 播放发音，玩家拼写；无 espeak 时降级为首字母提示（听觉 + 拼写）
- **🧩 句子拼装** — 补全句子中缺失的单词（语法搭配）
- **📚 生词复习** — 只刷之前打错的词，答对即移出生词本（弱项巩固）
- **⌨️ 变音符号容错** — 普通键盘打不出 ă â î ș ț，用 a i s t 输入同样判对（[详见下文](#-关于变音符号--typing-diacritics)）
- **📖 中英双语翻译** — 每次给出答案时附带中文和英文释义（可在主菜单按 `t` 开关）

## 🚀 安装 / Install

### 方式一：一条命令安装 / One-line install

```bash
curl -fsSL https://raw.githubusercontent.com/ShallowWaterLab/RomanianLearn/master/install.sh | bash
```

安装后运行 `romanianlearn`（如提示 PATH 问题，按脚本提示把 `~/.local/bin` 加入 PATH）。

### 方式二：克隆后直接运行 / Clone and run

```bash
git clone https://github.com/ShallowWaterLab/RomanianLearn.git
cd RomanianLearn
node RomanianLearn.js
```

## 📋 依赖 / Dependencies

- **Node.js** 18+（必须 / required）
- **espeak**（可选，用于听音识词发音 / optional for pronunciation）

```bash
# Ubuntu / Debian
sudo apt install nodejs espeak
```

## 🎮 使用 / Usage

```bash
romanianlearn
# 或 / or
node RomanianLearn.js
```

启动后从主菜单选择模式；游戏中输入 `q` 返回主菜单，主菜单输入 `0` 退出，输入 `t` 切换翻译显示。

学习进度保存在 `~/.romanianlearn/progress.json`，不会污染安装目录。

### 📖 翻译 / Translations

每次给出答案时，自动附带中文和英文释义：

```
  🎯 autoritate
  ✏️  > autoritate
  ✅ 正确！
  📖 中文：权威　｜　英文：authority
```

答对答错都会显示，帮助建立词义关联。不想要可以按 `t` 关掉。

翻译表**在构建时预生成并打包进仓库**（`data/translations.tsv`，8134 词条，约 205 KB），
所以运行时**不需要联网**、瞬时响应，也不依赖任何翻译 API 的可用性。

高频虚词（`mai`、`se`、`al`、`este` 等）由 `data/overrides.tsv` 人工校正——
机器翻译对脱离语境的虚词很不准（`mai` 会被译成"五月"、`se` 译成"硒"）。

重新生成翻译表：

```bash
python3 tools/build_translations.py data   # 调用翻译 API 生成
python3 tools/apply_overrides.py data      # 叠加人工校正
```

### ⌨️ 关于变音符号 / Typing diacritics

罗马尼亚语有 5 个变音符号：**ă â î ș ț**，普通键盘打不出来。所以本工具**自动容错**——直接用基本字母输入即可：

| 你要拼的词 | 可以这样输入 |
|---|---|
| `său` | `sau` |
| `în` | `in` |
| `țară` | `tara` |
| `București` | `bucuresti` |

判对后会把**正确拼写显示出来**，帮你记住变音符号：

```
  ✅ 正确！（无符号输入）正确拼写：său
```

> ⚠️ 代价：少数词去掉符号后无法互相区分（`sau`/`său`、`ca`/`că`、`data`/`dată`），
> 输入无符号形式时两者都算对。5000 词中有 176 组这样的情况。

## 📊 词库数据 / Word Data

仓库自带一份精简词库（`data/`，约 150 KB，各 5000 词），克隆即可用：

| 文件 | 内容 |
|---|---|
| `data/words.tsv` | 常用词形 + 频次 |
| `data/lemmas.tsv` | 词根 + 频次 |
| `data/translations.tsv` | 中英翻译（构建时生成） |
| `data/overrides.tsv` | 高频虚词的人工校正 |

词库源自 **CoRoLa** 罗马尼亚语语料库词频统计，经脚本清洗（仅保留罗语字母、按小写去重、长度 2–20）。

想用更大的词库？把完整 CoRoLa 文件放到脚本同目录，脚本会优先使用 `data/`，找不到时才回退：

- `corola_word_freq_gte10.tsv`
- `corola_lemma_freq_gte10.tsv`

重新生成内置词库：

```bash
python3 tools/build_wordlist.py <CoRoLa目录> data 5000
```

## 🧪 测试 / Tests

```bash
node tools/test_run.js         # 管道驱动：出题判定、计分落盘、生词移除、缺词库报错
python3 tools/test_pty.py      # 真实终端驱动：按键回显、模式切换、完整回合、Ctrl+C 退出
node tools/test_diacritics.js  # 变音符号容错：折叠函数 + 无符号输入判对并回显
node tools/test_translations.js # 翻译：覆盖率、高频虚词校正、答对显示、t 开关
```

四套都全绿才算通过（退出码 0）。

> 回显类问题（如"按一次键出两个字母"）**只能**用 pty 测试发现：stdin 不是终端时 readline 不做回显，管道测不出来。

## 📄 License

MIT
