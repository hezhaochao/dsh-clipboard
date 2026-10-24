/**
 * dsh-clipboard — MCP 协议层测试。
 *
 * 真实拉起 mcp/server.mjs（把 HOME/USERPROFILE 指到临时目录隔离真实数据），
 * 预置 history.jsonl 后验证 recent / get / 越界错误；另含客户端产物静态审计。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const SERVER = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
const CLIENT = readFileSync(fileURLToPath(new URL("../lib/client.js", import.meta.url)), "utf8");
const PKG = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));

function makeFakeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "dsh-clipboard-test-"));
  const dir = path.join(home, ".dsh", "dsh-clipboard");
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const lines = [
    { t: now - 20000, text: "TypeError: Cannot read properties of undefined (reading 'map')" },
    { t: now - 10000, text: "第二次复制的内容：Dijkstra 算法伪代码……" },
    { t: now, text: "最新复制：https://github.com/hezhaochao" },
  ];
  writeFileSync(path.join(dir, "history.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return home;
}

function startServer(fakeHome) {
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
  });
  const pending = new Map();
  let nextId = 1;
  const rl = createInterface({ input: child.stdout, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const resolve = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  });
  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk;
  });

  function request(method, params) {
    const id = nextId++;
    const message = { jsonrpc: "2.0", id, method };
    if (params !== undefined) message.params = params;
    const promise = new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`请求超时: ${method}\nstderr: ${stderrBuf.slice(-400)}`));
        }
      }, 30_000);
    });
    child.stdin.write(JSON.stringify(message) + "\n");
    return promise;
  }

  function notify(method, params) {
    const message = { jsonrpc: "2.0", method };
    if (params !== undefined) message.params = params;
    child.stdin.write(JSON.stringify(message) + "\n");
  }

  async function close() {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }

  return { request, notify, close };
}

async function handshake(server) {
  const init = await server.request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "clipboard-test", version: "0.0.0" },
  });
  server.notify("notifications/initialized");
  return init;
}

test("MCP 握手与工具清单（recent / get）", async () => {
  const home = makeFakeHome();
  const server = startServer(home);
  try {
    const init = await handshake(server);
    assert.equal(init.result.protocolVersion, "2024-11-05");
    assert.equal(init.result.serverInfo.name, "dsh-clipboard");
    const list = await server.request("tools/list");
    assert.deepEqual(
      list.result.tools.map((t) => t.name).sort(),
      ["get", "recent"],
    );
  } finally {
    await server.close();
  }
});

test("recent：预置历史按最新在前返回", async () => {
  const home = makeFakeHome();
  const server = startServer(home);
  try {
    await handshake(server);
    const call = await server.request("tools/call", { name: "recent", arguments: { count: 10 } });
    const payload = JSON.parse(call.result.content[0].text);
    if (call.result.isError) {
      assert.ok(payload.error.includes("Windows"), "非 Windows 应明确说明平台限制");
      return;
    }
    assert.equal(payload.ok, true);
    assert.equal(payload.total, 3);
    assert.equal(payload.items[0].index, 0);
    assert.ok(payload.items[0].preview.includes("github.com/hezhaochao"), "最新一条在最前");
    assert.ok(payload.items[2].preview.includes("TypeError"), "最旧一条在最后");
  } finally {
    await server.close();
  }
});

test("get：按索引取全文 + 越界报错", async () => {
  const home = makeFakeHome();
  const server = startServer(home);
  try {
    await handshake(server);
    const call = await server.request("tools/call", { name: "get", arguments: { index: 1 } });
    const payload = JSON.parse(call.result.content[0].text);
    if (call.result.isError) {
      assert.ok(payload.error.includes("Windows"), "非 Windows 应明确说明平台限制");
      return;
    }
    assert.equal(payload.ok, true);
    assert.ok(payload.text.includes("Dijkstra"), "应返回完整文本");

    const bad = await server.request("tools/call", { name: "get", arguments: { index: 99 } });
    const badPayload = JSON.parse(bad.result.content[0].text);
    assert.equal(bad.result.isError, true);
    assert.ok(badPayload.error.includes("索引越界"));
  } finally {
    await server.close();
  }
});

test("客户端产物静态检查（与宿主半边审计一致）", () => {
  assert.ok(CLIENT.includes(`id: "${PKG.name}"`));
  assert.ok(CLIENT.includes("__ModuleLoader__.load"));
  assert.ok(CLIENT.includes("return module.exports"));
  assert.ok(CLIENT.includes("conversation.input.right"));
  assert.match(CLIENT, /exports\.apply\s*=/);
  assert.ok(CLIENT.includes("/dsh-clipboard/history"), "客户端要会请求本地路由");
  assert.ok(PKG.dsh?.bundle?.patch, "缺少 bundle patch 声明");
  assert.ok(PKG.dsh?.client?.platform === "web", "缺少客户端声明");
});
