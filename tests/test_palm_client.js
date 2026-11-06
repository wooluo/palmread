/* 离线（client）模式自动化测试：在 Node 中加载前端模块（带极简 DOM 桩），
 * 验证 模式切换（含 WebView 200-HTML 兜底误判坑）/ 备注拦截 / 历史存档 20 条上限 /
 * 中性改写 / 分享文案与卡片保存（Capacitor Filesystem 桩）。
 * 运行：node tests/test_palm_client.js */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

// ---- 极简 DOM/浏览器桩 ----
const magic = new Proxy(function () {}, {
  get(t, p) {
    if (p === Symbol.iterator) return () => ({ next: () => ({ done: true }) });
    if (p === "then") return undefined;
    return magic;
  },
  set() { return true; },
  apply() { return magic; }
});

const mem = new Map();
const clipboardWrites = [];
const fsWrites = [];

function makeSandbox(over) {
  const sb = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    performance: { now: () => Date.now() },
    URLSearchParams, URL, TextDecoder, AbortController, Image: function () {},
    navigator: { clipboard: { writeText: async (t) => { clipboardWrites.push(t); } } },
    location: { hash: "#/scan" },
    localStorage: {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k)
    },
    document: magic, confirm: () => true, alert: () => {},
    addEventListener: () => {}, scrollTo: () => {},
    fetch: () => Promise.reject(new Error("no server")),
    history: { replaceState: () => {} }
  };
  sb.window = sb;
  sb.globalThis = sb;
  Object.assign(sb, over || {});
  return sb;
}

const root = path.join(__dirname, "..");
function loadModule(sandbox, file) {
  const code = fs.readFileSync(path.join(root, "static", file), "utf8");
  // 让 require 型 module.exports 生效：给 vm 环境注入 module
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.runInContext(code, sandbox, { filename: file });
  const exp = sandbox.module.exports;
  delete sandbox.module;
  delete sandbox.exports;
  return exp;
}

