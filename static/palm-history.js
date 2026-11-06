"use strict";
/* 手相观纹 · 掌纹记录存储：服务端模式走 data/palm_records.json；离线模式存 localStorage（上限 20 条） */
(function (global) {

const LS_KEY = "palmread.records";
const MAX_LOCAL = 20;

function lsGet() {
  try { const v = JSON.parse(localStorage.getItem(LS_KEY)); return Array.isArray(v) ? v : []; }
  catch (e) { return []; }
}
function lsSet(list) { localStorage.setItem(LS_KEY, JSON.stringify(list)); }

let MODE = "server"; // 由 app.js 在 detectMode 后调用 PalmHistory.setMode
function setMode(m) { MODE = m === "client" ? "client" : "server"; }

async function api(path, opts = {}) {
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

function makeId() {
  const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
  return "" + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
    + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    + "-" + String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

function fmtNow() {
  const d = new Date(), p = (n) => (n < 10 ? "0" : "") + n;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 新建赏析记录（含本地备注安全拦截 → 命中即抛 err.blocked，不发起任何网络请求）
 * @returns {{record, evicted: number}}
 */
async function create(image, note) {
  const PalmPrompt = global.PalmPrompt;
  const hit = PalmPrompt && PalmPrompt.checkNote(note);
  if (hit) {
    const err = new Error(hit.message);
    err.blocked = true;
    throw err;
  }
  const PalmUpload = global.PalmUpload;
  const thumb = PalmUpload ? await PalmUpload.makeThumb(image) : "";

  if (MODE === "server") {
    const { record } = await api("/api/analyze", { method: "POST", body: { image, note: note || "" } });
    return { record, evicted: 0 };
  }

  // 离线：localStorage，超限自动清理最早记录
  const list = lsGet();
  const preview = PalmUpload ? await PalmUpload.makeThumb(image, 480) : ""; // 供重看与重赏析
  const record = {
    id: makeId(), created: fmtNow(),
    note: String(note || "").slice(0, 100),
    image: preview, thumb, text: "", tags: [], summary: "",
    interpretations: []
  };
  list.unshift(record);
  let evicted = 0;
  while (list.length > MAX_LOCAL) { list.pop(); evicted++; }
  lsSet(list);
  return { record, evicted };
}

async function list() {
  if (MODE === "server") {
    const { records } = await api("/api/records");
    return records;
  }
  return lsGet().map((r) => ({
    id: r.id, created: r.created, note: r.note || "",
    thumb: r.thumb || "", tags: r.tags || [], summary: r.summary || "",
    interpretations: (r.interpretations || []).length
  }));
}

async function get(id) {
  if (MODE === "server") {
    const { record } = await api("/api/records/" + id);
    return record;
  }
  const r = lsGet().find((x) => x.id === id);
  if (!r) { const e = new Error("记录不存在"); e.notFound = true; throw e; }
  return r;
}

async function remove(id) {
  if (MODE === "server") return api("/api/records/" + id, { method: "DELETE" });
  lsSet(lsGet().filter((x) => x.id !== id));
  return { ok: true };
}

async function clearAll() {
  if (MODE === "server") return api("/api/records", { method: "DELETE" });
  lsSet([]);
  return { ok: true };
}

// 离线模式流式结束后保存解读文本（服务端模式由服务自动存档，无需调用）
function saveText(id, text, meta) {
  if (MODE === "server") return;
  const list = lsGet();
  const target = list.find((x) => x.id === id);
  if (!target || !text) return;
  target.interpretations = target.interpretations || [];
  target.interpretations.push({ at: fmtNow(), text, model: (meta && meta.model) || "" });
  target.text = text;
  if (meta) {
    target.tags = meta.tags || target.tags || [];
    target.summary = meta.summary || target.summary || "";
  }
  lsSet(list);
}

const PalmHistory = { setMode, create, list, get, remove, clearAll, saveText, MAX_LOCAL, get mode() { return MODE; } };
if (typeof module !== "undefined" && module.exports) module.exports = PalmHistory;
global.PalmHistory = PalmHistory;
})(typeof window !== "undefined" ? window : globalThis);
