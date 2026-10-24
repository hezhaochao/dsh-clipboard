#!/usr/bin/env node
/**
 * dsh-clipboard — MCP stdio 服务器（零依赖、裸 JSON-RPC 实现）
 *
 * 给模型两个工具（mcp__clipboard__recent / mcp__clipboard__get）：
 * 读本地剪贴板历史（history.jsonl），用于「把刚才复制的贴进来」。
 * 启动时顺带确保轮询器在运行（单实例锁在 ps1 侧，重复拉起无害）。
 *
 * 纪律：只读本地文件、无网络请求；非 Windows 明确报错；任何失败回 isError。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WATCHER = path.join(PLUGIN_ROOT, "scripts", "clipboard-watch.ps1");
const VERSION = "0.1.0";
const IS_WINDOWS = process.platform === "win32";
const MAX_ITEMS = 50;

function historyFile() {
  return path.join(os.homedir(), ".dsh", "dsh-clipboard", "history.jsonl");
}

function readHistory() {
  const file = historyFile();
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t);
      if (typeof obj.text === "string" && Number.isFinite(obj.t)) out.push({ t: obj.t, text: obj.text });
    } catch {
      /* 坏行跳过 */
    }
  }
  return out;
}

let watcherEnsured = false;
function ensureWatcher() {
  if (watcherEnsured || !IS_WINDOWS) return;
  watcherEnsured = true;
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", WATCHER],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    child.on("error", () => {});
    child.unref();
  } catch {
    /* 拉起失败不影响读历史 */
  }
}

const obj = (properties, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

const TOOLS = [
  {
    name: "recent",
    description:
      "List recent clipboard history entries (newest first): time, index and a one-line preview. Use clipboard_get with an index to fetch the full text. Local-only capture of text the user copied on this machine.",
    inputSchema: obj({
      count: { type: "integer", description: "How many entries to preview, default 10, max 30." },
    }),
  },
  {
    name: "get",
    description:
      "Return the full text of one clipboard history entry by its index (0 = newest, as listed by clipboard recent). Use when the user says things like '把刚才复制的报错贴进来'.",
    inputSchema: obj(
      { index: { type: "integer", description: "0-based index, 0 = newest." } },
      ["index"],
    ),
  },
];

function fmtTime(ms) {
  try {
    const d = new Date(ms);
    return d.toISOString().replace("T", " ").slice(5, 16);
  } catch {
    return "";
  }
}

function callTool(name, args) {
  const a = args ?? {};
  if (!IS_WINDOWS) {
    return err("剪贴板捕获仅支持 Windows（PowerShell 轮询器）；当前平台没有历史数据。");
  }
  ensureWatcher();
  const items = readHistory().slice().reverse(); // 最新在前
  if (name === "recent") {
    const count = Math.max(1, Math.min(30, Number(a.count) || 10));
    const list = items.slice(0, count).map((it, i) => ({
      index: i,
      time: fmtTime(it.t),
      preview: it.text.replace(/\s+/g, " ").trim().slice(0, 120),
    }));
    return ok({ ok: true, total: items.length, items: list, note: "用 clipboard get 按索引取全文" });
  }
  if (name === "get") {
    const index = Number(a.index);
    if (!Number.isInteger(index) || index < 0 || index >= items.length) {
      return err(`索引越界：0..${items.length - 1}（当前共 ${items.length} 条），先用 recent 看列表`);
    }
    return ok({ ok: true, index, time: fmtTime(items[index].t), text: items[index].text });
  }
  return err(`未知工具：${name}`);
}

function ok(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload ?? { ok: true }) }] };
}

function err(message) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: String(message) }) }], isError: true };
}

/* ────────────────────────── JSON-RPC 骨架 ────────────────────────── */

function writeMessage(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch {
    /* stdout 断开时由 stdin close 负责退出 */
  }
}

function reply(id, result) {
  writeMessage({ jsonrpc: "2.0", id, result });
}

function replyError(id, code, message) {
  writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

const serverInfo = { name: "dsh-clipboard", version: VERSION };

async function dispatch(message) {
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      reply(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/list":
      reply(id, { tools: TOOLS });
      return;
    case "tools/call": {
      try {
        reply(id, callTool(params?.name ?? "", params?.arguments));
      } catch (error) {
        reply(id, err(`工具执行异常：${String(error)}`));
      }
      return;
    }
    default:
      if (id !== undefined && id !== null && method && !method.startsWith("notifications/")) {
        replyError(id, -32601, `Method not found: ${method}`);
      }
  }
}

function main() {
  process.stderr.write(`[dsh-clipboard] ready (history: ${historyFile()})\n`);
  const rl = createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      process.stderr.write(`[dsh-clipboard] 丢弃非 JSON 行：${trimmed.slice(0, 120)}\n`);
      return;
    }
    Promise.resolve(dispatch(message)).catch((error) => {
      process.stderr.write(`[dsh-clipboard] dispatch 异常：${String(error)}\n`);
      if (message && message.id !== undefined && message.id !== null) {
        replyError(message.id, -32603, "Internal error");
      }
    });
  });
  rl.on("close", () => process.exit(0));
}

main();
