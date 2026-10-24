# dsh-clipboard 📋 剪贴板快速引用

[![Test](https://github.com/hezhaochao/dsh-clipboard/actions/workflows/test.yml/badge.svg)](./actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6)]()
[![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.2.x-4d93f8)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)插件：
自动记录系统剪贴板历史（**只存本机**），输入框旁出现「📋 引用」按钮——
点开最近复制过的内容列表，点一下就插回输入框。
对着 AI 说「把刚才复制的报错贴进来」时，模型也能用 MCP 工具直接读到它。

## 解决什么问题

「把刚才复制的报错发给它」这类动作，现在要：切窗口 → 选中 → 复制 → 切回来 → 粘贴。
装上后：复制完直接点「📋 引用」→ 选那条 → 完事。Windows 自带的 Win+V 还得手动翻找，
这里的历史是为你和 AI 的对话场景准备的。

## 组成（三部分协同）

```
PowerShell 轮询器（DSH 启动时拉起，单实例锁守护）
  每 1.5s 读系统剪贴板（只取文本）→ 变化才追加 → ~/.dsh/dsh-clipboard/history.jsonl
        ↓ 读
宿主半边 lib/index.js
  · 注册本地路由 /dsh-clipboard/history（给网页组件）与 /clear（清空）
  · 挂载 MCP 桥接 → 模型拿到 clipboard_recent / clipboard_get
        ↓ fetch
客户端组件 lib/client.js
  输入框旁「📋 引用」按钮 → 历史列表 → 点一条插入输入框（失败自动回退为复制）
  额外兜底：监听输入框 paste 事件，把每次粘贴存 localStorage（轮询器没跑也有数据）
```

## MCP 工具（模型看到 `mcp__clipboard__<名>`）

| 工具 | 作用 |
|---|---|
| `recent` | 列最近 N 条剪贴板历史（时间 + 索引 + 单行预览） |
| `get` | 按索引取全文（0 = 最新）——「把刚才复制的报错贴进来」就是这条 |

## 安装

```bash
# 从 GitHub
dsh plugin --profile <你的 profile> add github:hezhaochao/dsh-clipboard

# 或本地 link（开发调试；link 不会自动装 peer，需在 profile 目录补
#   pnpm add @deepseek-ai/dsh-mcp-client）
```

安装后**完全退出 DSH（含托盘）再重启**。要求 Windows 10/11（轮询器是 PowerShell 5.1）。

## 使用

1. 重启后输入框旁出现「📋 引用」按钮
2. 平时正常复制东西即可（自动记录，不用管）
3. 点按钮 → 列表（时间 + 内容预览）→ 点某条 → 插入输入框；悬停有「⧉ 只复制」
4. 右下「↻ 刷新」重新加载；「🗑 清空」一键删光全部历史
5. 对话里直接说「把刚才复制的那个 JSON 贴进来」——模型会用 MCP 工具取到它

## 隐私（请读）

- **历史只存本机** `~/.dsh/dsh-clipboard/history.jsonl`，不联网、不上传；
  本地路由只服务 DSH 自己的网页
- 只捕获**文本**（图片/文件忽略）；单条 8000 字符上限；最多 50 条；**4 小时自动过期**
- 「🗑 清空」删光文件与记录；复制过密码/验证码之类的敏感内容，建议随手清掉
- 模型只有在你（或它）调用 MCP 工具时才会读到历史内容

## 兼容性

- 声明 `engines.dsh: ">=0.2.0-rc.1 <0.3.0-0"`，已在 **v0.2.1-rc.3**（当前最新版）上
  完成安装 / 配置树组合 / 卸载验证
- peer 依赖 `@deepseek-ai/dsh-mcp-client >=0.1.0-rc.2 || >=0.2.0-rc.2`，正常渠道安装自动带上
- 非 Windows 环境：客户端组件仍可用（本页粘贴记录兜底），系统级捕获与 MCP 工具明确报错

## 开发与测试

```bash
git clone https://github.com/hezhaochao/dsh-clipboard.git
cd dsh-clipboard
npm test              # MCP 协议层（隔离的临时 HOME，不碰真实数据）
npm run test:watcher  # 轮询器真实 E2E：捕获/去重/截断/修剪/单实例锁（仅 Windows）
```

注意：仓库里的 `.ps1` 必须保持 **UTF-8 with BOM**（PowerShell 5.1 会把无 BOM 的
UTF-8 按 ANSI 误读，中文注释直接炸解析——真机踩过）。

本地真机验证插件挂载：

```bash
dsh plugin --profile zz-test add link:"<本仓库绝对路径>"
dsh --profile zz-test --dump-config   # 应能看到 id: clipboard-quote 条目
```

## 已知限制

- 轮询间隔 1.5s：极快连续复制的中间态可能漏记（对引用场景足够）
- 只在 DSH 运行期间捕获（DSH 常驻托盘 = 基本全天）；DSH 没开时复制的抓不到
- Get-Clipboard 对个别应用的私有剪贴板格式可能拿不到文本，跳过该轮
- 本插件与 Windows 自带 Win+V 历史互不影响

## 许可

[MIT](./LICENSE) © hezhaochao
