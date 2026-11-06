"use strict";
/* 手相观纹 · 前端主逻辑（原生 JS 零依赖）
 * 连接本地服务 → 服务器模式；直接打开 / 安卓 App → 离线模式（直连 GLM，原生插件流式）。
 * 定位：民俗趣味赏析。绝不输出命运预测、医疗结论（多层拦截，见 palm-prompt.js 与 data/safe_words.json）。 */

// ---------------- 模式探测 / 配置 ----------------
let MODE = "server"; // server = 本地 Python 服务；client = 离线（APK / 无服务时）

function lsGet(k, d) {
  try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
}
function lsSet(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

// WebView 坑：APK 内 fetch 本地路由会 200 返回 index.html（HTML 兜底），
// 必须校验 content-type 为 JSON 且含 providers 才认定有服务器；原生环境直接离线。
async function detectMode() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.isNativePlatform && cap.isNativePlatform()) { MODE = "client"; return; }
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const res = await fetch("/api/config", { signal: ctl.signal });
    clearTimeout(t);
    const ct = res.headers.get("content-type") || "";
    if (res.ok && ct.indexOf("json") >= 0) {
      const data = await res.json().catch(() => null);
      if (data && data.providers) { MODE = "server"; return; }
    }
  } catch (e) { /* 无服务器 */ }
  MODE = "client";
}

function defaultConfig() {
  return {
    provider: "glm",
    providers: {
      glm: { label: "GLM 智谱（Coding Plan）", base: "https://open.bigmodel.cn/api/coding/paas/v4",
             model: "glm-5.3-flash", api_key: "", fast: true }
    }
  };
}

function clientRawConfig() {
  const stored = lsGet("palmread.config", null);
  if (!stored) return defaultConfig();
  const base = defaultConfig();
  Object.keys(base.providers).forEach((pid) => {
    if (!stored.providers[pid]) stored.providers[pid] = base.providers[pid];
  });
  if (!stored.providers[stored.provider]) stored.provider = base.provider;
  return stored;
}

function applyConfigPatch(cfg, body) {
  if (body.provider && cfg.providers[body.provider]) cfg.provider = body.provider;
  Object.entries(body.providers || {}).forEach(([pid, p]) => {
    if (!p || typeof p !== "object" || !cfg.providers[pid]) return;
    const tgt = cfg.providers[pid];
    ["label", "base", "model"].forEach((k) => {
      if (typeof p[k] === "string") tgt[k] = p[k].trim();
    });
    if (typeof p.api_key === "string" && p.api_key.trim()) tgt.api_key = p.api_key.trim();
    if (typeof p.fast === "boolean") tgt.fast = p.fast;
  });
}

async function api(path, opts = {}) {
  if (MODE === "client") return clientApi(path, opts);
  const init = { method: opts.method || "GET", headers: { "Content-Type": "application/json" } };
  if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
  const res = await fetch(path, init);
  const data = await res.json().catch(() => null);
  if (!res.ok || data === null || typeof data !== "object") {
    const err = new Error((data && data.error) || "HTTP " + res.status);
    if (data && data.blocked) err.blocked = true;
    throw err;
  }
  return data;
}

// 离线模式的非赏析类 API（配置读写；记录存取由 palm-history 承担）
async function clientApi(path, opts = {}) {
  const method = opts.method || "GET";
  const body = opts.body || {};
  if (path === "/api/config" && method === "GET") {
    const cfg = JSON.parse(JSON.stringify(clientRawConfig()));
    Object.values(cfg.providers).forEach((p) => { p.has_key = !!p.api_key; p.api_key = ""; });
    return cfg;
  }
  if (path === "/api/config" && method === "POST") {
    const cfg = clientRawConfig();
    applyConfigPatch(cfg, body);
    lsSet("palmread.config", cfg);
    return { ok: true };
  }
  if (path.startsWith("/api/models")) {
    const pid = new URLSearchParams(path.split("?")[1] || "").get("provider") || "";
    const pcfg = clientRawConfig().providers[pid];
    if (!pcfg) throw new Error("未知 provider");
    return { models: await fetchModelsDirect(pcfg) };
  }
  throw new Error("离线模式不支持：" + path);
}

// ---------------- 直连 GLM（多模态） ----------------
function nativeHttp() {
  const cap = typeof window !== "undefined" && window.Capacitor;
  if (cap && cap.Plugins && cap.Plugins.CapacitorHttp && (!cap.isNativePlatform || cap.isNativePlatform())) {
    return cap.Plugins.CapacitorHttp;
  }
  return null;
}

