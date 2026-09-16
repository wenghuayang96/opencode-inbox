# opencode-inbox — opencode 多窗口会话完成收件箱

同时开多个 opencode 窗口开发多个项目时，**每个窗口干完活都会通知你**：菜单栏图标显示未读角标、系统通知带你最后一句提问与回复摘要且**点击直达收件箱**，收件箱里点一下就能跳回对应会话的终端窗口。

## 组成

两件套，通过本机 HTTP（`127.0.0.1:47832`）协作，均零第三方依赖：

| 组件 | 说明 |
|---|---|
| `plugin/session-inbox.ts` | opencode 插件（单文件 TS）。hook `session.idle` / `session.error`，抓取会话标题与最后一条 assistant 回复生成摘要，写入本机 JSON 收件箱；内置 HTTP 服务提供网页版收件箱 + API；App 不在线时兜底发 osascript 通知 |
| `app/main.swift` | macOS 菜单栏应用（纯 AppKit + UserNotifications）。轮询收件箱 → 发可点击系统通知（点击打开收件箱网页）→ 菜单栏托盘图标 + 未读数字角标；菜单内条目点击直接跳转会话窗口 |
| `app/icon-gen.swift` | 构建时自动生成应用图标（AppKit 绘制 → iconutil 转 .icns），无需图标素材文件 |
| `app/dev-identity.sh` | 一次性创建本地自签名代码签名证书（无需 Apple 开发者账号），固定签名身份，保证 Finder/启动台图标稳定 |

```
opencode 会话完成 ──▶ 插件写入 ~/.local/share/opencode/session-inbox.json
                          │
                          ▼
              插件 HTTP 服务 127.0.0.1:47832（任意存活实例托管，60s 心跳自动接管）
                          │
              ┌───────────┴───────────┐
              ▼                       ▼
     菜单栏 App（通知/角标/跳转）   网页收件箱（浏览器打开）
```

多实例设计：每个 opencode 进程都加载插件，端口竞争——抢到的当服务端，其余只轮询；服务端所在进程退出后，其余实例 60 秒内自动接管，无需人工干预。

## 安装

要求：macOS 13+、[opencode](https://opencode.ai)、Xcode Command Line Tools（`xcode-select --install`）。

```bash
git clone https://github.com/wenghuayang96/opencode-inbox.git
cd opencode-inbox

# 1. 安装插件
mkdir -p ~/.config/opencode/plugins
cp plugin/session-inbox.ts ~/.config/opencode/plugins/

# 2. （推荐）创建本地签名证书，首次签名时会弹钥匙串授权，点「始终允许」
chmod +x app/dev-identity.sh && app/dev-identity.sh

# 3. 编译安装菜单栏 App（自动生成图标）
chmod +x app/build.sh && app/build.sh

# 4. 重启所有已开着的 opencode 窗口（插件只在进程启动时加载）

# 5. 启动 App
open ~/Applications/OC收件箱.app
#    首次启动会请求通知权限，点「允许」
```

建议在 App 菜单中勾选「开机自动启动」。

## 使用

- **系统通知**：任何窗口的会话完成（每个回合都会提醒），弹带「你：<提问> + 摘要」的通知；点通知打开收件箱网页
- **菜单栏图标**：托盘样式图标 + 未读数；点开下拉菜单：最近条目（会话名 + 你：<提问> + 摘要 + 工作目录，点击跳回会话窗口并标已读）、打开网页、全部已读、清空
- **网页收件箱**：`http://127.0.0.1:47832`，可钉成浏览器标签页，2 秒自动刷新，标题带未读角标；每条显示会话名、你的提问、工作目录、摘要
- **跳转会话**：优先按窗口标题（`OC | <会话标题>`）聚焦已开终端窗口；找不到则新开 Ghostty 窗口 attach 该会话；都没有则回退 Terminal

## 配置

| 项 | 默认值 | 位置 |
|---|---|---|
| HTTP 端口 | 47832 | `plugin/session-inbox.ts` `PORT` |
| 收件箱容量 | 50 条 | `plugin/session-inbox.ts` `MAX_ITEMS` |
| 通知摘要长度 | 140 字符 | `plugin/session-inbox.ts` `NOTIFY_SUMMARY_MAX` |
| 存储摘要长度 | 400 字符 | `plugin/session-inbox.ts` `STORE_SUMMARY_MAX` |
| 通知声音 | Glass | `app/main.swift` `postNotification` |
| 菜单显示条数 | 12 | `app/main.swift` `maxMenuItems` |

`config/opencode-notifier.json` 是可选的协调配置：如果你同时使用 [mohak34/opencode-notifier](https://github.com/mohak34/opencode-notifier)，把它的 `complete`/`error` 弹窗关掉交给本插件，仅保留 `permission`/`question` 等即时提醒。复制到 `~/.config/opencode/opencode-notifier.json` 生效。

## 行为细节

- **多回合会话**：同一会话每完成一个回合都会重新通知并累计未读（菜单栏 App 以「会话 ID + 完成时间」判重）
- **防双弹**：App 存活心跳写在 `~/.local/share/opencode/oc-inbox-app.heartbeat`；插件发通知前检查心跳，App 在线就交给 App（可点击），离线则回退 osascript
- **单实例**：App 心跳文件记录 pid，重复启动自动退出
- **服务生命周期**：收件箱服务跟随 opencode 进程存活——所有窗口关闭时服务下线，网页会显示降级横幅并自动重试；任意窗口重新打开即恢复
- **子代理会话**：`parentID` 非空的子代理完成不单独提醒（避免噪音），只在主回合提醒
- **进程退出竞态**：`opencode run` 等短生命周期进程可能在 idle 事件后几百毫秒内退出，落盘若留在异步回调里记录会丢。插件在事件处理内同步完成「读-合并-写-改名」，只要执行到就不会丢；两条抓取请求（会话信息 + 消息）并行发出，压缩异步窗口

## 已知限制

- 跳转会话的「聚焦已有窗口」依赖辅助功能权限（系统设置 → 隐私与安全性 → 辅助功能，授权 Ghostty/Terminal）
- 通知权限被拒时 App 静默降级（日志见 `~/.local/share/opencode/oc-inbox-app.log`）
- 插件更新后需要重启 opencode 窗口才生效

## 隐私与安全

- 提问、回复摘要、项目路径和会话 ID 只保存在本机 `~/.local/share/opencode/session-inbox.json`
- HTTP 服务仅监听 `127.0.0.1:47832`，不向局域网或互联网开放；接口不设身份验证，因此不要通过反向代理对外暴露
- 系统通知可能在锁屏上显示提问和回复摘要；可在 macOS 通知设置中关闭锁屏预览

## 许可证

[MIT](LICENSE)

## 排障

| 现象 | 处理 |
|---|---|
| 菜单栏无图标 | `open ~/Applications/OC收件箱.app`；看 `~/.local/share/opencode/oc-inbox-app.log` |
| 网页打不开 | 所有 opencode 窗口都关了？开一个即恢复 |
| 通知不弹 | 系统设置 → 通知 → OC 收件箱 → 允许通知 |
| 跳转不聚焦 | 检查终端的辅助功能权限 |
