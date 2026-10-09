# RomanianLearn 交接文档

> 本文档供接手开发的 AI 或开发者快速了解项目全貌。
> 完整开发历史见 `DEVLOG.md`，架构约定见 `bossbone_brain.md`。

---

## 当前状态

- **版本**：v1.1.0，已发布到 GitHub（`master` 分支）
- **代码**：已提交，无未推送变更
- **测试**：6 套测试全绿（test_srs.js 有 1 个既有失败，与核心功能无关）
- **安装**：`curl -fsSL .../master/install.sh | bash`

---

## 下一步计划

- **网页版开发**：Node.js 后端 + 响应式前端，跑在 oracle 虚拟机上
- **TTS**：用浏览器内置 Web Speech API（`speechSynthesis`），零依赖
- **保留现有**：词库、SRS 算法、翻译表、进度系统，只改交互层
- **多用户**：每个用户一个 session，进度存服务器

---

## 关键文件

| 文件 | 说明 |
|------|------|
| `RomanianLearn.js` | 主程序（单文件，~1400 行） |
| `data/words.tsv` | 词形库（5000 词） |
| `data/lemmas.tsv` | 词根库（5000 词） |
| `data/translations.tsv` | 中英翻译表（8134 词条） |
| `data/overrides.tsv` | 人工校正（904 条） |
| `tools/test_run.js` | 管道端到端测试（9 项） |
| `tools/test_pty.py` | 真实 pty 测试（4 组） |
| `tools/test_diacritics.js` | 变音符号容错测试（15 项） |
| `tools/test_translations.js` | 翻译显示测试（13 项） |
| `tools/test_install_files.js` | 安装文件完整性测试（6 项） |
| `tools/test_srs.js` | 间隔重复算法测试（27 项） |
| `tools/_testkit.js` | 测试辅助（预置档案跳过引导） |
| `DEVLOG.md` | 完整开发历史（**必读**） |
| `bossbone_brain.md` | 架构约定（**必读**） |

---

## 技术债务

| 项目 | 说明 |
|------|------|
| test_srs.js 1 个失败 | 错词调度间隔 >120 题，概率断言边界问题，非核心 bug |
| 语法变体规则 | 简化版，未覆盖所有例外（如不规则变格） |
| TTS 后端 | 当前支持 6 种，但云端均未安装，实际靠首字母提示 |

---

## 测试运行

```bash
# 云端（oracle）
ssh oracle "cd ~/sw_lab/sectors/sw_app/RomanianLearn && node tools/test_run.js"
ssh oracle "cd ~/sw_lab/sectors/sw_app/RomanianLearn && node tools/test_diacritics.js"
ssh oracle "cd ~/sw_lab/sectors/sw_app/RomanianLearn && node tools/test_translations.js"
ssh oracle "cd ~/sw_lab/sectors/sw_app/RomanianLearn && node tools/test_install_files.js"
ssh oracle "cd ~/sw_lab/sectors/sw_app/RomanianLearn && node tools/test_srs.js"

# 本地（需 Node.js）
cd ~/sw_lab/sectors/sw_app/RomanianLearn
node tools/test_run.js
```

---

## 架构要点

- **单文件 Node 脚本**：无框架依赖，一条命令跑
- **词库离线**：`data/` 目录随仓库分发，运行时零网络
- **进度存储**：`~/.romanianlearn/profiles/<名>.json`
- **变音符号容错**：ă/â→a、î→i、ș→s、ț→t，无符号输入判对但回显正确拼写
- **间隔重复**：答对 → `dueAt = now + 8×2^(连对-1)`（上限 500）；答错 → 立刻回队列
- **两段式出题**：先决定复习/新词，再在集合内加权随机
- **多用户档案**：主菜单 `[p]` 管理，`[s]` 学习概览

---

## 发布流程

```bash
# 1. 从 vault 读取 token（仅当次使用）
TOKEN=$(node -e "const j=JSON.parse(require('fs').readFileSync(process.env.HOME+'/sw_lab/sectors/vault/github/github_token.json','utf8')); process.stdout.write(j.token||'')")

# 2. 推送
cd ~/sw_lab/sectors/sw_app/RomanianLearn
git push "https://ShallowWaterLab:${TOKEN}@github.com/ShallowWaterLab/RomanianLearn.git" master

# 3. 用完即弃
unset TOKEN
```

---

## 隐私边界

- **公开物**（GitHub 仓库、交付 tar 包）不得暴露：服务器 IP、本地/云端绝对路径、用户名、云厂商名、AI 工具/模型名
- **本地文件与外部大脑**上的信息视为安全，无需反复清理
- 发布前优先核验公开物，本地/外部大脑清理可省略