async function httpJSON(method, url, headers, bodyObj, timeoutMs) {
  const nh = nativeHttp();
  if (nh) {
    const r = await nh.request({ method, url, headers: headers || {}, data: bodyObj });
    if (r.status >= 400) throw new Error("HTTP " + r.status + "：" + JSON.stringify(r.data).slice(0, 200));
    return { status: r.status, json: r.data };
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 30000);
  try {
    const res = await fetch(url, {
      method, headers,
      body: bodyObj !== undefined ? JSON.stringify(bodyObj) : undefined,
      signal: ctl.signal
    });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const msg = j && j.error ? (j.error.message || j.error) : JSON.stringify(j).slice(0, 200);
      throw new Error("HTTP " + res.status + "：" + (msg || ""));
    }
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } finally { clearTimeout(t); }
}

async function fetchModelsDirect(pcfg) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  if (!base) return [];
  const headers = {};
  if (pcfg.api_key) headers.Authorization = "Bearer " + pcfg.api_key;
  const { json } = await httpJSON("GET", base + "/models", headers, undefined, 10000);
  return (json.data || []).map((m) => m && m.id).filter(Boolean);
}

const NON_CHAT_MODEL = /embed|rerank|ocr|whisper|speech|tts|stt|audio|clip/i;

// 误选纯文本模型（不接受图片输入，智谱报 1210）时的自动回退多模态模型
const FALLBACK_VISION_MODEL = "glm-5.3-flash";
const NO_IMAGE_SUPPORT = /1210|content\.type|取值范围|image_url|不支持图片/i;

function resolveClientModel(pcfg) {
  const model = (pcfg.model || "").trim();
  if (model) return Promise.resolve(model);
  return fetchModelsDirect(pcfg)
    .then((ms) => ms.find((x) => !NON_CHAT_MODEL.test(x)) || ms[0] || "")
    .catch(() => "");
}

// 组装直连请求体（多模态 + 快速模式关闭深度思考）
function clientRequestBody(pcfg, model, note, imageDataUrl, stream) {
  const base = (pcfg.base || "").replace(/\/+$/, "");
  const url = base + "/chat/completions";
  const headers = { "Content-Type": "application/json" };
  if (pcfg.api_key) headers.Authorization = "Bearer " + pcfg.api_key;
  const payload = {
    model,
    temperature: 0.7,
    stream: !!stream,
    messages: PalmPrompt.buildMessages(note, imageDataUrl)
  };
  if (pcfg.fast && /bigmodel|z\.ai/i.test(pcfg.base || "")) {
    payload.thinking = { type: "disabled" };
  }
  return { url, headers, payload };
}

// 非流式（浏览器离线兜底；APK 有原生插件走流式）
async function clientInterpret(pcfg, model, note, imageDataUrl) {
  if (!model) model = await resolveClientModel(pcfg);
  if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
  const req = clientRequestBody(pcfg, model, note, imageDataUrl, false);
  const { json } = await httpJSON("POST", req.url, req.headers, req.payload, 300000);
  let text = "";
  if (json && Array.isArray(json.choices) && json.choices[0]) {
    text = (json.choices[0].message || {}).content || "";
  } else if (json && json.error && (json.error.code || json.error.message)) {
    throw new Error("HTTP 上游错误 " + (json.error.code || "") + "：" + (json.error.message || ""));
  }
  if (!text) throw new Error("模型未返回内容：" + JSON.stringify(json).slice(0, 160));
  return text;
}

// 输出合规兜底：命中违禁词 → 中性改写（正常情况下提示词已锁死，这层是保险；幂等可重复调用）
const NEUTRAL_MARK = "\n\n> 系统提示：以上内容已自动转换为中性表述。";
function neutralize(text) {
  const hadMark = String(text || "").indexOf(NEUTRAL_MARK) >= 0;
  const s = String(text || "").replace(NEUTRAL_MARK, "");
  const r = PalmPrompt.neutralRewrite(s);
  return (r.rewritten || hadMark) ? r.text + NEUTRAL_MARK : r.text;
}

// ---------------- 页面框架 ----------------
const app = document.getElementById("app");

function disclaimerHtml() {
  return `<div class="disclaimer"><b>免责声明</b>：本App仅为传统手相民俗文化趣味赏析工具，不构成医学、心理、人生决策建议；手纹会随年龄、劳作、体态发生变化，请勿以此作为判断健康、命运的依据。</div>`;
}

