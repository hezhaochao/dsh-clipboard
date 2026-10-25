/**
 * dsh-clipboard — 宿主半边
 *
 * 一行 cordis 条目做四件事（全部 fail-open，绝不抛错拖累插件树）：
 *   1. 确保 PowerShell 剪贴板轮询器在运行（分离进程 + 单实例锁）
 *   2. 注册本地路由 /dsh-clipboard/*，给网页组件读/清历史
 *   3. 挂载 MCP 桥接，模型拿到 clipboard_recent / clipboard_get 工具
 *   4. 静态审计客户端产物（坏了只告警）
 *
 * 三条纪律（DSH 生态惯例）：
 *   - apply() 绝不抛错；不声明不确定存在的 inject 服务
 *   - webServer 路由只服务本机历史文件，无任何外发
 *   - 历史文件是唯一共享状态：轮询器写，路由与 MCP 工具读
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const PACKAGE_ID = "dsh-clipboard";
const ROUTE_PREFIX = "/dsh-clipboard";
const IS_WINDOWS = process.platform === "win32";
const MAX_PREVIEW_ITEMS = 30;

export const name = "clipboard-quote";
export const inject = ["webServer"];

function historyFile() {
  return path.join(os.homedir(), ".dsh", "dsh-clipboard", "history.jsonl");
}

function readHistory() {
  try {
    const file = historyFile();
    if (!existsSync(file)) return [];
    const out = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (typeof obj.text === "string" && Number.isFinite(obj.t)) {
          out.push({ t: obj.t, text: obj.text });
        }
      } catch {
        /* 坏行跳过 */
      }
    }
    return out.slice(-MAX_PREVIEW_ITEMS);
  } catch {
    return [];
  }
}

/** 拉起轮询器（分离进程）。单实例锁在 ps1 里，重复拉起无害。 */
function ensureWatcher(log) {
  if (!IS_WINDOWS) return;
  try {
    const watchPs1 = fileURLToPath(new URL("../scripts/clipboard-watch.ps1", import.meta.url));
    // ⚠️ 不能加 detached: true —— Windows 上 DETACHED_PROCESS 会让控制台版
    // PowerShell 瞬间退出（与 dsh-snip 同坑）。
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", watchPs1],
      { stdio: "ignore", windowsHide: true },
    );
    child.on("error", (error) => log(`轮询器启动失败（不影响其他功能）：${String(error)}`));
  } catch (error) {
    log(`轮询器拉起异常（不影响其他功能）：${String(error)}`);
  }
}

function sendJson(res, status, obj) {
  try {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
    });
    res.end(body);
  } catch {
    /* 客户端断开时忽略 */
  }
}

function auditClientBundle(log) {
  try {
    const bundle = readFileSync(fileURLToPath(new URL("./client.js", import.meta.url)), "utf8");
    const problems = [];
    if (!bundle.includes(`id: "${PACKAGE_ID}"`) && !bundle.includes(`id:"${PACKAGE_ID}"`)) {
      problems.push("bundle id 不匹配");
    }
    if (!bundle.includes("__ModuleLoader__.load")) problems.push("不是模块加载器 bundle");
    if (!bundle.includes("return module.exports")) problems.push("工厂没有交出 exports");
    if (!bundle.includes("conversation.input.right")) problems.push("没有声明目标插槽");
    if (!/exports\.apply\s*=/.test(bundle)) problems.push("没有导出 apply");
    if (problems.length > 0) {
      log(`客户端产物 lib/client.js 检查未通过（界面可能不会出现按钮）：${problems.join("；")}`);
      return;
    }
    log(`客户端产物 lib/client.js 就绪（${Buffer.byteLength(bundle, "utf8")} 字节，静态检查通过）`);
  } catch (error) {
    log(`客户端产物 lib/client.js 不可读（界面不会出现按钮）：${String(error)}`);
  }
}

async function mountMcpBridge(ctx, log) {
  try {
    const bridge = await import("@deepseek-ai/dsh-mcp-client");
    const connection = ctx.plugin(bridge, {
      serverName: "clipboard",
      transport: "stdio",
      command: process.execPath,
      args: [fileURLToPath(new URL("../mcp/server.mjs", import.meta.url))],
      env: { ELECTRON_RUN_AS_NODE: "1" },
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    });
    await connection;
    log("MCP 工具已挂载（clipboard_recent / clipboard_get）");
  } catch (error) {
    // MCP 桥接失败不影响网页组件：那才是本插件的主入口
    log(`MCP 桥接挂载失败（网页组件不受影响）：${String(error)}`);
  }
}

export function apply(ctx) {
  try {
    const candidate = ctx?.logger;
    const sink = typeof candidate === "function" ? candidate(PACKAGE_ID) : candidate;
    const log = (message) => {
      try {
        if (sink && typeof sink.info === "function") sink.info(`[${PACKAGE_ID}] ${message}`);
        else console.info(`[${PACKAGE_ID}] ${message}`);
      } catch {
        /* 连日志都不能抛 */
      }
    };

    auditClientBundle(log);
    ensureWatcher(log);

    // 本地路由：读 / 清 历史文件。只服务本机，无任何外发。
    if (ctx?.webServer && typeof ctx.webServer.register === "function") {
      ctx.effect(() =>
        ctx.webServer.register({
          kind: "prefix",
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            try {
              const url = new URL(req.url ?? "/", "http://local");
              const rest = url.pathname.replace(/\/+$/, "");
              if (rest === ROUTE_PREFIX || rest === `${ROUTE_PREFIX}/history`) {
                const items = readHistory();
                sendJson(res, 200, { ok: true, count: items.length, items });
                return;
              }
              if (rest === `${ROUTE_PREFIX}/clear` && (req.method === "POST" || req.method === "PUT")) {
                try {
                  rmSync(historyFile(), { force: true });
                } catch {
                  /* 文件不存在等 */
                }
                sendJson(res, 200, { ok: true, cleared: true });
                return;
              }
              sendJson(res, 404, { ok: false, error: "not found" });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String(error) });
            }
          },
        }),
        "dsh-clipboard: history route",
      );
      log(`本地路由已注册：${ROUTE_PREFIX}/history`);
    } else {
      log("宿主未提供 webServer 服务，网页组件将退回用本页粘贴记录");
    }

    mountMcpBridge(ctx, log);
  } catch {
    /* 审计/挂载整体失败也必须让 apply 静默成功 */
  }
}

export default { apply };
