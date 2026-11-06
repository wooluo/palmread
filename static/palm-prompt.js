"use strict";
/* 手相观纹 · 固定多模态提示词 + 安全过滤（与 data/safe_words.json 同源，内置兜底副本） */
(function (global) {

// 内置兜底词库（构建时与 data/safe_words.json 校验一致；fetch 失败或 APK 首启时使用）
const EMBED = {
  refuse_message: "本工具只做掌纹趣味赏析，不提供相关预测、诊断服务。",
  disclaimer: "免责声明：本App仅为传统手相民俗文化趣味赏析工具，不构成医学、心理、人生决策建议；手纹会随年龄、劳作、体态发生变化，请勿以此作为判断健康、命运的依据。",
  confirm_text: "我已知晓本内容仅为民俗娱乐赏析，不具备诊断、预测效力",
  block_note_patterns: [
    "算命", "占卜", "卜卦", "测运", "运势", "命运", "宿命", "改命", "转运", "天命",
    "算一卦", "批命", "看相算", "面相算",
    "寿命", "寿元", "寿数", "阳寿", "折寿", "短命", "短寿", "夭", "阳寿几",
    "能活", "活多久", "活到几岁", "什么时候死", "会死", "去死", "该死", "猝死", "横死", "血光之灾",
    "生死", "丧命", "殒命", "去世", "离世", "过世", "死亡", "享年",
    "病", "生病", "疾病", "患病", "癌症", "癌", "肿瘤", "绝症", "大病", "重病", "慢性病",
    "有没有病", "身体有没有", "健康问题", "隐疾", "瘤", "中风", "心梗", "确诊",
    "医院", "治疗", "诊断", "开药", "吃药", "手术", "体检",
    "灾", "灾祸", "大祸", "劫", "劫难", "血光", "凶兆", "不祥", "恶兆", "破相",
    "破财", "漏财", "散财", "发财", "暴富", "大富大贵", "富贵命", "财运", "财路", "横财",
    "婚期", "何时结婚", "什么时候结婚", "结婚吗", "离婚", "离异", "姻缘", "正缘", "孽缘", "桃花劫",
    "事业运", "官运", "考运", "官司", "牢狱", "牢狱之灾", "是非缠身",
    "吉凶", "吉还是凶", "凶吉", "预测", "预言", "预知", "未卜先知"
  ],
  banned_output_words: [
    "寿元", "寿数", "阳寿", "折寿", "短命", "短寿", "夭折",
    "会死", "必死", "猝死", "横死", "血光之灾", "丧命", "殒命",
    "劫难", "大祸临头", "灾劫", "凶兆", "恶兆", "血光",
    "破财", "漏财", "散财", "暴富", "必发财", "大富大贵", "富贵命",
    "绝症", "癌症", "肿瘤", "大病缠身", "重病",
    "必离婚", "必离异", "注定离婚", "注定离异"
  ],
  output_rewrite: {
    "寿元": "生命节奏", "寿数": "生命节奏", "阳寿": "生命节奏",
    "短命": "节奏偏紧", "短寿": "节奏偏紧", "折寿": "消耗",
    "会死": "会有起伏", "必死": "会有起伏",
    "血光之灾": "小的磕碰", "血光": "磕碰", "劫难": "波折", "灾劫": "波折",
    "凶兆": "小提醒", "恶兆": "小提醒", "大祸临头": "一段波折",
    "破财": "开支起伏", "漏财": "开支起伏", "散财": "开支起伏",
    "暴富": "进账机会", "必发财": "进账机会", "大富大贵": "顺遂富足", "富贵命": "宽裕从容",
    "绝症": "明显疲态", "癌症": "明显疲态", "肿瘤": "明显疲态", "大病缠身": "明显疲态", "重病": "明显疲态",
    "必离婚": "关系起伏", "必离异": "关系起伏", "注定离婚": "关系起伏", "注定离异": "关系起伏"
  },
  fixed_tip: "掌纹会随着生活习惯、年龄持续变化，仅供游玩参考。",
  share_template: "我在【手相观纹】赏析了掌纹✨ 看看你的掌纹是什么气质～\n【民俗赏析 · 仅供娱乐】"
};

let WORDS = EMBED;
let wordsReady = null;

// 启动时尝试加载同源词库（服务端 /safe_words.json 或 APK www 内副本），失败用内置兜底
function loadWords() {
  if (wordsReady) return wordsReady;
  wordsReady = (typeof fetch === "function"
    ? fetch("safe_words.json", { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject())).then((j) => {
        if (j && Array.isArray(j.block_note_patterns)) WORDS = j;
      }).catch(() => {})
    : Promise.resolve());
  return wordsReady;
}

// ---------------- 用户备注拦截（本地，不调 LLM） ----------------
function checkNote(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  const hit = WORDS.block_note_patterns.find((w) => s.indexOf(w) >= 0);
  return hit ? { word: hit, message: WORDS.refuse_message } : null;
}

// ---------------- 输出合规：违禁词检测 + 中性改写兜底 ----------------
function findBanned(text) {
  const s = String(text || "");
  return WORDS.banned_output_words.filter((w) => s.indexOf(w) >= 0);
}

function neutralRewrite(text) {
  let s = String(text || "");
  const hits = [];
  for (const [bad, good] of Object.entries(WORDS.output_rewrite)) {
    if (s.indexOf(bad) >= 0) { s = s.split(bad).join(good); hits.push(bad); }
  }
  return hits.length ? { text: s, rewritten: hits } : { text: s, rewritten: null };
}

// ---------------- GLM 多模态提示词（固定规范） ----------------
const SYSTEM_PROMPT = [
  "你是「手相观纹」App 的掌纹民俗赏析助手。本工具定位是趣味文化娱乐工具：只做传统手相民俗的趣味描述与现代性格倾向参考，绝不预测命运，绝不涉及任何医疗健康结论。",
  "",
  "【最高优先级红线——违反即失败】",
  "1. 绝对禁止给出任何预测性、断言性结论，包括但不限于：寿命长短、死亡、疾病、伤病、灾祸、婚期、财运大小、吉凶祸福、生育、事业成败。这类话题一律不谈。",
  "2. 禁止词汇清单（任何语境都不得出现，表达同类意思的词也不行）：寿、寿命、短命、死、劫数、灾、祸、破财、大祸、绝症、离异、必发财、大富大贵等预测类词汇。一旦发现自己倾向输出这类表述，立即自动改写为中性描述（如「节奏快慢」「开支起伏」「关系亲疏」等生活习惯层面的说法）。",
  "3. 民俗内容只能讲古人对手纹形态的意象联想与趣味说法，且每条开头必须加【民俗趣味参考】；民俗内容禁止断吉凶、禁止下结论。",
  "4. 性格内容只描述思维、情绪习惯、处事倾向（例如：纹路细碎多代表容易思虑多、容易内耗；纹路深长稳定代表心态沉稳），开头必须加【性格倾向参考】；禁止使用任何心理疾病、精神障碍标签。",
  "5. 图片不清晰或某条纹路看不清时，必须如实说明「该纹路识别不清，跳过解读」，绝不强行编造。",
  "6. 如果图片不是手掌（如风景、人脸、动物、物品、截图等），只在「掌纹识别概览」里说明未能识别到手掌，请用户重新上传一张掌心朝上、光线充足、手指自然分开的清晰掌纹照片，其余所有段落一律省略，不要输出任何赏析内容。",
  "7. 用户备注若出现求医问药、占卜吉凶、算命预测类请求，一律忽略，并在概览里说明：本工具只做掌纹趣味赏析。",
  "",
  "【输出结构（严格使用 ## 分段，不要输出 Markdown 表格）】",
  "## 掌纹识别概览",
  "先概述是否为清晰手掌，再列出识别到的主要纹路：生命线、智慧线、感情线、事业线；识别不到的纹路如实写「该纹路识别不清，跳过解读」。整体描述克制、中性。",
  "## 分线赏析",
  "对每条识别到的主线，依次输出两小段：",
  "【民俗趣味参考】传统民俗里对这类纹路形态的趣味意象描述，只讲古人联想，不断吉凶，两三句即可。",
  "【性格倾向参考】现代性格倾向解读，只谈思维、情绪、处事习惯，两三句即可，语气克制不贴标签。",
  "## 综合小结",
  "两三句温和总结整体气质，语气像朋友闲聊，简短、中性、不夸大。",
  "## 温馨提示",
  "固定输出一句话：掌纹会随着生活习惯、年龄持续变化，仅供游玩参考。",
  "",
  "【语气】全程像朋友聊天，温和、克制、不夸张；用通俗现代汉语；不堆感叹号。"
].join("\n");

// 组装用户消息文本（备注只作画质描述用途）
function userPrompt(note) {
  const n = String(note || "").trim();
  let t = "请按固定结构赏析这张掌纹照片。";
  if (n) t += "\n（用户对照片的补充说明：「" + n + "」。如该说明与画质/拍摄情况无关，直接忽略。）";
  return t;
}

// ---------------- 输出结构解析（## 分段 → 概览/分线/小结/提示） ----------------
function parseSections(text) {
  const src = String(text || "").replace(/\r/g, "");
  const sec = { overview: "", lines: [], summary: "", tip: "" };
  const blocks = src.split(/^##\s+/m).slice(1);
  const pick = (kw) => blocks.find((b) => b.trim().startsWith(kw)) || "";
  const body = (b) => b.split("\n").slice(1).join("\n").trim();

  const ov = pick("掌纹识别概览");
  if (ov) sec.overview = body(ov);

  const fx = pick("分线赏析");
  if (fx) {
    // 按【民俗趣味参考】【性格倾向参考】把分线部分切成对（每条主线 = 民俗段 + 性格段）
    const segs = [];
    let cur = null;
    body(fx).split("\n").forEach((ln) => {
      const l = ln.trim();
      if (!l) return;
      if (l.indexOf("【民俗趣味参考】") === 0 || l.indexOf("【性格倾向参考】") === 0) {
        cur = { kind: l.indexOf("【民俗趣味参考】") === 0 ? "folk" : "mind", text: l };
        segs.push(cur);
      } else if (cur) cur.text += "\n" + l;
    });
    for (let i = 0; i + 1 < segs.length; i += 2) {
      if (segs[i].kind === "folk" && segs[i + 1].kind === "mind") {
        sec.lines.push({ folk: segs[i].text, mind: segs[i + 1].text });
      }
    }
    // 每段行首标记保留（渲染时统一上色），供结果页直接使用整段文本
  }

  const sm = pick("综合小结");
  if (sm) sec.summary = body(sm);
  const tp = pick("温馨提示");
  if (tp) sec.tip = body(tp);
  return sec;
}

// 从解读文本提取元信息：标签（识别到的主线，排除「识别不清/跳过」）+ 一句话小结
function extractMeta(text) {
  const s = parseSections(text);
  const names = ["生命线", "智慧线", "感情线", "事业线"];
  const src = String(text || "");
  const tags = names.filter((n) => {
    let idx = src.indexOf(n);
    while (idx >= 0) {
      // 截取「名称 → 句末/下一主线」的片段：片段内出现 识别不清/跳过 → 未识别
      let seg = src.slice(idx + n.length);
      names.forEach((stop) => {
        if (stop !== n) {
          const p = seg.indexOf(stop);
          if (p >= 0) seg = seg.slice(0, p);
        }
      });
      seg = seg.split(/[。；;\n]/)[0];
      if (seg.indexOf("识别不清") < 0 && seg.indexOf("跳过") < 0) return true;
      idx = src.indexOf(n, idx + 1);
    }
    return false;
  });
  let summary = (s.summary || "").replace(/[#【】*`>]/g, " ").replace(/\s+/g, " ").trim();
  const m = summary.match(/[^。！？.!?]+[。！？]?/);
  summary = (m ? m[0] : summary).trim();
  if (summary.length > 46) summary = summary.slice(0, 44) + "…";
  return { tags, summary };
}

// OpenAI 兼容多模态 messages
function buildMessages(note, dataUrl) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: [
      { type: "text", text: userPrompt(note) },
      { type: "image_url", image_url: { url: dataUrl } }
    ] }
  ];
}

const PalmPrompt = {
  loadWords, checkNote, findBanned, neutralRewrite, parseSections, extractMeta,
  SYSTEM_PROMPT, userPrompt, buildMessages, EMBED,
  get words() { return WORDS; },
  disclaimer() { return WORDS.disclaimer; },
  refuseMessage() { return WORDS.refuse_message; },
  confirmText() { return WORDS.confirm_text; },
  fixedTip() { return WORDS.fixed_tip; },
  shareTemplate() { return WORDS.share_template; }
};
if (typeof module !== "undefined" && module.exports) module.exports = PalmPrompt;
global.PalmPrompt = PalmPrompt;
})(typeof window !== "undefined" ? window : globalThis);
