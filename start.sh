#!/bin/bash
cd "$(dirname "$0")"
echo "Starting xiaomubiao server..."
echo ""
echo "Environment:"
echo "  PORT: ${PORT:-3000}"
echo "  WX_APPID: ${WX_APPID:-not set}"
echo "  WX_APPSECRET: ${WX_APPSECRET:+set}${WX_APPSECRET:-not set}"
echo "  ALIYUN_SMS: ${ALIYUN_ACCESS_KEY_ID:+configured}${ALIYUN_ACCESS_KEY_ID:-mock mode}"
echo ""
node src/index.js
