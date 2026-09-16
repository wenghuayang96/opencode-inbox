// OC 收件箱 — opencode 会话完成通知的菜单栏常驻应用
// 轮询插件内置服务 http://127.0.0.1:47832，新完成的会话弹系统通知（可点击），
// 菜单栏图标显示未读数，菜单可直接跳转会话窗口。
// 编译: swiftc -O -framework AppKit -framework UserNotifications main.swift -o OCInbox

import AppKit
import UserNotifications
import ServiceManagement

// MARK: - 常量

let apiBase = URL(string: "http://127.0.0.1:47832")!
let logPath = NSString(string: "~/.local/share/opencode/oc-inbox-app.log").expandingTildeInPath
let heartbeatPath = NSString(string: "~/.local/share/opencode/oc-inbox-app.heartbeat").expandingTildeInPath
let dashboardURL = apiBase

// MARK: - 日志

func log(_ msg: String) {
    let line = "[\(ISO8601DateFormatter().string(from: Date()))] \(msg)\n"
    if let h = FileHandle(forWritingAtPath: logPath) {
        h.seekToEndOfFile()
        h.write(line.data(using: .utf8)!)
        try? h.close()
    } else {
        try? line.data(using: .utf8)?.write(to: URL(fileURLWithPath: logPath))
    }
}

// MARK: - 数据模型

struct InboxItem: Codable {
    let id: String
    let title: String
    let project: String
    let summary: String
    let prompt: String?
    let status: String
    let unread: Int
    let time: Double
    let dir: String?
}

struct ItemsResponse: Codable {
    let items: [InboxItem]
}

// MARK: - 时间格式

func relativeTime(_ ts: Double) -> String {
    let delta = Date().timeIntervalSince1970 * 1000 - ts
    if delta < 60_000 { return "刚刚" }
    if delta < 3_600_000 { return "\(Int(delta / 60_000)) 分钟前" }
    if delta < 86_400_000 { return "\(Int(delta / 3_600_000)) 小时前" }
    let f = DateFormatter()
    f.dateFormat = "MM-dd HH:mm"
    return f.string(from: Date(timeIntervalSince1970: ts / 1000))
}

func dirTail(_ dir: String?) -> String {
    guard let dir, !dir.isEmpty else { return "?" }
    let parts = dir.split(separator: "/").map(String.init)
    guard parts.count > 2 else { return dir }
    return "…/" + parts.suffix(2).joined(separator: "/")
}