// 上传引导示意图（SVG：手掌 + 正方形取景框）
function palmDiagramHtml() {
  return `<svg viewBox="0 0 200 200" class="palm-diagram" aria-hidden="true">
    <rect x="26" y="26" width="148" height="148" rx="10" fill="none" stroke="#c9b78d" stroke-width="2.5" stroke-dasharray="7 5"/>
    <g fill="#d9a97e">
      <rect x="62" y="52" width="14" height="46" rx="7"/>
      <rect x="81" y="42" width="14" height="56" rx="7"/>
      <rect x="100" y="48" width="14" height="52" rx="7"/>
      <rect x="119" y="58" width="13" height="44" rx="6.5"/>
      <path d="M 56 104 Q 56 142 88 148 Q 128 152 140 120 Q 146 106 138 100 L 128 100 Q 130 112 118 114 Q 100 116 96 104 Z"/>
    </g>
    <g stroke="#a8402f" stroke-width="2" fill="none" stroke-linecap="round" opacity="0.8">
      <path d="M 66 122 Q 84 128 108 126"/>
      <path d="M 74 112 Q 92 114 112 110"/>
      <path d="M 70 104 Q 88 100 106 100"/>
    </g>
    <g stroke="#8a6d3b" stroke-width="2.5" stroke-linecap="round">
      <path d="M 100 26 L 100 40"/><path d="M 100 160 L 100 174"/>
      <path d="M 26 100 L 40 100"/><path d="M 160 100 L 174 100"/>
    </g>
  </svg>`;
}

let config = null;
async function loadConfig(force) {
  if (config && !force) return config;
  try { config = await api("/api/config"); } catch (e) { config = null; }
  return config;
}

// ---------------- 路由 ----------------
window.addEventListener("hashchange", route);

