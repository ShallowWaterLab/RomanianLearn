# 🇷🇴 RomanianLearn — 罗马尼亚语学习工具

> 单文件 Node 脚本，一条命令跑。通过游戏化方式学习罗马尼亚语词汇和语法。

> A single-file Node.js script for learning Romanian through gamified vocabulary and grammar practice.

## ✨ 特性 / Features

- **🎯 频率射击** — 常见词按频次加权浮出，输入拼写（认词 / 反应速度）
- **📝 语法变体** — 给定词根和词尾，写出完整变形（词尾掌握）
- **🎧 听音识词** — 播放发音，玩家拼写；无 espeak 时降级为首字母提示（听觉 + 拼写）
- **🧩 句子拼装** — 补全句子中缺失的单词（语法搭配）
- **📚 生词复习** — 只刷答错过的词，连对后间隔拉长（弱项巩固）
- **⌨️ 变音符号容错** — 普通键盘打不出 ă â î ș ț，用 a i s t 输入同样判对（[详见下文](#-关于变音符号--typing-diacritics)）
- **📖 中英双语翻译** — 每次给出答案时附带中文和英文释义（可在主菜单按 `t` 开关）
- **🧠 智能复习（间隔重复）** — 答对的词**不会消失**，而是间隔逐渐拉长后再出现；答错的词立刻回到近期队列
- **👤 多用户档案** — 每人一份独立进度，可新建 / 切换 / 删除
- **📊 学习概览** — 已掌握 / 学习中 / 待巩固 / 尚未练习的词数统计

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

首次运行会让你**给自己起个档案名**（不同人各自独立进度）。

### 🧠 复习机制（间隔重复）/ Spaced repetition

答对的词**不会消失**——它会被安排一个"下次出现的时间"，间隔随连对次数逐次拉长：

| 连对次数 | 大约隔多少题再出现 |
|---|---|
| 答错 | 下一题就可能出现 |
| 1 次 | 8 题 |
| 2 次 | 16 题 |
| 3 次 | 32 题 |
| 4 次 | 64 题 |
| 5 次以上 | 最多 500 题 |

**为什么这样设计**：如果答对就再也不出现，过几天忘了就永远想不起来；如果所有词都反复出现，时间又浪费在已经会的词上。间隔重复让"会的词少出现、不会的词多出现"，同时**保证每个词迟早都会再来一次**——这正是防遗忘的关键。

答错的词优先级最高，**在任何模式下都会优先出现**（不只是「生词复习」）。

无符号输入（`sau` 代替 `său`）算对，但间隔按较短的来——毕竟还没真正掌握拼写。

### 👤 用户档案 / Profiles

进度按档案分开保存，适合多人共用一台电脑：

```
~/.romanianlearn/profiles/<档案名>.json
```

- 启动时：只有一个档案直接进；有多个则列出让你选
- 主菜单 `[p]`：新建 / 切换 / 删除档案（删除需二次确认，且不会删到零个）
- 主菜单 `[s]`：查看学习概览（已掌握 / 学习中 / 待巩固 / 尚未练习）
- 从旧版本升级：原来的 `progress.json` 会自动迁移成「默认」档案，进度不丢

### 📖 翻译 / Translations

每次给出答案时，自动附带中文和英文释义：

```
  🎯 autoritate
  ✏️  > autoritate
  ✅ 正确！
  📖 中文：权威　｜　英文：authority
```

答对答错都会显示，帮助建立词义关联。不想要可以按 `t` 关掉。

翻译表**在构建时预生成并打包进仓库**（`data/translations.tsv`，8134 词条，约 390 KB），
所以运行时**不需要联网**、瞬时响应，也不依赖任何翻译 API 的可用性。

词库中**每一个词条都有中英释义，零遗漏**。生成方式为完全离线的两级管线：

| 步骤 | 数据源 | 作用 |
|---|---|---|
| 1 | [kaikki.org](https://kaikki.org/) 罗马尼亚语维基词典（CC BY-SA） | 罗语 → 英文义项，含词性、词形还原（`legii` → `lege`） |
| 2 | [ECDICT](https://github.com/skywind3000/ECDICT) 英汉词典（MIT） | 英文义项 → 中文，按词性匹配（`oficial` 形容词取"官方的"而非名词"官员"） |
| 3 | `data/overrides.tsv` 人工校正 | 覆盖最高频词与例外 |

机器释义在**最高频的虚词**上错得最离谱（`mai` 会取到"五月"、`se` 取到"硒"、`lei` 取到"雷"），
而这些恰是学习者最先碰到的词，因此对高频词做了 850+ 条人工校正，并统一为**口语化写法**
（写"…的（复数）"而不是"（阴性复数所有格）…的"）。

重新生成翻译表（需要 kaikki 罗语词典与 ECDICT，见脚本头部说明）：

```bash
python3 tools/build_translations_v2.py <工作目录>
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
node tools/test_run.js          # 管道驱动：出题判定、计分落盘、生词移除、缺词库报错
python3 tools/test_pty.py       # 真实终端驱动：按键回显、模式切换、完整回合、Ctrl+C 退出
node tools/test_diacritics.js   # 变音符号容错：折叠函数 + 无符号输入判对并回显
node tools/test_translations.js # 翻译：覆盖率、高频虚词校正、口语化无术语、答对显示、t 开关
node tools/test_install_files.js # 安装完整性：程序读的每个 data/ 文件都在 install.sh 下载清单里
node tools/test_srs.js          # 间隔重复 + 档案：间隔计算、防遗忘、错词优先、档案隔离/删除
```

六套都全绿才算通过（退出码 0）。

> 回显类问题（如"按一次键出两个字母"）**只能**用 pty 测试发现：stdin 不是终端时 readline 不做回显，管道测不出来。

## 📄 License

MIT
