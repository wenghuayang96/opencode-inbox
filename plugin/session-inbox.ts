/**
 * session-inbox — OpenCode 会话收件箱（多窗口完成情况持久列表）
 *
 * 功能：
 *  - 每次会话回合结束（session.idle）或出错（session.error）时，
 *    记录：项目名 / 会话标题 / 本轮回复摘要 / 时间 / 状态
 *  - 发送一条带内容的 macOS 系统通知（标题 = 项目 · 会话名，正文 = 摘要）
 *  - 在 127.0.0.1:47832 起一个本地服务，浏览器访问即得常驻收件箱页面（2s 自动刷新）
 *  - 点击「打开会话」：先尝试按窗口标题聚焦原终端窗口（Ghostty/iTerm2/Terminal/Warp），
 *    失败则新开 Ghostty 窗口运行 opencode --session <id>，再不行回退 Terminal.app
 *
 * 数据：~/.local/share/opencode/session-inbox.json（最多 50 条，原子写入）
 * 多实例：多个 opencode 窗口同时运行时，第一个实例持有服务端口；
 *         持有者退出后，其他实例在下次事件或 60s 心跳时自动接管。
 *
 * 纯 node 内置模块，无外部依赖。运行于 opencode 插件运行时（Bun）。
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { promises as fs, statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const run = promisify(execFile)

// ---------- 常量 ----------
const PORT = 47832
const HOST = "127.0.0.1"
const BASE_URL = `http://${HOST}:${PORT}`
const DATA_FILE = path.join(homedir(), ".local", "share", "opencode", "session-inbox.json")
const DATA_DIR = path.dirname(DATA_FILE)
const MAX_ITEMS = 50
const NOTIFY_SUMMARY_MAX = 140
const STORE_SUMMARY_MAX = 400
const SERVER_PING_TIMEOUT_MS = 700

// ---------- 类型 ----------
type ItemStatus = "done" | "error"

interface InboxItem {
  id: string // sessionID
  title: string // 会话标题
  project: string // 项目目录名
  dir: string // 项目绝对路径
  prompt: string // 用户本轮提问
  summary: string // 本轮回复摘要
  status: ItemStatus
  unread: number
  time: number // epoch ms
}

interface SessionData {
  id?: string
  title?: string
  parentID?: string
}

interface MessagePart {
  type?: string
  text?: string
}

interface Message {
  info?: { role?: string; sessionID?: string }
  parts?: MessagePart[]
}

interface ApiClient {
  session: {
    get(args: { path: { id: string } }): Promise<{ data: SessionData }>
    messages(args: { path: { id: string } }): Promise<{ data: Message[] }>
  }
  app: { log(args: { body: Record<string, unknown> }): Promise<unknown> }
}

interface PluginCtx {
  project: unknown
  directory: string
  worktree: string
  client: ApiClient
}

interface EventEnvelope {
  type: string
  properties?: Record<string, unknown>
}

type Hooks = Record<string, (input: unknown) => Promise<void> | void>

// ---------- 小工具 ----------
function str(v: unknown): string {
  return typeof v === "string" ? v : ""
}

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/")
  return parts[parts.length - 1] || p
}

/** 把助手消息的 text parts 压成一行摘要 */
function summarize(msg: Message): string {
  const texts: string[] = []
  for (const part of msg.parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text)
    }
  }
  let s = texts.join(" ")
  if (!s) return ""
  // 去掉常见 markdown 噪音，压缩空白
  s = s
    .replace(/```[\s\S]*?```/g, " [代码块] ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
  if (s.length > STORE_SUMMARY_MAX) s = s.slice(0, STORE_SUMMARY_MAX) + "…"
  return s
}

function osaEscape(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\t]+/g, " ")
}

async function log(client: ApiClient, level: "debug" | "info" | "warn" | "error", message: string): Promise<void> {
  try {
    await client.app.log({ body: { service: "session-inbox", level, message } })
  } catch {
    // 日志失败静默
  }
}

// ---------- 存储 ----------
async function readStore(): Promise<InboxItem[]> {
  try {
    const raw = JSON.parse(await fs.readFile(DATA_FILE, "utf8")) as unknown
    if (!Array.isArray(raw)) return []
    return mapStore(raw)
  } catch {
    return []
  }
}