function route() {
  const h = location.hash || "#/scan";
  const m = h.match(/^#\/([a-z]+)(?:\/([\w-]+))?/);
  const page = m ? m[1] : "scan";
  $$(".topbar nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === page));
  window.scrollTo(0, 0);
  if (page === "history") return renderHistory();
  if (page === "settings") return renderSettings();
  if (page === "result" && m[2]) return renderResult(m[2], true);
  return renderScan();
}

function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function $(sel, root) { return (root || document).querySelector(sel); }

// ---------------- 上传 / 赏析页 ----------------
let draft = { image: null, note: "", confirmed: false };

async function renderScan() {
  await loadConfig();
  app.innerHTML = `
  <section>
    <div class="card">
      <h2>拍掌纹 <span class="sub">手心朝上 · 掌心放平</span></h2>
      <div class="guide">
        ${palmDiagramHtml()}
        <div class="guide-list">
          <div>✋ 手掌<b>放平</b>，掌心朝上</div>
          <div>☀️ 光线<b>充足</b>，不要逆光</div>
          <div>🖐️ 手指<b>自然分开</b>，不要并拢</div>
          <div>📷 掌纹<b>不要遮挡</b>、避免反光</div>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary big" id="btn-camera">📷 拍摄掌纹</button>
        <button class="btn ghost big" id="btn-album">🖼️ 从相册选取</button>
      </div>
      <div id="preview-wrap" ${draft.image ? "" : "hidden"}>
        <img id="preview" alt="掌纹预览">
        <button class="btn ghost small" id="btn-recrop">重新裁剪</button>
      </div>
    </div>
    <div class="card confirm-card">
      <label class="chk-line">
        <input type="checkbox" id="confirm-chk" ${draft.confirmed ? "checked" : ""}>
        <span>我已知晓本内容仅为民俗娱乐赏析，不具备诊断、预测效力</span>
      </label>
      <div class="btn-row">
        <button class="btn primary big" id="btn-go" disabled>开始赏析 →</button>
      </div>
    </div>
    <div class="card">
      <h2>备注 <span class="sub">可选 · 仅画质说明</span></h2>
      <input type="text" id="note" maxlength="60" placeholder="例：左手、室内灯光下拍摄（选填）">
      <div class="hint">备注只用于说明拍摄情况。涉及算命、健康、吉凶预测等字样会被直接拦截。</div>
    </div>
    ${disclaimerHtml()}
  </section>`;

  const chk = $("#confirm-chk"), go = $("#btn-go");
  chk.addEventListener("change", () => {
    draft.confirmed = chk.checked;
    go.disabled = !chk.checked || !draft.image;
  });
  const noteEl = $("#note");
  noteEl.value = draft.note;
  noteEl.addEventListener("input", () => { draft.note = noteEl.value; });

  const previewWrap = $("#preview-wrap"), preview = $("#preview");
  if (draft.image) { preview.src = draft.image; go.disabled = !chk.checked; }
  function showPreview(dataUrl) {
    draft.image = dataUrl;
    preview.src = dataUrl;
    previewWrap.hidden = false;
    go.disabled = !chk.checked;
  }

  $("#btn-camera").addEventListener("click", async () => {
    const raw = await PalmUpload.openCamera();
    if (!raw) return;
    const cropped = await PalmUpload.showCrop(raw);
    if (cropped) showPreview(cropped);
  });
  $("#btn-album").addEventListener("click", async () => {
    const raw = await PalmUpload.openAlbum();
    if (!raw) return;
    const cropped = await PalmUpload.showCrop(raw);
    if (cropped) showPreview(cropped);
  });
  $("#btn-recrop").addEventListener("click", async () => {
    const cropped = await PalmUpload.showCrop(draft.image);
    if (cropped) showPreview(cropped);
  });

  go.addEventListener("click", async () => {
    if (!draft.image) return;
    if (!chk.checked) { Stream.toast("请先勾选知晓声明"); return; }

    // 本地安全拦截：备注命中敏感词 → 直接拦，不调任何接口
    const hit = PalmPrompt.checkNote(draft.note);
    if (hit) {
      showBlock(hit.message);
      return;
    }

    go.disabled = true;
    const btnText = go.textContent;
    go.textContent = "正在创建记录…";
    try {
      const { record, evicted } = await PalmHistory.create(draft.image, draft.note);
      if (evicted > 0) Stream.toast(`本地存档已达 ${PalmHistory.MAX_LOCAL} 条，最早 ${evicted} 条已自动清理`);
      draft = { image: null, note: "", confirmed: draft.confirmed };
      location.hash = "#/result/" + record.id + "!auto";
    } catch (e) {
      if (e.blocked) showBlock(e.message);
      else Stream.toast("创建记录失败：" + e.message);
      go.disabled = false;
      go.textContent = btnText;
    }
  });

  function showBlock(message) {
    go.disabled = false;
    const box = $(".confirm-card .err-box") || document.createElement("div");
    box.className = "err-box";
    box.innerHTML = `<b>已拦截</b>：${Stream.esc(message)}<br><span class="sub2">本工具只做掌纹趣味赏析，不提供相关预测、诊断服务。</span>`;
    if (!box.parentNode) $(".confirm-card").appendChild(box);
  }
}

// ---------------- 结果页 ----------------
let interpBusy = false;
let streamCancel = null;

async function renderResult(id, autoStart) {
  autoStart = autoStart || location.hash.indexOf("!auto") > 0;
  let record;
  try {
    record = await PalmHistory.get(id);
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="err-box">记录不存在或已删除。<br><a href="#/history">← 返回历史</a></div></div>`;
    return;
  }
  const cfg = (await loadConfig(true)) || { providers: {}, provider: "glm" };
  const image = record.image || record.thumb || "";
  const latest = (record.interpretations || [])[(record.interpretations || []).length - 1];
  const text = latest ? latest.text : (record.text || "");

  const tags = (record.tags && record.tags.length) ? record.tags.map((t) => `<span class="tag">${Stream.esc(t)}</span>`).join("") : "";

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>掌纹影像 <span class="sub">${Stream.esc(record.created)}</span></h2>
      <div class="palm-shot"><img src="${image}" alt="掌纹"></div>
      ${record.note ? `<div class="interp-meta">备注：${Stream.esc(record.note)}</div>` : ""}
      ${tags ? `<div class="chip-row" style="margin-top:8px">${tags}</div>` : ""}
    </div>
    <div class="card">
      <h2>赏析结果 <span class="sub">${MODE === "server" ? "服务流式 · 自动存档" : "离线直连 · 存本机"}</span></h2>
      ${MODE === "client" ? "" : `<div class="chips" id="prov-chips">${provChipsHtml(cfg)}</div>`}
      <div class="btn-row">
        <button class="btn primary" id="start-interp">${text ? "再赏析一次" : "开始赏析"}</button>
        <button class="btn ghost" id="stop-interp" style="display:none">停止</button>
        ${text ? '<button class="btn ghost small" id="copy-interp">复制解读</button>' : ""}
      </div>
      ${latest ? `<div class="interp-meta">最近：${Stream.esc(latest.at || record.created)}${latest.model ? " · " + Stream.esc(latest.model) : ""}</div>` : ""}
      <div class="stream ${text ? "" : "waiting"}" id="interp-area">${text ? Stream.mdStyled(text) : "点击「开始赏析」，AI 将流式输出民俗趣味赏析。"}</div>
      <div class="err-box" id="interp-err" hidden></div>
      ${oldInterpHtml(record)}
    </div>
    <div class="card">
      <h2>分享 <span class="sub">只发模板，不泄露解读全文</span></h2>
      <div class="btn-row">
        <button class="btn ghost" id="share-text">📋 复制分享文案</button>
        <button class="btn ghost" id="share-card">🎴 生成分享卡片</button>
      </div>
      <div class="hint">分享文案不含任何解读内容，朋友看到后可以自己上传体验。</div>
    </div>
    <div class="btn-row">
      <a class="btn ghost big" href="#/scan" style="text-decoration:none">再拍一张</a>
      <a class="btn ghost big" href="#/history" style="text-decoration:none">历史档案</a>
    </div>
    ${disclaimerHtml()}
  </section>`;

  $("#copy-interp") && $("#copy-interp").addEventListener("click", () => Stream.copyText(text));
  $("#share-text").addEventListener("click", () => PalmShare.copyShareText());
  $("#share-card").addEventListener("click", () => openShareCard(record));
  $("#start-interp").addEventListener("click", () => startInterp(record, cfg));
  $("#stop-interp").addEventListener("click", () => {
    if (interpCtl) interpCtl.abort();
    if (streamCancel) streamCancel();
  });
  $$("#prov-chips .chip").forEach((c) =>
    c.addEventListener("click", async () => {
      const pid = c.dataset.prov;
      try {
        await api("/api/config", { method: "POST", body: { provider: pid } });
        cfg.provider = pid;
        $$("#prov-chips .chip").forEach((x) => x.classList.toggle("active", x.dataset.prov === pid));
        Stream.toast("默认赏析服务：" + cfg.providers[pid].label);
      } catch (e) { Stream.toast(e.message); }
    }));

  // 刚创建且还没有解读 → 自动开始流式赏析
  if (autoStart && !text && !interpBusy) {
    const h = location.hash.replace("!auto", "");
    history.replaceState(null, "", h);
    startInterp(record, cfg);
  }
}

function provChipsHtml(cfg) {
  return Object.entries(cfg.providers || {}).map(([pid, p]) =>
    `<span class="chip ${pid === cfg.provider ? "active" : ""}" data-prov="${pid}">${Stream.esc(p.label)}</span>`).join("");
}

function oldInterpHtml(record) {
  const interps = record.interpretations || [];
  if (interps.length <= 1) return "";
  return `<details class="old-interp"><summary>历史赏析（${interps.length - 1} 次）</summary>${
    interps.slice(0, -1).reverse().map((it) =>
      `<div style="margin-top:10px"><div class="interp-meta">${Stream.esc(it.at || "")}${it.model ? " · " + Stream.esc(it.model) : ""}</div><div class="stream">${Stream.mdStyled(it.text)}</div></div>`).join("")
  }</details>`;
}

let interpCtl = null;

async function startInterp(record, cfg) {
  if (interpBusy) return;
  const area = $("#interp-area");
  const errBox = $("#interp-err");
  const startBtn = $("#start-interp");
  const stopBtn = $("#stop-interp");
  const pid = cfg.provider || "glm";
  const pcfg = cfg.providers ? cfg.providers[pid] : null;
  if (!pcfg) { errBox.hidden = false; errBox.textContent = "未找到赏析服务配置，请到设置页检查。"; return; }

  interpBusy = true;
  startBtn.disabled = true;
  errBox.hidden = true;
  stopBtn.style.display = "";
  const painter = Stream.makePainter(area);
  painter.reset();
  painter.paint(false);

  const t = setInterval(() => { if (!painter.text) painter.paint(false); }, 1000);
  const finish = (errMsg) => {
    clearInterval(t);
    interpBusy = false;
    interpCtl = null;
    streamCancel = null;
    startBtn.disabled = false;
    stopBtn.style.display = "none";
    if (errMsg) {
      painter.text && painter.paint(true);
      errBox.hidden = false;
      errBox.innerHTML = Stream.esc(hintFor(errMsg, pid)).replace(/\n/g, "<br>");
      if (!painter.text) painter.waiting("赏析未完成");
    } else {
      painter.paint(true);
      Stream.toast("赏析完成，已保存");
    }
  };

  const onDelta = (st) => {
    painter.text = neutralize(st.content);
    painter.reason = st.reason || "";
    painter.tick(120);
  };

  try {
    if (MODE === "server") {
      interpCtl = new AbortController();
      const res = await fetch("/api/interpret", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: record.id, provider: pid }),
        signal: interpCtl.signal
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || "HTTP " + res.status);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        painter.text = neutralize(painter.text + dec.decode(value, { stream: true }));
        painter.tick(120);
      }
      finish(null);
    } else {
      const image = record.image || record.thumb;
      if (!image) throw new Error("记录中缺少掌纹图片");

      // 单次尝试（原生插件流式；浏览器退回整段返回），必要时用多模态兜底模型重试
      const runOnce = async (modelOverride) => {
        const model = modelOverride || (await resolveClientModel(pcfg)) || pcfg.model;
        if (!model) throw new Error("未配置模型名，且无法从服务获取模型列表。请在设置里填写模型。");
        const req = clientRequestBody(pcfg, model, record.note, image, true);
        const ns = Stream.nativeStreamHttp()
          ? Stream.nativeStreamRequest(req.url, req.headers, req.payload, onDelta) : null;
        if (ns) {
          streamCancel = ns.cancel;
          return { text: await ns.promise, model };
        }
        return { text: await clientInterpret(pcfg, model, record.note, image), model };
      };

      let out, switched = false;
      try {
        out = await runOnce();
      } catch (e) {
        const confModel = (await resolveClientModel(pcfg)) || pcfg.model;
        if (NO_IMAGE_SUPPORT.test(e.message || "") && confModel !== FALLBACK_VISION_MODEL) {
          switched = true;
          Stream.toast("当前模型不支持图片输入，已自动改用 " + FALLBACK_VISION_MODEL);
          painter.text = "";
          painter.reset();
          out = await runOnce(FALLBACK_VISION_MODEL);
        } else {
          throw e;
        }
      }
      painter.text = neutralize(out.text);
      const meta = PalmPrompt.extractMeta(painter.text);
      meta.model = out.model + (switched ? "（自动切换，原配置模型不支持图片）" : "");
      PalmHistory.saveText(record.id, painter.text, meta);
      finish(null);
    }
    setTimeout(() => renderResult(record.id, false), 600);
  } catch (e) {
    if (e.name === "AbortError" || /cancel/i.test(e.message || "")) {
      painter.text && PalmHistory.saveText(record.id, neutralize(painter.text), PalmPrompt.extractMeta(painter.text));
      painter.paint(true);
      Stream.toast("已停止（已生成部分自动保存）");
      clearInterval(t); interpBusy = false; interpCtl = null; streamCancel = null;
      startBtn.disabled = false; stopBtn.style.display = "none";
      if (painter.text) setTimeout(() => renderResult(record.id, false), 400);
    } else {
      if (painter.text && MODE === "client") {
        PalmHistory.saveText(record.id, neutralize(painter.text), PalmPrompt.extractMeta(painter.text));
      }
      finish(e.message);
    }
  }
}

