/**
 * dsh-clipboard — 客户端半边
 *
 * 输入框旁放一个「📋 引用」按钮：点开是剪贴板历史（系统级，来自宿主本地路由
 * /dsh-clipboard/history；路由不可用时退回本页粘贴记录），点一条就把它插回输入框。
 * 另外监听输入框的 paste 事件，把每次粘贴存进 localStorage——
 * 这样即便轮询器没跑（非 Windows / 老宿主），「刚才粘过的东西」也能一键再引。
 *
 * 三条纪律（DSH 生态惯例）：
 *   1. **fail-open**：路由 404、轮询器没跑、存储被禁……都降级到剩余数据源，
 *      绝不连累宿主输入区。
 *   2. **绝不注入消息**：唯一的动作是往输入框插入文本（或复制回剪贴板）。
 *   3. **只动自己的 DOM**：全部挂在自有类名（dcl-*）下；弹层 portal 到 body。
 *
 * 隐私：历史只在本机（文件 + localStorage），列表里有「清空」一键删干净；
 * 复制过密码之类的敏感内容建议随手清空。
 */
window.__ModuleLoader__.load({
  id: "dsh-clipboard",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var React = require("react");
    var ReactDOM = require("react-dom");

    var PACKAGE_ID = "dsh-clipboard";
    var SLOT_NAME = "conversation.input.right";
    var ENTRY_ID = "clipboard-quote";
    var ENTRY_ORDER = 71;
    var STYLE_MARKER = PACKAGE_ID;
    var ROUTE = "/dsh-clipboard";
    var PASTE_KEY = "dsh-clipboard:pastes:v1";
    var MAX_PASTE_ITEMS = 20;
    var MAX_ITEM_TEXT = 8000;
    var POPOVER_WIDTH = 340;

    /* ══════════════════════ 纯函数（离线可测） ══════════════════════ */

    function previewOf(text, maxLen) {
      var s = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
      if (s.length > maxLen) return s.slice(0, maxLen - 1) + "…";
      return s;
    }

    function timeOf(ms) {
      try {
        var d = new Date(Number(ms));
        if (isNaN(d.getTime())) return "";
        var h = String(d.getHours()).padStart(2, "0");
        var m = String(d.getMinutes()).padStart(2, "0");
        return h + ":" + m;
      } catch {
        return "";
      }
    }

    function normalizeItems(raw, cap) {
      var out = [];
      var list = Array.isArray(raw) ? raw : [];
      for (var i = list.length - 1; i >= 0 && out.length < cap; i--) {
        var it = list[i];
        if (!it || typeof it.text !== "string" || !it.text.trim()) continue;
        var text = it.text;
        if (text.length > MAX_ITEM_TEXT) text = text.slice(0, MAX_ITEM_TEXT);
        out.push({ t: Number(it.t) || 0, text: text });
      }
      return out;
    }

    function dedupeByNewest(items) {
      var seen = {};
      var out = [];
      for (var i = 0; i < items.length; i++) {
        var key = items[i].text;
        if (seen[key]) continue;
        seen[key] = true;
        out.push(items[i]);
      }
      return out;
    }

    function buildAppendedText(existing, snippet) {
      var cur = String(existing == null ? "" : existing);
      var add = String(snippet == null ? "" : snippet);
      if (!add) return cur;
      if (!cur) return add;
      if (cur.charAt(cur.length - 1) === "\n") return cur + add;
      return cur + "\n" + add;
    }

    /* ══════════════════════ 存储与数据源 ══════════════════════ */

    function readPasteHistory() {
      try {
        return normalizeItems(JSON.parse(window.localStorage.getItem(PASTE_KEY) || "[]"), MAX_PASTE_ITEMS);
      } catch {
        return [];
      }
    }

    function recordPaste(text) {
      try {
        var items = JSON.parse(window.localStorage.getItem(PASTE_KEY) || "[]");
        if (!Array.isArray(items)) items = [];
        items.push({ t: Date.now(), text: String(text == null ? "" : text).slice(0, MAX_ITEM_TEXT) });
        items = items.slice(-MAX_PASTE_ITEMS);
        window.localStorage.setItem(PASTE_KEY, JSON.stringify(items));
      } catch {
        /* 存储被禁就跳过 */
      }
    }

    function fetchSystemHistory() {
      return fetch(ROUTE + "/history", { headers: { Accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("HTTP " + r.status);
          return r.json();
        })
        .then(function (body) {
          if (!body || body.ok === false) throw new Error("bad payload");
          return normalizeItems(body.items, MAX_PASTE_ITEMS);
        });
    }

    /* ══════════════════════ 输入区操作 ══════════════════════ */

    function isVisible(el) {
      try {
        var rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      } catch {
        return false;
      }
    }

    function findChatTarget() {
      try {
        var i, el;
        var tas = document.querySelectorAll("textarea");
        for (i = tas.length - 1; i >= 0; i--) {
          el = tas[i];
          if (isVisible(el) && !el.closest(".dcl-popover") && !el.closest(".dcl-root")) {
            return { kind: "textarea", el: el };
          }
        }
        var ces = document.querySelectorAll('[contenteditable="true"]');
        for (i = ces.length - 1; i >= 0; i--) {
          el = ces[i];
          if (isVisible(el) && !el.closest(".dcl-popover") && !el.closest(".dcl-root")) {
            return { kind: "ce", el: el };
          }
        }
      } catch {
        /* fall through */
      }
      return null;
    }

    function insertText(target, text) {
      if (!target || !target.el || !text) return false;
      try {
        if (target.kind === "textarea") {
          var el = target.el;
          var proto = el instanceof window.HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          var setter = Object.getOwnPropertyDescriptor(proto, "value").set;
          var next = buildAppendedText(el.value, text);
          setter.call(el, next);
          el.dispatchEvent(new window.Event("input", { bubbles: true }));
          el.focus();
          try {
            el.selectionStart = el.selectionEnd = next.length;
          } catch {
            /* 部分实现不允许脚本设置选区 */
          }
          return true;
        }
        if (target.kind === "ce") {
          var ce = target.el;
          ce.focus();
          try {
            var doc = ce.ownerDocument || document;
            var range = doc.createRange();
            range.selectNodeContents(ce);
            range.collapse(false);
            var sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
            }
          } catch {
            /* 光标定位失败不阻断插入 */
          }
          return doc.execCommand("insertText", false, text);
        }
      } catch {
        /* 失败交给调用方回退 */
      }
      return false;
    }

    function copyText(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          navigator.clipboard.writeText(text).catch(function () {});
          return true;
        }
      } catch {
        /* fall through */
      }
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "readonly");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }

    function showToast(message) {
      try {
        var t = document.createElement("div");
        t.className = "dcl-toast";
        t.textContent = message;
        document.body.appendChild(t);
        window.setTimeout(function () {
          t.classList.add("dcl-toast-out");
        }, 1500);
        window.setTimeout(function () {
          if (t.parentNode) t.parentNode.removeChild(t);
        }, 1900);
      } catch {
        /* 提示失败就失败吧 */
      }
    }

    /* ══════════════════════ 样式（只挂自己的类名） ══════════════════════ */

    var CSS = [
      ".dcl-root{display:inline-flex;align-items:center;min-width:0}",
      ".dcl-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border-radius:999px;"
        + "border:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.12));background:transparent;"
        + "color:var(--dsw-alias-label-primary,#0f1115);font-size:12px;line-height:1;cursor:pointer;"
        + "user-select:none;-webkit-user-select:none;white-space:nowrap}",
      ".dcl-btn:hover,.dcl-btn:focus-visible{border-color:var(--dsw-alias-state-business-primary,#4d93f8);"
        + "color:var(--dsw-alias-state-business-primary,#4d93f8)}",
      ".dcl-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#4d93f8);outline-offset:2px}",
      ".dcl-popover{position:fixed;width:" + POPOVER_WIDTH + "px;max-width:calc(100vw - 16px);max-height:360px;"
        + "display:flex;flex-direction:column;background:var(--dsw-alias-bg-primary,#fff);"
        + "color:var(--dsw-alias-label-primary,#0f1115);border-radius:12px;overflow:hidden;"
        + "box-shadow:0 8px 30px rgba(0,0,0,.18),0 0 0 1px rgba(0,0,0,.06);z-index:2147483000;font-size:12px}",
      ".dcl-head{padding:10px 12px 6px;font-weight:600;flex:none;display:flex;justify-content:space-between;align-items:center;gap:8px}",
      ".dcl-head-hint{font-weight:400;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.55))}",
      ".dcl-list{overflow-y:auto;padding:0 6px 6px;min-height:0}",
      ".dcl-item{display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border-radius:8px;"
        + "border:none;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
      ".dcl-item:hover,.dcl-item:focus-visible{background:var(--dsw-alias-fill-secondary,rgba(15,17,21,.06))}",
      ".dcl-item-time{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.45));font-variant-numeric:tabular-nums}",
      ".dcl-item-preview{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dcl-item-actions{display:none;flex:none;gap:2px}",
      ".dcl-item:hover .dcl-item-actions,.dcl-item:focus-within .dcl-item-actions{display:inline-flex}",
      ".dcl-icon-btn{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;"
        + "border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;padding:0}",
      ".dcl-icon-btn:hover{background:var(--dsw-alias-fill-tertiary,rgba(15,17,21,.1))}",
      ".dcl-empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.55))}",
      ".dcl-footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px;"
        + "padding:8px 12px;border-top:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.12));"
        + "font-size:11px;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.55))}",
      ".dcl-mini{height:24px;padding:0 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1,rgba(15,17,21,.18));"
        + "background:transparent;color:inherit;font-size:11px;cursor:pointer}",
      ".dcl-mini:hover{border-color:var(--dsw-alias-state-business-primary,#4d93f8);color:var(--dsw-alias-state-business-primary,#4d93f8)}",
      ".dcl-toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:rgba(15,17,21,.86);"
        + "color:#fff;padding:7px 14px;border-radius:999px;font-size:12px;z-index:2147483600;pointer-events:none;"
        + "transition:opacity .35s}",
      ".dcl-toast-out{opacity:0}",
    ];

    function installStyles() {
      try {
        if (typeof document === "undefined" || !document.head) return null;
        var existing = document.querySelector('style[data-plugin-css="' + STYLE_MARKER + '"]');
        if (existing) return existing;
        var style = document.createElement("style");
        style.setAttribute("data-plugin-css", STYLE_MARKER);
        style.textContent = CSS.join("");
        document.head.appendChild(style);
        return style;
      } catch {
        return null;
      }
    }

    /* ══════════════════════ React 组件 ══════════════════════ */

    function HistoryRow(props) {
      var it = props.item;
      return React.createElement(
        "button",
        {
          className: "dcl-item",
          type: "button",
          title: it.text.length > 200 ? it.text.slice(0, 2000) : it.text,
          onClick: function (e) {
            e.stopPropagation();
            props.onUse(it);
          },
        },
        React.createElement("span", { className: "dcl-item-time" }, timeOf(it.t)),
        React.createElement("span", { className: "dcl-item-preview" }, previewOf(it.text, 80)),
        React.createElement(
          "span",
          { className: "dcl-item-actions", onClick: function (e) { e.stopPropagation(); } },
          React.createElement(
            "button",
            {
              className: "dcl-icon-btn",
              type: "button",
              title: "复制这条",
              onClick: function () { props.onCopy(it); },
            },
            "⧉",
          ),
        ),
      );
    }

    function ClipboardPopover(props) {
      return React.createElement(
        "div",
        {
          className: "dcl-popover",
          role: "dialog",
          "aria-label": "剪贴板引用",
          style: props.pos,
          ref: props.popRef,
        },
        React.createElement(
          "div",
          { className: "dcl-head" },
          React.createElement("span", null, "📋 剪贴板引用"),
          React.createElement("span", { className: "dcl-head-hint" }, props.sourceHint),
        ),
        React.createElement(
          "div",
          { className: "dcl-list" },
          props.items.length === 0
            ? React.createElement(
                "div",
                { className: "dcl-empty" },
                props.emptyHint || "还没有记录：复制点什么，或往输入框粘贴一次",
              )
            : props.items.map(function (it, i) {
                return React.createElement(HistoryRow, {
                  key: (it.t || 0) + "-" + i,
                  item: it,
                  onUse: props.onUse,
                  onCopy: props.onCopy,
                });
              }),
        ),
        React.createElement(
          "div",
          { className: "dcl-footer" },
          React.createElement(
            "button",
            { className: "dcl-mini", type: "button", title: "清空系统历史与本页记录", onClick: props.onClear },
            "🗑 清空",
          ),
          React.createElement(
            "button",
            { className: "dcl-mini", type: "button", onClick: props.onReload },
            "↻ 刷新",
          ),
        ),
      );
    }

    function ClipboardWidget() {
      var openR = React.useState(false);
      var open = openR[0], setOpen = openR[1];
      var itemsR = React.useState([]);
      var items = itemsR[0], setItems = itemsR[1];
      var sourceR = React.useState("");
      var source = sourceR[0], setSource = sourceR[1];
      var posR = React.useState(null);
      var pos = posR[0], setPos = posR[1];
      var btnRef = React.useRef(null);
      var popRef = React.useRef(null);

      function load() {
        var system = [];
        var hadRoute = false;
        return fetchSystemHistory()
          .then(function (sys) {
            system = sys;
            hadRoute = true;
          })
          .catch(function () {
            hadRoute = false;
          })
          .then(function () {
            var pastes = readPasteHistory();
            var merged = dedupeByNewest(system.concat(pastes));
            setItems(merged);
            setSource(
              hadRoute
                ? "系统剪贴板 · 最近 " + merged.length + " 条"
                : "本页粘贴记录（轮询器未运行）",
            );
          });
      }

      function openPopover() {
        var style = { right: "16px", bottom: "120px" };
        try {
          var rect = btnRef.current ? btnRef.current.getBoundingClientRect() : null;
          if (rect && typeof window !== "undefined") {
            style.right = Math.max(8, window.innerWidth - rect.right) + "px";
            var spaceAbove = rect.top;
            var spaceBelow = window.innerHeight - rect.bottom;
            if (spaceAbove >= 400 || spaceAbove >= spaceBelow) {
              style.bottom = window.innerHeight - rect.top + 6 + "px";
            } else {
              style.top = rect.bottom + 6 + "px";
            }
          }
        } catch {
          /* 定位失败用兜底位置 */
        }
        setPos(style);
        setOpen(true);
        setItems([]);
        setSource("加载中…");
        load();
      }

      React.useEffect(
        function () {
          if (!open) return undefined;
          function onDocDown(e) {
            try {
              if (popRef.current && popRef.current.contains(e.target)) return;
              if (btnRef.current && btnRef.current.contains(e.target)) return;
              setOpen(false);
            } catch {
              /* 判定失败保持打开 */
            }
          }
          function onKey(e) {
            if (e && e.key === "Escape") setOpen(false);
          }
          function onScroll(e) {
            try {
              if (popRef.current && popRef.current.contains(e.target)) return;
              setOpen(false);
            } catch {
              /* ignore */
            }
          }
          document.addEventListener("pointerdown", onDocDown, true);
          document.addEventListener("keydown", onKey, true);
          window.addEventListener("scroll", onScroll, true);
          window.addEventListener("resize", onScroll);
          return function () {
            document.removeEventListener("pointerdown", onDocDown, true);
            document.removeEventListener("keydown", onKey, true);
            window.removeEventListener("scroll", onScroll, true);
            window.removeEventListener("resize", onScroll);
          };
        },
        [open],
      );

      function useItem(it) {
        setOpen(false);
        var target = findChatTarget();
        if (target && insertText(target, it.text)) {
          showToast("已插入输入框");
          return;
        }
        if (copyText(it.text)) showToast("没找到输入框，已复制到剪贴板");
        else showToast("无法自动插入，请手动操作");
      }

      function copyItem(it) {
        if (copyText(it.text)) showToast("已复制");
        else showToast("复制失败");
      }

      function clearAll() {
        var ok = false;
        try {
          ok = window.confirm("清空全部剪贴板历史？");
        } catch {
          ok = true;
        }
        if (!ok) return;
        try {
          window.localStorage.removeItem(PASTE_KEY);
        } catch {
          /* ignore */
        }
        fetch(ROUTE + "/clear", { method: "POST" }).catch(function () {});
        setItems([]);
        showToast("已清空");
      }

      // 全局监听输入框的粘贴：存进本页记录（轮询器之外的兜底数据源）
      React.useEffect(function () {
        function onPaste(e) {
          try {
            var target = e && e.target;
            if (!target) return;
            if (target.closest && (target.closest(".dcl-popover") || target.closest(".dcl-root"))) return;
            var isInput =
              target.tagName === "TEXTAREA" ||
              (target.tagName === "INPUT" && target.type !== "password") ||
              target.isContentEditable;
            if (!isInput) return;
            var text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
            if (text && text.trim()) recordPaste(text);
          } catch {
            /* 记录失败不影响粘贴本身 */
          }
        }
        document.addEventListener("paste", onPaste, true);
        return function () {
          document.removeEventListener("paste", onPaste, true);
        };
      }, []);

      var widget = React.createElement(
        "span",
        { className: "dcl-root" },
        React.createElement(
          "button",
          {
            className: "dcl-btn",
            type: "button",
            ref: btnRef,
            "aria-haspopup": "dialog",
            "aria-expanded": open ? "true" : "false",
            title: "剪贴板快速引用",
            onClick: function () {
              if (open) setOpen(false);
              else openPopover();
            },
          },
          "📋 引用",
        ),
      );

      var popover = open
        ? ReactDOM.createPortal(
            React.createElement(ClipboardPopover, {
              items: items,
              sourceHint: source,
              pos: pos,
              popRef: popRef,
              onUse: useItem,
              onCopy: copyItem,
              onClear: clearAll,
              onReload: function () {
                setSource("加载中…");
                load();
              },
            }),
            document.body,
          )
        : null;

      return React.createElement(React.Fragment, null, widget, popover);
    }

    /* ══════════════════════ 插槽注册 ══════════════════════ */

    function apply(ctx) {
      installStyles();
      try {
        ctx.slots.inject(SLOT_NAME, function () {
          return ctx.slots.register(
            {
              name: SLOT_NAME,
              id: ENTRY_ID,
              order: ENTRY_ORDER,
              label: function () { return "Clipboard quote"; },
            },
            function SlotComponent(props) {
              return React.createElement(ClipboardWidget, Object.assign({}, props, {}));
            },
          );
        });
      } catch (error) {
        // 注册失败只意味着这块控件不出现，绝不能连累宿主输入区。
        try {
          console.error("[" + PACKAGE_ID + "] 插槽注册失败，控件不会出现：", error);
        } catch (e) {
          /* 忽略 */
        }
      }
    }

    var inject = ["slots"];

    exports.apply = apply;
    exports.inject = inject;
    // 离线测试用的接缝（纯函数 + 常量）。运行时无副作用。
    exports.__internals = {
      PACKAGE_ID: PACKAGE_ID,
      SLOT_NAME: SLOT_NAME,
      ENTRY_ID: ENTRY_ID,
      PASTE_KEY: PASTE_KEY,
      ROUTE: ROUTE,
      previewOf: previewOf,
      timeOf: timeOf,
      normalizeItems: normalizeItems,
      dedupeByNewest: dedupeByNewest,
      buildAppendedText: buildAppendedText,
    };

    return module.exports;
  },
});
