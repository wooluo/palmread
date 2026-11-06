"use strict";
/* 手相观纹 · 流式渲染通用组件（复用自六爻项目：逐字渲染 / 思考进度 / loading / 极简 Markdown） */
(function (global) {

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

let toastTimer = null;
function toast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
}

// ---------------- 极简 Markdown（## 小标题 / 列表 / 引用 / 加粗） ----------------
function md(src) {
  const inline = (t) =>
    esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [], list = null;
  const flushP = () => { if (para.length) { out.push("<p>" + para.map(inline).join("<br>") + "</p>"); para = []; } };
  const flushL = () => { if (list) { out.push("</" + list + ">"); list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flushP(); flushL(); continue; }
    let m;
    if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      flushP(); flushL();
      const lv = Math.min(m[1].length + 1, 4);
      out.push(`<h${lv}>${inline(m[2])}</h${lv}>`);
    } else if (/^(---+|\*\*\*+|___+)$/.test(l)) {
      flushP(); flushL(); out.push("<hr>");
    } else if ((m = l.match(/^[-•]\s+(.*)$/))) {
      flushP();
      if (list !== "ul") { flushL(); out.push("<ul>"); list = "ul"; }
      out.push("<li>" + inline(m[1]) + "</li>");
    } else if ((m = l.match(/^(\d+)[.、)]\s+(.*)$/))) {
      flushP();
      if (list !== "ol") { flushL(); out.push("<ol>"); list = "ol"; }
      out.push("<li>" + inline(m[2]) + "</li>");
    } else if ((m = l.match(/^>\s?(.*)$/))) {
      flushP(); flushL();
      out.push("<blockquote>" + inline(m[1]) + "</blockquote>");
    } else {
      flushL(); para.push(l);
    }
  }
  flushP(); flushL();
  return out.join("\n");
}

// 把【民俗趣味参考】【性格倾向参考】段落包进着色区块（民俗浅赭 / 性格浅青）
function mdStyled(src) {
  const html = md(src);
  const marker = "((§BLOCK§))";
  const marked = html
    .replace(/【民俗趣味参考】/g, marker + "folk" + marker)
    .replace(/【性格倾向参考】/g, marker + "mind" + marker);
  if (marked.indexOf(marker) < 0) return html;
  // split 后奇数位是区块类型、偶数位（≥2）是区块内容：parts = [前置, kind, 内容, kind, 内容, ...]
  const parts = marked.split(marker);
  let out = parts[0] || "";
  for (let i = 1; i < parts.length; i += 2) {
    const kind = parts[i];
    const content = parts[i + 1] || "";
    if (kind === "folk" || kind === "mind") {
      const label = kind === "folk" ? "民俗趣味参考" : "性格倾向参考";
      out += `<div class="interp-block ${kind === "folk" ? "block-folk" : "block-mind"}">`
        + `<span class="block-tag">${label}</span>${content}</div>`;
    } else {
      out += kind + content; // 非标记残段原样保留
    }
  }
  return out;
}

// ---------------- 流式绘制（思考进度 + 逐字 + 光标） ----------------
function makePainter(area) {
  let buf = "", reasonBuf = "", lastPaint = 0, t0 = Date.now();
  return {
    get text() { return buf; },
    set text(v) { buf = v || ""; },
    get reason() { return reasonBuf; },
    reset() { buf = ""; reasonBuf = ""; t0 = Date.now(); },
    paint(final) {
      const thinking = !final && !buf;
      const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
      const status = thinking
        ? '<div class="think-status"><span class="think-dot"></span>模型赏析中 · ' + secs + "s"
          + (reasonBuf ? " · 已推理 " + reasonBuf.length + " 字" : "")
          + '<div class="sub2">深度思考模型推理完成后开始输出；想更快可在设置里开启「快速模式」</div></div>'
        : "";
      area.innerHTML = status + mdStyled(buf) + (final ? "" : '<span class="cursor">▍</span>');
      area.classList.remove("waiting");
    },
    /** 流式节流重绘；返回 true 表示本次真的重绘了 */
    tick(throttleMs) {
      const now = performance.now();
      if (now - lastPaint > (throttleMs || 120)) { lastPaint = now; this.paint(false); return true; }
      return false;
    },
    waiting(msg) {
      area.classList.add("waiting");
      area.textContent = msg || "";
    }
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制到剪贴板");
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    toast("已复制到剪贴板");
  }
}

// ---------------- 原生 SSE 流式 HTTP（Capacitor 插件；浏览器返回 null） ----------------
function nativeStreamHttp() {
  const cap = global.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.StreamHttp &&
      (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.StreamHttp;
  }
  return null;
}

/**
 * 原生流式请求：POST payload 到 url，SSE data: 行逐条回调 onDelta({content, reason})。
 * 返回 { promise, cancel }；promise resolve 为完整累积文本。
 */
function nativeStreamRequest(url, headers, payloadObj, onDelta) {
  const plugin = nativeStreamHttp();
  if (!plugin) return null;
  let cancelFn = null;
  const promise = new Promise((resolve, reject) => {
    (async () => {
      const id = "s" + Date.now() + "-" + Math.floor(Math.random() * 1000);
      let acc = "", reason = "", finished = false;
      const handles = [];
      const cleanup = () => handles.forEach((h) => { try { h.remove && h.remove(); } catch (e) {} });
      const finish = (err) => {
        if (finished) return;
        finished = true;
        cleanup();
        if (err) reject(err);
        else resolve(acc);
      };
      cancelFn = () => { try { plugin.cancel({ id }); } catch (e) {} };
      try {
        handles.push(await plugin.addListener("stream-http-data", (e) => {
          if (e.id !== id || !e.payload || e.payload === "[DONE]") return;
          let obj;
          try { obj = JSON.parse(e.payload); } catch (err) { return; }
          let t = "", r = "";
          if (obj.choices && obj.choices[0]) {
            const d = (obj.choices[0].delta) || {};
            t = d.content || "";
            r = d.reasoning_content || d.reasoning || "";
          } else if (obj.type === "content_block_delta") {
            t = (obj.delta || {}).text || "";
          }
          if (t || r) {
            if (t) acc += t;
            if (r) reason += r;
            onDelta({ content: acc, reason });
          }
        }));
        handles.push(await plugin.addListener("stream-http-end", (e) => { if (e.id === id) finish(); }));
        handles.push(await plugin.addListener("stream-http-error", (e) => {
          if (e.id === id) finish(new Error(e.message || "上游错误"));
        }));
        await plugin.request({ id, url, headers, body: JSON.stringify(payloadObj) });
      } catch (e) { finish(e); }
    })();
  });
  return { promise, cancel: () => cancelFn && cancelFn() };
}

const Stream = { esc, toast, md, mdStyled, makePainter, copyText, nativeStreamHttp, nativeStreamRequest };
if (typeof module !== "undefined" && module.exports) module.exports = Stream;
global.Stream = Stream;
})(typeof window !== "undefined" ? window : globalThis);