function hintFor(msg, pid) {
  let out = "赏析失败：" + msg;
  if (/401|403|api.?key|unauthorized/i.test(msg)) {
    out += "\n提示：请到「设置」检查 API Key 是否正确保存。";
  } else if (NO_IMAGE_SUPPORT.test(msg)) {
    out += "\n提示：当前模型不支持图片输入（多模态请求被拒）。请到「设置」把模型改为支持图片的型号，推荐 glm-5.3-flash。";
  } else if (/429|1113|余额|资源包|quota|rate.?limit/i.test(msg)) {
    out += "\n提示：账户额度不足——Coding Plan 需用开通订阅的账号创建「Coding Plan 类型」密钥。";
  } else if (/404|model/i.test(msg)) {
    out += "\n提示：请到「设置」核对模型名称（默认 glm-5.3-flash）。";
  } else if (/image|图片|media/i.test(msg)) {
    out += "\n提示：多模态请求被拒，请确认模型支持图片输入（如 glm-5.3-flash）。";
  }
  return out;
}

// ---------------- 分享卡片弹层 ----------------
async function openShareCard(record) {
  const summary = record.summary || (record.text ? PalmPrompt.extractMeta(record.text).summary : "");
  const mask = document.createElement("div");
  mask.className = "crop-mask";
  mask.innerHTML = `<div class="share-panel"><div class="share-loading">卡片生成中…</div></div>`;
  document.body.appendChild(mask);
  try {
    const dataUrl = await PalmShare.cardDataUrl(record.thumb || record.image, summary);
    mask.innerHTML = `
      <div class="share-panel">
        <img class="share-img" src="${dataUrl}" alt="分享卡片">
        <div class="crop-btns">
          <button class="btn ghost" id="share-save">💾 保存图片</button>
          <button class="btn primary" id="share-close">关闭</button>
        </div>
        <div class="hint">保存后可在相册/文件管理器查看；文案请点「复制分享文案」。</div>
      </div>`;
    mask.querySelector("#share-save").addEventListener("click", () => PalmShare.saveCardImage(dataUrl, "手相观纹"));
    mask.querySelector("#share-close").addEventListener("click", () => mask.remove());
    mask.addEventListener("click", (e) => { if (e.target === mask) mask.remove(); });
  } catch (e) {
    mask.innerHTML = `<div class="share-panel"><div class="err-box">卡片生成失败：${Stream.esc(e.message)}</div></div>`;
    setTimeout(() => mask.remove(), 2500);
  }
}