(async () => {
  let sandbox = makeSandbox();
  vm.createContext(sandbox);
  loadModule(sandbox, "stream.js");
  loadModule(sandbox, "palm-prompt.js");
  loadModule(sandbox, "palm-upload.js");
  loadModule(sandbox, "palm-history.js");
  loadModule(sandbox, "palm-share.js");
  loadModule(sandbox, "app.js");

  const PR = sandbox.PalmPrompt;
  const HIST = sandbox.PalmHistory;
  const SHARE = sandbox.PalmShare;
  const HOOK = sandbox.__palmread;

  // Image 解码在 Node 里无法完成 → 给缩略图打桩（create() 调用时动态取 global.PalmUpload）
  sandbox.PalmUpload.makeThumb = async () => "data:image/jpeg;base64,thumbstub";

  await new Promise((r) => setTimeout(r, 150)); // 等 detectMode 落定

  // 1) 模式切换：node 无服务器 → 离线模式
  assert.strictEqual(HOOK.mode, "client", "无服务器应自动进入离线模式");
  console.log("✓ 模式探测：无服务 → client");

  // 2) WebView 200-HTML 兜底误判坑：返回 index.html（HTML）也必须判离线
  sandbox.fetch = async () => ({
    ok: true, headers: { get: (k) => (k.toLowerCase() === "content-type" ? "text/html" : "") },
    json: async () => ({})
  });
  await HOOK.detectMode();
  assert.strictEqual(HOOK.mode, "client", "200+HTML 不得误判为服务器模式");
  console.log("✓ 模式探测：WebView 200-HTML 兜底 → 仍为 client（不误判）");

  // 3) 服务器存在（JSON 含 providers）→ server
  sandbox.fetch = async () => ({
    ok: true, headers: { get: () => "application/json" },
    json: async () => ({ providers: { glm: {} } })
  });
  await HOOK.detectMode();
  assert.strictEqual(HOOK.mode, "server", "JSON providers 应判定 server");
  sandbox.fetch = () => Promise.reject(new Error("no server"));
  await HOOK.detectMode();
  assert.strictEqual(HOOK.mode, "client");
  console.log("✓ 模式探测：JSON providers → server，恢复无服务 → client");

  // 4) 备注敏感词本地拦截
  for (const bad of ["帮我算命", "能活多久", "有没有病", "财运如何", "什么时候结婚", "测测吉凶"]) {
    const hit = PR.checkNote(bad);
    assert.ok(hit && hit.message.indexOf("不提供相关预测、诊断服务") >= 0, "应拦截：" + bad);
  }
  assert.strictEqual(PR.checkNote("左手，室内灯光"), null, "正常备注不拦");
  assert.strictEqual(PR.checkNote(""), null);
  console.log("✓ 备注敏感词拦截：疾病/生死/算命/财运/婚期全拦，正常备注放行");

  // 5) 历史存档（离线 localStorage）：拦截不落档、20 条上限自动清理
  HIST.setMode("client");
  const IMG = "data:image/jpeg;base64,stub";
  let evictedTotal = 0;
  let firstId = null;
  for (let i = 0; i < 22; i++) {
    const { record, evicted } = await HIST.create(IMG, "第" + i + "张 左手");
    evictedTotal += evicted;
    if (i === 0) firstId = record.id;
  }
  let list = await HIST.list();
  assert.strictEqual(list.length, HIST.MAX_LOCAL, "上限 20 条");
  assert.strictEqual(evictedTotal, 2, "应清理最早 2 条");
  assert.ok(!list.some((r) => r.id === firstId), "最早记录已被清理");
  console.log("✓ 历史存档：22 条创建 → 保留 20 条，最早 2 条自动清理");

  // 敏感备注：create 直接抛 blocked，不落档
  const before = mem.get("palmread.records").length;
  await assert.rejects(
    () => HIST.create(IMG, "帮我看看寿命"),
    (e) => e.blocked === true && e.message.indexOf("不提供相关预测、诊断服务") >= 0
  );
  assert.strictEqual(mem.get("palmread.records").length, before, "拦截后不得新增记录");
  console.log("✓ 敏感备注：create 阶段拦截，零网络请求、零落档");

  // 6) 记录查看 / 保存解读 / 删除 / 清空
  const one = await HIST.get(list[0].id);
  assert.ok(one.id);
  HIST.saveText(list[0].id, "## 综合小结\n整体气质温和踏实。这一手纹很有自己的节奏。",
    PR.extractMeta("识别到生命线、智慧线；事业线识别不清，跳过解读。\n## 综合小结\n整体气质温和踏实。这一手纹很有自己的节奏。"));
  const saved = await HIST.get(list[0].id);
  assert.strictEqual(saved.text.indexOf("## 综合小结"), 0);
  assert.strictEqual(saved.tags.length, 2, "识别不清的主线不进标签");
  assert.ok(saved.summary.indexOf("整体气质温和踏实") === 0);
  assert.strictEqual((await HIST.list()).length, 20);
  await HIST.remove(list[1].id);
  assert.strictEqual((await HIST.list()).length, 19);
  await HIST.clearAll();
  assert.strictEqual((await HIST.list()).length, 0);
  console.log("✓ 历史存档：查看/保存解读/删除/清空均正常");

  // 7) 输出中性改写（客户端兜底，幂等）
  const raw = "纹路显示近期注意破财，有短命之相，但必发财。";
  const fixed1 = HOOK.neutralize(raw);
  const fixed2 = HOOK.neutralize(fixed1);
  assert.ok(fixed1.indexOf("破财") < 0 && fixed1.indexOf("短命") < 0 && fixed1.indexOf("必发财") < 0);
  assert.strictEqual(fixed1, fixed2, "neutralize 应幂等");
  assert.ok(fixed1.indexOf("已自动转换为中性表述") >= 0);
  const clean = HOOK.neutralize("纹路深长，心态沉稳。");
  assert.ok(clean.indexOf("系统提示") < 0, "干净文本不应加标记");
  console.log("✓ 中性改写：违禁词转中性表述，幂等，干净文本不受影响");

  // 8) 输出结构解析（JS 侧）
  const sample = "## 掌纹识别概览\n识别到生命线。\n## 分线赏析\n【民俗趣味参考】古人叫它地纹。\n【性格倾向参考】心态沉稳。\n## 综合小结\n温和踏实。\n## 温馨提示\n仅供游玩参考。";
  const sec = PR.parseSections(sample);
  assert.strictEqual(sec.lines.length, 1);
  assert.ok(sec.lines[0].folk.indexOf("地纹") >= 0);
  assert.ok(sec.summary.indexOf("温和踏实") === 0);
  assert.ok(PR.SYSTEM_PROMPT.indexOf("最高优先级红线") > 0);
  assert.ok(PR.SYSTEM_PROMPT.indexOf("识别不清，跳过解读") > 0);
  console.log("✓ 结构解析：分线对齐（民俗+性格）、小结/提示齐全，提示词含红线");

  // 9) 词库同步：JS 内置兜底 ≡ data/safe_words.json（跨 vm realm 用 JSON 字符串比较）
  const sw = JSON.parse(fs.readFileSync(path.join(root, "data", "safe_words.json"), "utf8"));
  assert.strictEqual(JSON.stringify(PR.EMBED.block_note_patterns), JSON.stringify(sw.block_note_patterns), "block_note_patterns 必须同步");
  assert.strictEqual(JSON.stringify(PR.EMBED.banned_output_words), JSON.stringify(sw.banned_output_words), "banned_output_words 必须同步");
  assert.strictEqual(JSON.stringify(PR.EMBED.output_rewrite), JSON.stringify(sw.output_rewrite), "output_rewrite 必须同步");
  assert.strictEqual(PR.EMBED.disclaimer, sw.disclaimer);
  assert.strictEqual(PR.EMBED.share_template, sw.share_template);
  console.log("✓ 词库同步：JS 内置兜底与 data/safe_words.json 完全一致");

  // 10) 分享：复制模板文案 + Capacitor Filesystem 保存卡片
  await SHARE.copyShareText();
  assert.strictEqual(clipboardWrites.length, 1);
  assert.strictEqual(clipboardWrites[0], sw.share_template, "分享文案 = 固定模板");
  assert.ok(clipboardWrites[0].indexOf("手相观纹") >= 0);
  assert.ok(clipboardWrites[0].indexOf("民俗赏析 · 仅供娱乐") >= 0);

  sandbox.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      Filesystem: {
        writeFile: async (opts) => { fsWrites.push(opts); return { uri: "file:///Documents/" + opts.path }; }
      }
    }
  };
  const okSave = await SHARE.saveCardImage("data:image/png;base64,aGVsbG8=", "手相观纹");
  assert.ok(okSave);
  assert.strictEqual(fsWrites.length, 1);
  assert.strictEqual(fsWrites[0].directory, "DOCUMENTS");
  assert.ok(fsWrites[0].path.indexOf(".png") > 0);
  assert.strictEqual(fsWrites[0].data, "aGVsbG8=", "应写入剥离 dataURL 前缀的 base64");
  console.log("✓ 分享：文案模板复制 + 原生 Filesystem 保存卡片正常");

  // 11) 关键回归：结果页直连必须用未脱敏配置（api_key 丢失 → 401）
  mem.set("palmread.config", JSON.stringify({ provider: "glm", providers: { glm: {
    label: "GLM", base: "https://open.bigmodel.cn/api/coding/paas/v4",
    model: "glm-5.3-flash", api_key: "test-key-abc", fast: true } } }));
  const masked = await HOOK.api("/api/config");
  assert.strictEqual(masked.providers.glm.api_key, "", "对外展示配置应脱敏 api_key");
  assert.strictEqual(masked.providers.glm.has_key, true, "脱敏配置保留 has_key 标记");
  const rawCfg = HOOK.clientRawProviderConfig("glm");
  assert.ok(rawCfg && rawCfg.api_key === "test-key-abc", "直连必须取到原始 api_key（否则 401）");
  mem.set("palmread.config", JSON.stringify({}));
  console.log("✓ 配置脱敏/直连分离：展示 api_key 置空，直连取原始 Key（修 401 回归）");

  console.log("\n全部离线模式测试通过 ✅");
})().catch((e) => { console.error("✗ " + (e && e.message)); console.error(e); process.exit(1); });