async function writeStore(items: InboxItem[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const tmp = DATA_FILE + ".tmp"
  await fs.writeFile(tmp, JSON.stringify(items, null, 2), "utf8")
  await fs.rename(tmp, DATA_FILE)
}

function readStoreSync(): InboxItem[] {
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf8")) as unknown
    if (!Array.isArray(raw)) return []
    return mapStore(raw)
  } catch {
    return []
  }
}

function mapStore(raw: unknown[]): InboxItem[] {
  const items: InboxItem[] = []
  for (const e of raw) {
    const rec = e as Partial<InboxItem>
    if (typeof rec.id === "string" && typeof rec.time === "number") {
      items.push({
        id: rec.id,
        title: str(rec.title) || "未命名会话",
        project: str(rec.project) || "?",
        dir: str(rec.dir),
        prompt: str(rec.prompt),
        summary: str(rec.summary),
        status: rec.status === "error" ? "error" : "done",
        unread: typeof rec.unread === "number" ? rec.unread : 1,
        time: rec.time,
      })
    }
  }
  return items
}

// opencode run 场景宿主进程在 idle 事件后可能几百毫秒内退出：
// 落盘必须同步完成，只要执行到就不可能因进程退出而丢失
function upsertSync(patch: Omit<InboxItem, "unread">): void {
  const items = readStoreSync()
  const idx = items.findIndex((i) => i.id === patch.id)
  const merged: InboxItem = {
    ...patch,
    unread: Math.min(idx >= 0 ? items[idx].unread + 1 : 1, 99),
  }
  if (idx >= 0) items.splice(idx, 1)
  items.unshift(merged)
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS
  mkdirSync(DATA_DIR, { recursive: true })
  const tmp = DATA_FILE + ".tmp"
  writeFileSync(tmp, JSON.stringify(items, null, 2), "utf8")
  renameSync(tmp, DATA_FILE)
}

async function markRead(id: string, all = false): Promise<void> {
  const items = await readStore()
  let dirty = false
  for (const it of items) {
    if ((all || it.id === id) && it.unread !== 0) {
      it.unread = 0
      dirty = true
    }
  }
  if (dirty) await writeStore(items)
}

// ---------- macOS 通知 / 窗口聚焦 ----------

/** 菜单栏 App（OC收件箱.app）存活心跳：新鲜说明 App 会自己弹可点击通知，插件跳过 osascript 防止双重通知 */
function menuBarAppAlive(): boolean {
  try {
    const st = statSync(
      `${process.env.HOME}/.local/share/opencode/oc-inbox-app.heartbeat`,
    )
    return Date.now() - st.mtimeMs < 6000
  } catch {
    return false
  }
}

async function notify(title: string, body: string): Promise<void> {
  if (menuBarAppAlive()) return
  const t = osaEscape(title.slice(0, 100))
  const b = osaEscape(body.slice(0, NOTIFY_SUMMARY_MAX))
  try {
    await run("osascript", [
      "-e",
      `display notification "${b}" with title "${t}" sound name "Glass"`,
    ])
  } catch {
    // 通知失败不影响主流程
  }
}

/** 按窗口标题聚焦终端窗口，成功返回应用名，失败返回 null */
async function focusWindowByTitle(match: string): Promise<string | null> {
  const m = osaEscape(match)
  // Ghostty 经 open -na 打开的会话各占一个独立实例，必须扫描全部同名进程
  const script = `
tell application "System Events"
  repeat with procName in {"Ghostty", "iTerm2", "Terminal", "Warp"}
    set targetName to procName as text
    repeat with p in (application processes whose name is targetName)
      repeat with w in windows of p
        try
          set winName to name of w
          if winName is not missing value then
            if winName contains "${m}" then
              try
                set value of attribute "AXMinimized" of w to false
              end try
              perform action "AXRaise" of w
              set frontmost of p to true
              return "focused:" & targetName
            end if
          end if
        end try
      end repeat
    end repeat
  end repeat
  return ""
end tell`
  try {
    const { stdout } = await run("osascript", ["-e", script])
    const out = stdout.trim()
    if (out.startsWith("focused:")) return out.slice("focused:".length)
  } catch {
    // 无辅助功能权限等情况
  }
  return null
}

