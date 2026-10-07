#!/usr/bin/env bash
# RomanianLearn 安装脚本
# 用法：curl -fsSL https://raw.githubusercontent.com/ShallowWaterLab/RomanianLearn/master/install.sh | bash

set -e

REPO="ShallowWaterLab/RomanianLearn"
BRANCH="master"
RAW="https://raw.githubusercontent.com/${REPO}/${BRANCH}"
INSTALL_DIR="${HOME}/.local/share/romanianlearn"
BIN_DIR="${HOME}/.local/bin"
CMD_NAME="romanianlearn"

echo "🇷🇴 RomanianLearn 安装程序"
echo "=============================="

# ---------- 1. 检查 Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  # Debian/Ubuntu 包名是 nodejs，命令可能叫 nodejs 而非 node
  if command -v nodejs >/dev/null 2>&1; then
    mkdir -p "${BIN_DIR}"
    ln -sf "$(command -v nodejs)" "${BIN_DIR}/node"
    export PATH="${BIN_DIR}:$PATH"
    echo "ℹ️  已把 nodejs 链接为 node"
  else
    echo "❌ 未找到 Node.js。"
    echo "   请先安装 Node.js 18+："
    echo "     Ubuntu/Debian : sudo apt install nodejs"
    echo "     macOS         : brew install node"
    echo "     官网          : https://nodejs.org"
    exit 1
  fi
fi
echo "✅ Node.js $(node --version)"

# ---------- 2. 可选：espeak（听音识词用） ----------
if ! command -v espeak >/dev/null 2>&1; then
  echo "ℹ️  未安装 espeak —— 听音识词模式将改用首字母提示。"
  echo "   想听发音可稍后安装： sudo apt install espeak"
fi

# ---------- 3. 下载脚本 + 词库 ----------
echo "📥 下载主程序与词库..."
mkdir -p "${INSTALL_DIR}/data" "${BIN_DIR}"

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url"
  else
    echo "❌ 需要 curl 或 wget 来下载文件。"
    exit 1
  fi
}

download "${RAW}/RomanianLearn.js"   "${INSTALL_DIR}/RomanianLearn.js"
download "${RAW}/data/words.tsv"     "${INSTALL_DIR}/data/words.tsv"
download "${RAW}/data/lemmas.tsv"    "${INSTALL_DIR}/data/lemmas.tsv"

# ---------- 4. 生成启动命令 ----------
cat > "${BIN_DIR}/${CMD_NAME}" << EOF
#!/usr/bin/env bash
exec node "${INSTALL_DIR}/RomanianLearn.js" "\$@"
EOF
chmod +x "${BIN_DIR}/${CMD_NAME}"

# ---------- 5. 确保 PATH ----------
PATH_LINE="export PATH=\"${BIN_DIR}:\$PATH\""
if ! echo ":$PATH:" | grep -q ":${BIN_DIR}:"; then
  # 真的写进 shell 配置文件，而不只是打印提示
  added_to=""
  for rc in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
    [ -e "$rc" ] || continue
    if ! grep -qF "${BIN_DIR}" "$rc" 2>/dev/null; then
      printf '\n# added by RomanianLearn installer\n%s\n' "$PATH_LINE" >> "$rc"
      added_to="${added_to} ${rc}"
    fi
  done
  # 若三个文件都不存在，至少建一个 .profile
  if [ -z "$added_to" ]; then
    printf '\n# added by RomanianLearn installer\n%s\n' "$PATH_LINE" >> "${HOME}/.profile"
    added_to=" ${HOME}/.profile"
  fi
  export PATH="${BIN_DIR}:$PATH"
  echo ""
  echo "ℹ️  已把 ${BIN_DIR} 写入:${added_to}"
  echo "   当前终端已生效；新开终端也会生效。"
fi

echo ""
echo "✅ 安装完成！"
echo "   运行： ${CMD_NAME}"
echo ""