// ---------------- 历史档案页 ----------------
async function renderHistory() {
  let list = [];
  try { list = await PalmHistory.list(); } catch (e) { /* ignore */ }
  if (!list.length) {
    app.innerHTML = `<section>
      <div class="card empty"><div class="big">🖐️</div>还没有掌纹档案<br><br>
      <a class="btn primary" href="#/scan" style="text-decoration:none">去拍一张</a></div>
      ${disclaimerHtml()}</section>`;
    return;
  }
  app.innerHTML = `<section>
    <div class="card"><h2>掌纹档案 <span class="sub">共 ${list.length} 条${MODE === "client" ? " · 本机存 ${list.length}/" + PalmHistory.MAX_LOCAL : ""}</span></h2>
      ${MODE === "client" ? '<div class="hint">离线模式仅保存在本机浏览器存储（上限 20 条，超出自动清理最早记录）。</div>' : '<div class="hint">服务模式保存在本机 data/palm_records.json，不经任何第三方。</div>'}
    </div>
    ${list.map((r) => `
      <div class="hist-card" data-id="${r.id}">
        ${r.thumb ? `<img class="hist-thumb" src="${r.thumb}" alt="">` : '<div class="hist-thumb none">🖐️</div>'}
        <div class="hist-main">
          <div class="hist-q">${r.summary ? Stream.esc(r.summary) : '<span class="dim">未完成赏析</span>'}</div>
          <div class="hist-meta">
            <span>${Stream.esc(r.created)}</span>
            ${(r.tags || []).slice(0, 3).map((t) => `<span class="tag">${Stream.esc(t)}</span>`).join("")}
          </div>
        </div>
        <button class="hist-del" data-del="${r.id}" title="删除">✕</button>
      </div>`).join("")}
    <div class="btn-row"><button class="btn ghost big" id="clear-all">🗑️ 清空全部档案</button></div>
    ${disclaimerHtml()}
  </section>`;

  $$(".hist-card").forEach((c) =>
    c.addEventListener("click", () => { location.hash = "#/result/" + c.dataset.id; }));
  $$(".hist-del").forEach((b) =>
    b.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      if (!confirm("删除这条记录？")) return;
      try { await PalmHistory.remove(b.dataset.del); } catch (e) { Stream.toast(e.message); }
      renderHistory();
    }));
  $("#clear-all").addEventListener("click", async () => {
    if (!confirm("确定清空全部掌纹档案？该操作不可恢复。")) return;
    try { await PalmHistory.clearAll(); Stream.toast("已清空"); } catch (e) { Stream.toast(e.message); }
    renderHistory();
  });
}

