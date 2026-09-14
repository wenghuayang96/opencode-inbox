#!/bin/bash
# 编译并安装 OC 收件箱菜单栏应用到 ~/Applications
set -euo pipefail
cd "$(dirname "$0")"

swiftc -O main.swift -o OCInbox

APP="$HOME/Applications/OC收件箱.app"
mkdir -p "$APP/Contents/MacOS"
cp OCInbox "$APP/Contents/MacOS/OCInbox"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>OCInbox</string>
	<key>CFBundleIdentifier</key><string>com.wenghuayang.oc-inbox</string>
	<key>CFBundleName</key><string>OC 收件箱</string>
	<key>CFBundleDisplayName</key><string>OC 收件箱</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>LSUIElement</key><true/>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
EOF

codesign --force -s - "$APP"

echo "✅ 安装完成: $APP"
echo "   首次启动: open \"$APP\"，并在弹窗中允许通知权限"
