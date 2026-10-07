# 🇷🇴 RomanianLearn — 罗马尼亚语学习工具

> 单文件 Node 脚本，一条命令跑。通过游戏化方式学习罗马尼亚语词汇和语法。

> A single-file Node.js script for learning Romanian through gamified vocabulary and grammar practice.

## ✨ 特性 / Features

- **🎯 频率射击** — 常见词快速浮出，输入字母消除（认词/反应速度）
- **📝 语法变体** — 同一词飘出不同词尾形态，全打对才消（词尾掌握）
- **🎧 听音识词** — 播放发音，玩家拼写（听觉+拼写）
- **🧩 句子拼装** — 先打关键词，再补全句子（语法搭配）
- **📚 生词复习** — 只刷之前打错的词（弱项巩固）

## 🚀 安装 / Install

### 方式一：一条命令安装 / One-line install

```bash
curl -fsSL https://github.com/ShallowWaterLab/RomanianLearn/raw/main/install.sh | bash
```

### 方式二：手动安装 / Manual install

```bash
git clone https://github.com/ShallowWaterLab/RomanianLearn.git
cd RomanianLearn
chmod +x RomanianLearn.js
./RomanianLearn.js
```

## 📋 依赖 / Dependencies

- **Node.js** 14+（必须 / required）
- **espeak**（可选，用于听音识词 / optional for audio pronunciation）

## 🎮 使用 / Usage

```bash
romanianlearn
# 或 / or
node RomanianLearn.js
```

启动后从主菜单选择模式，输入 `q` 返回主菜单，输入 `0` 退出。

## 📊 词库数据 / Word Data

词库基于 CoRoLa 语料库词频统计，包含 50000+ 常用词和词根。

词库文件需放在脚本同目录下：
- `corola_word_freq_gte10.tsv` — 词频（≥10 次）
- `corola_lemma_freq_gte10.tsv` — 词根频（≥10 次）

## 📄 License

MIT