async function openSessionWindow(item: InboxItem): Promise<{ ok: boolean; method: string }> {
  const candidates = [item.title, item.project].filter((s) => s && s.length >= 3)
  for (const c of candidates) {
    const app = await focusWindowByTitle(c)
    if (app) return { ok: true, method: `已聚焦 ${app} 原窗口` }
  }
  // 回退 1：新开 Ghostty 窗口 attach 会话
  // --working-directory 必须用 = 赋值：空格分隔会被 Ghostty 当成无值配置项，每次弹 Configuration Errors
  const dirArgs = item.dir ? [`--working-directory=${item.dir}`] : []
  try {
    await run("open", ["-na", "Ghostty", "--args", ...dirArgs, "-e", "opencode", "--session", item.id])
    if (item.title.length >= 3) {
      // 新窗口可能最小化落地，等它建好再抬到最前
      await new Promise((r) => setTimeout(r, 800))
      await focusWindowByTitle(item.title)
    }
    return { ok: true, method: "已在新 Ghostty 窗口打开会话" }
  } catch {
    // 继续
  }
  // 回退 2：Terminal.app
  try {
    const dir = item.dir.replace(/"/g, '\\"')
    await run("osascript", [
      "-e",
      `tell application "Terminal"
         activate
         do script "cd \\"${dir}\\" && opencode --session ${item.id}"
       end tell`,
    ])
    return { ok: true, method: "已在 Terminal 新窗口打开会话" }
  } catch {
    return { ok: false, method: "打开失败：请手动执行 opencode --session " + item.id }
  }
}

// ---------- 内嵌页面（客户端 JS 不用模板字符串，避免嵌套转义） ----------
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenCode 会话收件箱</title>
<style>
  :root {
    --bg: #0b0e14; --card: #151a23; --card-hover: #1a2029;
    --text: #e6edf3; --muted: #8b949e; --accent: #4f8cff;
    --done: #3fb950; --error: #f85149; --border: #21262d;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text);
    font-family: -apple-system, "PingFang SC", "Segoe UI", system-ui, sans-serif;
    font-size: 14px; padding: 20px; max-width: 860px; margin: 0 auto;
  }
  header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { font-size: 18px; font-weight: 700; }
  .pill {
    background: var(--accent); color: #fff; border-radius: 999px;
    padding: 1px 10px; font-size: 12px; font-weight: 600; min-width: 20px; text-align: center;
  }
  .pill.zero { background: var(--border); color: var(--muted); }
  .spacer { flex: 1; }
  button {
    background: transparent; color: var(--muted); border: 1px solid var(--border);
    border-radius: 8px; padding: 5px 12px; font-size: 12px; cursor: pointer;
  }
  button:hover { color: var(--text); border-color: var(--muted); }
  button.on { color: var(--accent); border-color: var(--accent); background: #4f8cff1a; }
  #banner {
    display: none; background: #3d1d20; color: #ffb3ad; border: 1px solid #f8514955;
    padding: 10px 14px; border-radius: 10px; margin-bottom: 12px;
  }
  .item {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    padding: 14px 16px; margin-bottom: 10px; transition: background .15s;
  }
  .item:hover { background: var(--card-hover); }
  .item.flash { animation: flash 2.2s ease-out; }
  @keyframes flash { 0% { border-color: var(--accent); box-shadow: 0 0 0 3px #4f8cff33; } 100% { border-color: var(--border); box-shadow: none; } }
  .row1 { display: flex; align-items: center; gap: 8px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .dot.done { background: var(--done); }
  .dot.error { background: var(--error); }
  .dot.unread { background: var(--accent); animation: pulse 1.6s infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .badge {
    background: #4f8cff1a; color: var(--accent); border-radius: 6px;
    padding: 1px 8px; font-size: 12px; font-weight: 600; flex: none; max-width: 30%;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .badge.err { background: #f851491a; color: var(--error); }
  .title {
    font-weight: 650; font-size: 14px; flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .time { color: var(--muted); font-size: 12px; font-family: ui-monospace, monospace; flex: none; }
  .summary {
    color: var(--muted); margin-top: 8px; line-height: 1.55; font-size: 13px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .dir {
    color: #57606a; margin-top: 6px; font-size: 11px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .prompt {
    color: #79c0ff; margin-top: 6px; line-height: 1.5; font-size: 12.5px;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .row3 { display: flex; gap: 14px; margin-top: 10px; }
  .link { background: none; border: none; color: var(--accent); font-size: 12px; padding: 0; cursor: pointer; }
  .link:hover { text-decoration: underline; }
  .link.muted { color: var(--muted); }
  .empty { text-align: center; color: var(--muted); padding: 80px 0; }
  .empty .big { font-size: 34px; margin-bottom: 12px; }
  footer { color: #57606a; font-size: 12px; text-align: center; padding: 18px 0 6px; }
</style>
</head>
<body>
<header>
  <h1>OpenCode 会话收件箱</h1>
  <span class="pill zero" id="pill">0</span>
  <span class="spacer"></span>
  <button id="unread">只显示未读</button>
  <button id="readall">全部已读</button>
  <button id="clear">清空</button>
</header>
<div id="banner">收件箱服务未运行（所有 opencode 窗口都已关闭？）。正在重试…</div>
<div id="list"></div>
<div class="empty" id="empty" style="display:none">
  <div class="big">( )</div>
  <div id="emptyText">暂无记录。各窗口每完成一轮回复，就会出现在这里。</div>
</div>
<footer>session-inbox · 127.0.0.1:47832 · 数据保存在本地 session-inbox.json</footer>
<script>
var lastTimes = {};
var unreadOnly = false;
function fmtRel(t) {
  var d = new Date(t), now = new Date();
  var diff = (now.getTime() - t) / 1000;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return Math.floor(diff / 60) + " 分钟前";
  var hm = ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
}
function el(tag, cls, text) {
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function render(data) {
  var items = data.items || [];
  var banner = document.getElementById("banner");
  banner.style.display = "none";
  var list = document.getElementById("list");
  list.innerHTML = "";
  var empty = document.getElementById("empty");
  empty.style.display = items.length ? "none" : "block";
  var unreadTotal = 0;
  items.forEach(function (it) { unreadTotal += it.unread; });
  var shown = unreadOnly ? items.filter(function (it) { return it.unread > 0; }) : items;
  empty.style.display = shown.length ? "none" : "block";
  document.getElementById("emptyText").textContent = unreadOnly && items.length
    ? "没有未读条目 🎉"
    : "暂无记录。各窗口每完成一轮回复，就会出现在这里。";
  shown.forEach(function (it) {
    var card = el("div", "item" + (it.time > (lastTimes[it.id] || 0) && lastTimes[it.id] !== undefined ? " flash" : ""));
    lastTimes[it.id] = it.time;
    var row1 = el("div", "row1");
    row1.appendChild(el("span", "dot " + it.status + (it.unread ? " unread" : "")));
    row1.appendChild(el("span", "badge" + (it.status === "error" ? " err" : ""), it.status === "error" ? "出错 · " + it.project : it.project));
    row1.appendChild(el("span", "title", it.title));
    row1.appendChild(el("span", "time", fmtRel(it.time)));
    card.appendChild(row1);
    card.appendChild(el("div", "dir", it.dir || ""));
    card.appendChild(el("div", "prompt", it.prompt ? "你：" + it.prompt : "（无提问记录）"));
    card.appendChild(el("div", "summary", it.summary || "（无文本回复）"));
    var row3 = el("div", "row3");
    var open = el("button", "link", "打开会话");
    open.dataset.act = "open"; open.dataset.id = it.id;
    row3.appendChild(open);
    var read = el("button", "link muted", it.unread ? "标为已读" : "已读");
    read.dataset.act = "read"; read.dataset.id = it.id;
    row3.appendChild(read);
    card.appendChild(row3);
    list.appendChild(card);
  });
  var pill = document.getElementById("pill");
  pill.textContent = unreadTotal;
  pill.className = unreadTotal ? "pill" : "pill zero";
  document.title = (unreadTotal ? "(" + unreadTotal + ") " : "") + "OpenCode 会话收件箱";
}
async function refresh() {
  try {
    var r = await fetch("/api/items", { cache: "no-store" });
    render(await r.json());
  } catch (e) {
    document.getElementById("banner").style.display = "block";
  }
}
async function post(path, body) {
  try {
    var r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    return await r.json();
  } catch (e) { return null; }
}
document.getElementById("list").addEventListener("click", async function (ev) {
  var t = ev.target;
  if (!t.dataset || !t.dataset.act) return;
  var id = t.dataset.id;
  if (t.dataset.act === "open") {
    var res = await post("/api/open", { id: id });
    if (res && res.message) { t.textContent = res.message; setTimeout(refresh, 1500); }
  } else if (t.dataset.act === "read") {
    await post("/api/read", { id: id });
    refresh();
  }
});
document.getElementById("unread").onclick = function () {
  unreadOnly = !unreadOnly;
  this.classList.toggle("on", unreadOnly);
  refresh();
};
document.getElementById("readall").onclick = async function () { await post("/api/read-all"); refresh(); };
document.getElementById("clear").onclick = async function () { await post("/api/clear"); refresh(); };
setInterval(refresh, 2000);
document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
refresh();
</script>
</body>
</html>`

// ---------- HTTP 服务 ----------
let serverOwned = false

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  res.end(s)
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return await new Promise((resolve) => {
    let data = ""
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8")
      if (data.length > 8192) {
        resolve({})
        req.destroy()
      }
    })
    req.on("end", () => {
      try {
        const parsed = JSON.parse(data || "{}") as unknown
        resolve(parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {})
      } catch {
        resolve({})
      }
    })
    req.on("error", () => resolve({}))
  })
}

function startServer(client: ApiClient): void {
  if (serverOwned) return
  const server = createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0]
    try {
      if (req.method === "GET" && (url === "/" || url === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
        res.end(PAGE_HTML)
        return
      }
      if (req.method === "GET" && url === "/api/ping") {
        return json(res, 200, { ok: true })
      }
      if (req.method === "GET" && url === "/api/items") {
        return json(res, 200, { items: await readStore() })
      }
      if (req.method === "POST" && url === "/api/read") {
        const body = await readJsonBody(req)
        await markRead(str(body.id))
        return json(res, 200, { ok: true })
      }
      if (req.method === "POST" && url === "/api/read-all") {
        await markRead("", true)
        return json(res, 200, { ok: true })
      }
      if (req.method === "POST" && url === "/api/clear") {
        await writeStore([])
        return json(res, 200, { ok: true })
      }
      if (req.method === "POST" && url === "/api/open") {
        const body = await readJsonBody(req)
        const item = (await readStore()).find((i) => i.id === str(body.id))
        if (!item) return json(res, 404, { ok: false, message: "条目不存在" })
        const result = await openSessionWindow(item)
        if (result.ok) await markRead(item.id)
        return json(res, 200, { ok: result.ok, message: result.method })
      }
      json(res, 404, { ok: false })
    } catch (err) {
      json(res, 500, { ok: false, message: err instanceof Error ? err.message : "internal error" })
    }
  })
  server.on("error", (err: NodeJS.ErrnoException) => {
    // 端口被其他 opencode 实例占用：本实例转为纯写入模式
    serverOwned = false
    void log(client, "debug", `server not started: ${err.code ?? err.message}`)
  })
  server.listen(PORT, HOST, () => {
    serverOwned = true
    void log(client, "info", `session-inbox dashboard: ${BASE_URL}`)
  })
}

async function ensureServer(client: ApiClient): Promise<void> {
  if (serverOwned) return
  try {
    const res = await fetch(`${BASE_URL}/api/ping`, { signal: AbortSignal.timeout(SERVER_PING_TIMEOUT_MS) })
    if (res.ok) return // 已有实例在服务
  } catch {
    // 无响应 → 尝试自己接管
  }
  startServer(client)
}

// ---------- 事件处理 ----------
// 通知去抖：同一会话短时间多次回合结束只弹一条（记录本身不延迟）
const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>()
const NOTIFY_DEBOUNCE_MS = 500

function notifyDebounced(key: string, title: string, body: string): void {
  const prev = notifyTimers.get(key)
  if (prev) clearTimeout(prev)
  notifyTimers.set(
    key,
    setTimeout(() => {
      notifyTimers.delete(key)
      void notify(title, body)
    }, NOTIFY_DEBOUNCE_MS),
  )
}

async function fetchSessionInfo(client: ApiClient, sessionID: string): Promise<SessionData | null> {
  try {
    return (await client.session.get({ path: { id: sessionID } })).data ?? null
  } catch {
    return null
  }
}

async function fetchLastExchange(client: ApiClient, sessionID: string): Promise<{ user: Message | null; assistant: Message | null }> {
  try {
    const msgs = (await client.session.messages({ path: { id: sessionID } })).data ?? []
    let ai = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].info?.role === "assistant") {
        ai = i
        break
      }
    }
    if (ai < 0) return { user: null, assistant: null }
    for (let i = ai - 1; i >= 0; i--) {
      if (msgs[i].info?.role === "user") return { user: msgs[i], assistant: msgs[ai] }
    }
    return { user: null, assistant: msgs[ai] }
  } catch {
    return { user: null, assistant: null }
  }
}

function promptOf(msg: Message | null): string {
  if (!msg) return ""
  const texts: string[] = []
  for (const part of msg.parts ?? []) {
    if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
      texts.push(part.text)
    }
  }
  return texts.join(" ").replace(/\s+/g, " ").trim().slice(0, 200)
}

async function handleIdle(client: ApiClient, sessionID: string, project: string, directory: string): Promise<void> {
  const [session, exchange] = await Promise.all([
    fetchSessionInfo(client, sessionID),
    fetchLastExchange(client, sessionID),
  ])
  if (session?.parentID) return // 子代理会话不进收件箱
  const summary = exchange.assistant ? summarize(exchange.assistant) : ""
  if (!summary) return // 无文本回复（如被权限拒绝中断）不记录
  const title = str(session?.title) || project
  const prompt = promptOf(exchange.user)
  upsertSync({ id: sessionID, title, project, dir: directory, prompt, summary, status: "done", time: Date.now() })
  void ensureServer(client)
  notifyDebounced(sessionID, `${project} · ${title}`, prompt ? `你：${prompt}\n${summary}` : summary)
}

async function handleError(
  client: ApiClient,
  sessionID: string,
  message: string,
  project: string,
  directory: string,
): Promise<void> {
  const session = await fetchSessionInfo(client, sessionID)
  if (session?.parentID) return
  const title = str(session?.title) || project
  const { user } = await fetchLastExchange(client, sessionID)
  upsertSync({
    id: sessionID,
    title,
    project,
    dir: directory,
    prompt: promptOf(user),
    summary: message ? `出错：${message}` : "会话发生错误",
    status: "error",
    time: Date.now(),
  })
  await ensureServer(client)
  await notify(`${project} · ${title}`, `会话出错：${message || "未知错误"}`)
}

// ---------- 插件入口 ----------
const SessionInbox = async (ctx: PluginCtx): Promise<Hooks> => {
  const project = ctx.directory ? basename(ctx.directory) : "?"
  const client = ctx.client

  // 启动时以及每 60s 确保收件箱服务在线（属主退出后自动接管）
  await ensureServer(client)
  setInterval(() => void ensureServer(client), 60000)

  return {
    event: async (input: { event?: EventEnvelope }) => {
      const event = input?.event
      if (!event) return
      if (event.type === "session.idle") {
        const sessionID = str(event.properties?.sessionID)
        if (!sessionID) return
        // 立即处理，不做延迟：宿主进程可能在事件后很快退出（如 opencode run）
        void handleIdle(client, sessionID, project, ctx.directory).catch((err: unknown) =>
          log(client, "error", `handleIdle failed: ${err instanceof Error ? err.message : String(err)}`),
        )
      }
      if (event.type === "session.error") {
        const props = event.properties ?? {}
        const sessionID = str(props.sessionID)
        const err = (props.error ?? {}) as { name?: string; message?: string }
        if (err.name === "MessageAbortedError") return // 用户主动取消不打扰
        if (!sessionID) return
        void handleError(client, sessionID, str(err.message), project, ctx.directory).catch(() => undefined)
      }
    },
  }
}

export default SessionInbox