// ---------------- 设置页 ----------------
async function renderSettings() {
  const cfg = await loadConfig(true);
  if (!cfg) { app.innerHTML = '<div class="card"><div class="err-box">无法读取配置</div></div>'; return; }

  app.innerHTML = `
  <section>
    <div class="card">
      <h2>赏析服务 <span class="sub">GLM 多模态 · 流式</span></h2>
      ${Object.entries(cfg.providers).map(([pid, p]) => `
        <div class="prov-card ${pid === cfg.provider ? "default" : ""}" data-pid="${pid}">
          <div class="prov-head">
            <span class="name">${Stream.esc(p.label)} ${pid === cfg.provider ? '<span class="tag red">默认</span>' : ""}</span>
          </div>
          <label class="field">接口地址（Base URL）</label>
          <input type="url" data-f="base" value="${Stream.esc(p.base)}" placeholder="https://open.bigmodel.cn/api/coding/paas/v4">
          <div class="grid2">
            <div>
              <label class="field">API Key</label>
              <input type="password" data-f="api_key" placeholder="${p.has_key ? "已保存（留空则不修改）" : "未设置"}" autocomplete="new-password">
            </div>
            <div>
              <label class="field">模型名 <span style="font-weight:400">（需支持图片的多模态型号）</span></label>
              <input type="text" data-f="model" value="${Stream.esc(p.model)}" placeholder="glm-5.3-flash">
            </div>
          </div>
          <label class="chk-line"><input type="checkbox" data-f="fast" ${p.fast ? "checked" : ""}> 快速模式（关闭深度思考，出结果更快）</label>
          <div class="btn-row">
            <button class="btn small ghost" data-fetchmodels="${pid}">获取模型列表</button>
            <button class="btn small ghost" data-test="${pid}">测试连接</button>
          </div>
          <div class="test-line" data-line="${pid}"></div>
        </div>`).join("")}
      <div class="btn-row"><button class="btn primary big" id="save-cfg">保存设置</button></div>
    </div>
    <div class="card">
      <h2>说明</h2>
      <div class="hint">
        · 当前运行：<b>${MODE === "server" ? "服务器模式（连本机服务，流式输出）" : "离线模式（App 内直连 AI）"}</b><br>
        · <b>GLM 智谱（Coding Plan）</b>：到 open.bigmodel.cn 用<b>开通了 Coding Plan 的账号</b>创建「Coding Plan 类型」API Key 粘贴到上方；模型默认 <code>glm-5.3-flash</code>（多模态），建议保持开启「快速模式」。<br>
        · <b>模型必须选支持图片输入的多模态型号</b>（如 <code>glm-5.3-flash</code>）。纯文本模型（如 glm-5.3）会报「content.type 参数非法 / 1210」；若误选，赏析时会自动改用 glm-5.3-flash 兜底。<br>
        · API Key 只保存在本机（App 为本机存储，服务模式在 <code>data/config.json</code>），请求直连对应服务，不经第三方。<br>
        · <b>离线限制</b>：无服务器/Apk 无网络时，仅能查看本机历史档案与浏览图片，无法进行 AI 赏析。<br>
        · 安全约束：用户备注命中敏感词会被本地拦截（不调用接口）；模型输出经提示词锁死 + 本地中性改写双重把关，绝不输出命运预测与医疗结论。
      </div>
    </div>
    ${disclaimerHtml()}
  </section>`;

  function provField(pid, f) {
    const card = $(`.prov-card[data-pid="${pid}"]`);
    return card && $(`[data-f="${f}"]`, card);
  }
  function cachedModels(pid) {
    try { return JSON.parse(localStorage.getItem("palmread.models." + pid) || "[]"); } catch (e) { return []; }
  }
  function cacheModels(pid, ms) {
    try { localStorage.setItem("palmread.models." + pid, JSON.stringify(ms.slice(0, 80))); } catch (e) { /* 忽略 */ }
  }

  async function saveProviderCfg() {
    const providers = {};
    $$(".prov-card").forEach((card) => {
      const pid = card.dataset.pid;
      const get = (f) => {
        const el = $(`[data-f="${f}"]`, card);
        if (!el) return undefined;
        return el.type === "checkbox" ? el.checked : el.value.trim();
      };
      const p = { base: get("base") || "", model: get("model") || "" };
      if (get("fast") !== undefined) p.fast = get("fast");
      const key = get("api_key");
      if (key) p.api_key = key;
      providers[pid] = p;
    });
    const body = { provider: cfg.provider, providers };
    try { await api("/api/config", { method: "POST", body }); } catch (e) { Stream.toast(e.message); throw e; }
  }

  $$("[data-fetchmodels]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.fetchmodels;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "获取中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        cacheModels(pid, models);
        const mi = provField(pid, "model");
        const good = models.filter((m) => !NON_CHAT_MODEL.test(m));
        if (!mi.value.trim() && good.length) mi.value = good[0];
        line.textContent = models.length
          ? `✓ 发现 ${models.length} 个模型；多模态可用如：${(good.filter((m) => /flash|5\./.test(m)).slice(0, 3).join("、")) || good[0] || "—"}`
          : "✗ 未发现可用模型";
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $$("[data-test]").forEach((b) =>
    b.addEventListener("click", async () => {
      const pid = b.dataset.test;
      const line = $(`[data-line="${pid}"]`);
      line.textContent = "测试中…";
      await saveProviderCfg();
      try {
        const { models } = await api("/api/models?provider=" + pid);
        line.textContent = `✓ 连接正常，可用模型 ${models.length} 个`;
        line.className = "test-line ok-box";
      } catch (e) {
        line.textContent = "✗ " + e.message;
        line.className = "test-line";
      }
    }));

  $("#save-cfg").addEventListener("click", async () => {
    const btn = $("#save-cfg");
    btn.disabled = true;
    try { await saveProviderCfg(); Stream.toast("设置已保存"); } finally { btn.disabled = false; }
  });
}

// ---------------- 启动 ----------------
if (typeof window !== "undefined") {
  window.__palmread = {
    get mode() { return MODE; }, set mode(v) { MODE = v; },
    detectMode, api, clientApi, neutralize
  };
}
PalmHistory.setMode("server"); // 先按服务器模式初始化，detectMode 后修正
detectMode().then(() => { PalmHistory.setMode(MODE); PalmPrompt.loadWords(); route(); });