// MARK: - AppDelegate

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var statusItem: NSStatusItem!
    private var pollTimer: Timer?
    private var items: [InboxItem] = []
    private var offline = true
    private var notifiedKeys: Set<String>
    private let maxMenuItems = 12
    private var bootstrapped = false

    static func turnKey(_ it: InboxItem) -> String { "\(it.id)|\(Int64(it.time))" }

    override init() {
        notifiedKeys = Set(UserDefaults.standard.stringArray(forKey: "ocinbox.notifiedKeys") ?? [])
        super.init()
    }

    func applicationDidFinishLaunching(_ note: Notification) {
        if anotherInstanceRunning() {
            log("已有一个 OC 收件箱实例在运行，本次启动直接退出")
            NSApp.terminate(nil)
            return
        }

        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            log("通知权限 granted=\(granted) error=\(error.map { "\($0)" } ?? "nil")")
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.toolTip = "OC 收件箱 — opencode 会话完成通知"
        rebuildMenu()
        updateIcon()

        pollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.tick()
        }
        tick()
        log("OC 收件箱已启动 (pid \(ProcessInfo.processInfo.processIdentifier))")
    }

    // MARK: 轮询

    private func tick() {
        writeHeartbeat()
        let task = URLSession.shared.dataTask(with: apiBase.appendingPathComponent("api/items")) { [weak self] data, resp, err in
            DispatchQueue.main.async {
                guard let self else { return }
                if let err {
                    if !self.offline { log("服务离线: \(err.localizedDescription)") }
                    self.offline = true
                    self.refreshUI()
                    return
                }
                guard let data,
                      let decoded = try? JSONDecoder().decode(ItemsResponse.self, from: data)
                else {
                    if !self.offline { log("服务返回数据解析失败") }
                    self.offline = true
                    self.refreshUI()
                    return
                }
                let wasOffline = self.offline
                self.offline = false
                self.items = decoded.items

                if !self.bootstrapped {
                    self.bootstrapped = true
                    for it in decoded.items { self.notifiedKeys.insert(Self.turnKey(it)) }
                    if wasOffline { log("首次同步 \(decoded.items.count) 条历史条目（不通知）") }
                } else {
                    for it in decoded.items where !self.notifiedKeys.contains(Self.turnKey(it)) {
                        self.notifiedKeys.insert(Self.turnKey(it))
                        self.postNotification(item: it)
                    }
                }
                self.persistNotified()
                self.refreshUI()
            }
        }
        task.resume()
    }

    private func refreshUI() {
        updateIcon()
        rebuildMenu()
    }

    private func updateIcon() {
        guard let button = statusItem.button else { return }
        let unread = items.reduce(0) { $0 + $1.unread }
        let symbol = (offline ? "tray" : (unread > 0 ? "tray.full" : "tray"))
        if let img = NSImage(systemSymbolName: symbol, accessibilityDescription: "收件箱") {
            button.image = img
        }
        button.title = unread > 0 ? " \(unread)" : ""
        button.contentTintColor = nil
    }

    // MARK: 通知

    private func postNotification(item: InboxItem) {
        let content = UNMutableNotificationContent()
        content.title = "\(item.project) · \(item.title)"
        var body = item.summary
        if let p = item.prompt, !p.isEmpty {
            let q = p.count > 100 ? String(p.prefix(100)) + "…" : p
            let s = item.summary.count > 140 ? String(item.summary.prefix(140)) + "…" : item.summary
            body = "你：\(q)\n\(s)"
        } else if body.count > 160 {
            body = String(body.prefix(160)) + "…"
        }
        content.body = body
        content.threadIdentifier = item.project
        content.userInfo = ["id": item.id]
        content.sound = UNNotificationSound(named: UNNotificationSoundName("Glass.aiff"))
        // 未公证 app 的横幅图标会被通知守护进程缓存成占位图，把图标作为附件携带才能稳定显示
        if let iconURL = Bundle.main.url(forResource: "NotifyIcon", withExtension: "png"),
           let att = try? UNNotificationAttachment(identifier: "appicon", url: iconURL, options: nil) {
            content.attachments = [att]
        }
        let req = UNNotificationRequest(identifier: item.id, content: content, trigger: nil)
        UNUserNotificationCenter.current().add(req) { error in
            log("通知[\(item.title)] \(error.map { "失败: \($0.localizedDescription)" } ?? "已发送")")
        }
        log("新条目[\(item.project)] \(item.title)")
    }

    // 点击通知 → 打开收件箱页面
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        log("通知被点击: \(response.notification.request.identifier)")
        NSWorkspace.shared.open(dashboardURL)
        completionHandler()
    }

    // App 在前台时也弹横幅
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    // MARK: 菜单

    private func rebuildMenu() {
        let menu = NSMenu()
        menu.autoenablesItems = false

        if offline {
            let m = NSMenuItem(title: "⚠️ 收件箱服务未运行", action: nil, keyEquivalent: "")
            m.isEnabled = false
            menu.addItem(m)
            let hint = NSMenuItem(title: "打开任意 opencode 窗口后自动恢复", action: nil, keyEquivalent: "")
            hint.isEnabled = false
            hint.indentationLevel = 1
            menu.addItem(hint)
        } else if items.isEmpty {
            let m = NSMenuItem(title: "📭 暂无条目 — 等待会话完成", action: nil, keyEquivalent: "")
            m.isEnabled = false
            menu.addItem(m)
        } else {
            let head = NSMenuItem(title: "最近完成（点击跳转会话）", action: nil, keyEquivalent: "")
            head.isEnabled = false
            menu.addItem(head)
            for it in items.prefix(maxMenuItems) {
                // 主行：● 标题 + 时间
                let main = NSMenuItem(title: "", action: #selector(openItem(_:)), keyEquivalent: "")
                main.target = self
                main.representedObject = it.id
                main.attributedTitle = NSAttributedString(string: "● \(it.title)", attributes: [
                    .font: NSFont.systemFont(ofSize: 13, weight: .semibold),
                    .foregroundColor: it.unread == 1 ? NSColor.systemRed : NSColor.secondaryLabelColor,
                ])
                let row = NSMenuItem(title: "", action: nil, keyEquivalent: "")
                row.isEnabled = false
                let sub = NSMutableAttributedString(string: "    ", attributes: [:])
                if let p = it.prompt, !p.isEmpty {
                    let q = p.count > 48 ? String(p.prefix(48)) + "…" : p
                    sub.append(NSAttributedString(string: "你：\(q) — ", attributes: [
                        .font: NSFont.menuFont(ofSize: 11),
                        .foregroundColor: NSColor.systemBlue,
                    ]))
                }
                sub.append(NSAttributedString(string: it.summary.prefix(44).description + (it.summary.count > 44 ? "…" : ""), attributes: [
                    .font: NSFont.menuFont(ofSize: 11),
                    .foregroundColor: NSColor.secondaryLabelColor,
                ]))
                sub.append(NSAttributedString(string: "   · \(dirTail(it.dir)) · \(relativeTime(it.time))\(it.unread == 1 ? " · 未读" : "")", attributes: [
                    .font: NSFont.menuFont(ofSize: 11),
                    .foregroundColor: NSColor.tertiaryLabelColor,
                ]))
                row.attributedTitle = sub
                // 时间放主行右侧：用 title 附加（menu 无法右对齐，简化进副行）
                menu.addItem(main)
                menu.addItem(row)
            }
            if items.count > maxMenuItems {
                let more = NSMenuItem(title: "…还有 \(items.count - maxMenuItems) 条，打开网页查看全部", action: #selector(openDashboard(_:)), keyEquivalent: "")
                more.target = self
                menu.addItem(more)
            }
        }

        menu.addItem(.separator())
        let web = NSMenuItem(title: "打开收件箱网页", action: #selector(openDashboard(_:)), keyEquivalent: "")
        web.target = self
        menu.addItem(web)
        let readAll = NSMenuItem(title: "全部标为已读", action: #selector(markAllRead(_:)), keyEquivalent: "")
        readAll.target = self
        menu.addItem(readAll)
        let clear = NSMenuItem(title: "清空收件箱", action: #selector(clearAll(_:)), keyEquivalent: "")
        clear.target = self
        menu.addItem(clear)

        menu.addItem(.separator())
        let login = NSMenuItem(title: "开机自动启动", action: #selector(toggleLoginItem(_:)), keyEquivalent: "")
        login.target = self
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        let quit = NSMenuItem(title: "退出 OC 收件箱", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        menu.addItem(quit)

        statusItem.menu = menu
    }

    // MARK: 动作

    @objc private func openItem(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        log("菜单点击跳转会话 \(id)")
        post(apiBase.appendingPathComponent("api/open"), body: ["id": id])
        post(apiBase.appendingPathComponent("api/read"), body: ["id": id])
    }

    @objc private func openDashboard(_ sender: Any) {
        NSWorkspace.shared.open(dashboardURL)
    }

    @objc private func markAllRead(_ sender: Any) {
        post(apiBase.appendingPathComponent("api/read-all"), body: [:])
    }

    @objc private func clearAll(_ sender: Any) {
        post(apiBase.appendingPathComponent("api/clear"), body: [:])
    }

    @objc private func toggleLoginItem(_ sender: NSMenuItem) {
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
                log("已取消开机自启")
            } else {
                try SMAppService.mainApp.register()
                log("已开启开机自启")
            }
        } catch {
            log("登录项切换失败: \(error.localizedDescription)")
        }
        rebuildMenu()
    }

    private func post(_ url: URL, body: [String: String]) {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req) { [weak self] _, _, err in
            DispatchQueue.main.async {
                if let err { log("POST \(url.lastPathComponent) 失败: \(err.localizedDescription)") }
                self?.tick()
            }
        }.resume()
    }

    // MARK: 心跳与持久化

    private func persistNotified() {
        UserDefaults.standard.set(Array(notifiedKeys.suffix(600)), forKey: "ocinbox.notifiedKeys")
    }

    private func writeHeartbeat() {
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(toFile: heartbeatPath, atomically: true, encoding: .utf8)
    }

    private func anotherInstanceRunning() -> Bool {
        guard let pidStr = try? String(contentsOfFile: heartbeatPath, encoding: .utf8),
              let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0
        else { return false }
        return kill(pid, 0) == 0
    }
}

// MARK: - 启动

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 菜单栏应用，不出现在 Dock
app.run()
