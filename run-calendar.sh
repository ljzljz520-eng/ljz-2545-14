#!/usr/bin/env bash
# 启动“季节年历”服务（Python 3 标准库，零依赖），同时托管前端与 API。
set -euo pipefail
cd "$(dirname "$0")"
export PORT="${PORT:-8090}"
# 如需确定性演示/回放，可固定当前时刻：
# export CALENDAR_NOW="2026-10-01T00:00:00Z"
exec python3 server/app.py
