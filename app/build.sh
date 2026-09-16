#!/bin/bash
# 编译并安装 OC 收件箱菜单栏应用到 ~/Applications
set -euo pipefail
cd "$(dirname "$0")"

swiftc -O main.swift -o OCInbox

# 生成应用图标：iconset → icns（无需素材文件，绘制脚本自动生成）
rm -rf AppIcon.iconset
mkdir -p AppIcon.iconset
swift icon-gen.swift AppIcon.iconset

APP="$HOME/Applications/OC收件箱.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp OCInbox "$APP/Contents/MacOS/OCInbox"
iconutil -c icns AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
# 通知附件用的 PNG（横幅图标走附件才稳定显示）
cp AppIcon.iconset/icon_256x256.png "$APP/Contents/Resources/NotifyIcon.png"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>OCInbox</string>
	<key>CFBundleIdentifier</key><string>com.wenghuayang.opencode-inbox</string>
	<key>CFBundleName</key><string>OC 收件箱</string>
	<key>CFBundleDisplayName</key><string>OC 收件箱</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.1</string>
	<key>CFBundleVersion</key><string>2</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF

# 签名：优先使用本地开发证书（身份稳定，通知横幅才能显示应用图标），
# 找不到时回退 ad-hoc。首次创建证书: ./dev-identity.sh
if security find-identity -p codesigning | grep -q '"OCInbox Dev"'; then
  codesign --force --timestamp=none -s "OCInbox Dev" "$APP"
  echo "已使用 OCInbox Dev 证书签名"
else
  codesign --force -s - "$APP"
  echo "⚠️ 未找到 OCInbox Dev 证书（可运行 app/dev-identity.sh 创建），回退 ad-hoc 签名，通知可能显示空图标"
fi

echo "✅ 安装完成: $APP"
echo "   首次启动: open \"$APP\"，并在弹窗中允许通知权限"
