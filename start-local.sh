#!/bin/bash
# 本地预览博客脚本
# 使用方法: 双击运行 或 在终端执行 bash start-local.sh
# 线上地址: https://gxfdev.github.io

echo "🚀 启动博客本地预览..."
echo "📂 博客地址: http://localhost:8080"
echo "🌐 线上地址: https://gxfdev.github.io"
echo "⏹ 按 Ctrl+C 停止服务器"
echo ""

# 获取脚本所在目录
DIR="$( cd "$( dirname "$0" )" && pwd )"
cd "$DIR"

# 启动本地HTTP服务器
python3 -m http.server 8080 2>/dev/null || python -m SimpleHTTPServer 8080 2>/dev/null || {
  echo "❌ 需要安装 Python 才能本地预览"
  echo "或者直接把 blog 文件夹上传到 GitHub Pages"
}
