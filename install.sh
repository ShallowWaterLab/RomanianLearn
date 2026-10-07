#!/usr/bin/env bash
# RomanianLearn 安装脚本
# 一条命令安装：curl -fsSL <url>/install.sh | bash

set -e

INSTALL_DIR="${HOME}/.local/bin"
SCRIPT_NAME="romanianlearn"
REPO_URL="https://github.com/ShallowWaterLab/RomanianLearn"

echo "🇷🇴 RomanianLearn 安装程序"
echo "=============================="

# 检查 Node.js
if ! command -v node &>/dev/null; then
    echo "📦 安装 Node.js..."
    if command -v apt &>/dev/null; then
        sudo apt update && sudo apt install -y nodejs
    elif command -v yum &>/dev/null; then
        sudo yum install -y nodejs
    elif command -v brew &>/dev/null; then
        brew install node
    else
        echo "❌ 无法自动安装 Node.js，请手动安装后重试"
        exit 1
    fi
fi

echo "✅ Node.js $(node --version)"

# 检查 espeak（可选，用于听音识词）
if ! command -v espeak &>/dev/null; then
    echo "⚠️  espeak 未安装（听音识词功能将跳过发音）"
    echo "   安装: sudo apt install espeak"
fi

# 创建安装目录
mkdir -p "$INSTALL_DIR"

# 下载脚本
echo "📥 下载 RomanianLearn..."
TMP_FILE=$(mktemp)
curl -fsSL "${REPO_URL}/raw/main/RomanianLearn.js" -o "$TMP_FILE"

# 创建包装器
WRAPPER="${INSTALL_DIR}/${SCRIPT_NAME}"
cat > "$WRAPPER" << EOF
#!/usr/bin/env bash
# RomanianLearn 包装器
exec node "${INSTALL_DIR}/RomanianLearn.js" "\$@"
EOF
chmod +x "$WRAPPER"

# 移动脚本到安装目录
mv "$TMP_FILE" "${INSTALL_DIR}/RomanianLearn.js"
chmod +x "${INSTALL_DIR}/RomanianLearn.js"

# 检查 PATH
if [[ ":$PATH:" != *":${INSTALL_DIR}:"* ]]; then
    echo "⚠️  ${INSTALL_DIR} 不在 PATH 中"
    echo "   请添加: export PATH=\"${INSTALL_DIR}:\$PATH\""
    echo "   或运行: echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc"
fi

echo ""
echo "✅ 安装完成！"
echo "   运行: ${SCRIPT_NAME}"
echo "   或: node ${INSTALL_DIR}/RomanianLearn.js"
echo ""
echo "📝 注意：首次运行需要下载词库数据"
echo "   词库文件需放在脚本同目录下"
