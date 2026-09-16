#!/bin/bash
# 一次性创建本地代码签名证书 OCInbox Dev
# ad-hoc 签名每次构建身份都变，macOS 通知守护进程对不上号，横幅会显示空图标；
# 固定证书身份后图标稳定显示。仅本机有效，无需苹果开发者账号。
set -euo pipefail

if security find-identity -p codesigning | grep -q '"OCInbox Dev"'; then
  echo "OCInbox Dev 证书已存在，无需创建"
  exit 0
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
# 密码仅用于导入钥匙串，证书私钥保存在本机登录钥匙串中
/usr/bin/openssl req -x509 -newkey rsa:2048 -keyout "$TMP/k.pem" -out "$TMP/c.pem" \
  -days 3650 -nodes -subj "/CN=OCInbox Dev" \
  -addext "keyUsage=digitalSignature" -addext "extendedKeyUsage=codeSigning"
/usr/bin/openssl pkcs12 -export -out "$TMP/dev.p12" -inkey "$TMP/k.pem" -in "$TMP/c.pem" -passout pass:ocinbox-local
security import "$TMP/dev.p12" -k ~/Library/Keychains/login.keychain-db -T /usr/bin/codesign -P ocinbox-local
echo "✅ 已导入 OCInbox Dev 签名证书"
echo "   首次用它签名时若弹出钥匙串授权框，点「始终允许」"
