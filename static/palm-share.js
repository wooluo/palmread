"use strict";
/* 手相观纹 · 分享卡片：Canvas 绘制古风宣纸卡片 + 复制文案 + 保存图片（Capacitor Filesystem / 浏览器下载） */
(function (global) {

const CARD_W = 750, CARD_H = 1000;

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

// 圆角矩形路径
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 文本自动换行（中文按字符断行）
function wrap(ctx, text, maxW) {
  const lines = [];
  let line = "";
  for (const ch of String(text || "")) {
    if (ch === "\n") { lines.push(line); line = ""; continue; }
    if (ctx.measureText(line + ch).width > maxW) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  return lines;
}

/** 绘制分享卡片（宣纸底 + 掌纹小图 + 一句话小结 + App 名 + 小字免责） */
async function drawCard(thumbDataUrl, summary) {
  const c = document.createElement("canvas");
  c.width = CARD_W; c.height = CARD_H;
  const ctx = c.getContext("2d");

  // 宣纸底：米色渐变 + 细纹理
  const bg = ctx.createLinearGradient(0, 0, 0, CARD_H);
  bg.addColorStop(0, "#f4ecd8");
  bg.addColorStop(0.6, "#efe5cb");
  bg.addColorStop(1, "#e9dcbe");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);
  ctx.globalAlpha = 0.05;
  ctx.strokeStyle = "#8a6d3b";
  for (let y = 40; y < CARD_H; y += 26) {
    ctx.beginPath();
    ctx.moveTo(0, y + Math.sin(y) * 1.5);
    ctx.lineTo(CARD_W, y + Math.cos(y * 0.7) * 1.5);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 朱砂印章式顶标 + 标题
  ctx.fillStyle = "#a8402f";
  rr(ctx, CARD_W / 2 - 44, 54, 88, 88, 18);
  ctx.fill();
  ctx.fillStyle = "#fff6ea";
  ctx.font = "600 50px 'Songti SC','STSong',serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText("掌", CARD_W / 2, 100);

  ctx.fillStyle = "#5a4632";
  ctx.font = "700 60px 'Songti SC','STSong',serif";
  ctx.fillText("手 相 观 纹", CARD_W / 2, 206);
  ctx.fillStyle = "#9a8a68";
  ctx.font = "25px sans-serif";
  ctx.fillText("掌纹民俗图像赏析 · 仅供参考", CARD_W / 2, 262);

  // 手掌缩略图（圆角方框）
  const IMG = 400, ix = (CARD_W - IMG) / 2, iy = 302;
  ctx.save();
  rr(ctx, ix, iy, IMG, IMG, 24);
  ctx.clip();
  ctx.fillStyle = "#fbf5e6";
  ctx.fillRect(ix, iy, IMG, IMG);
  if (thumbDataUrl) {
    try {
      const img = await loadImg(thumbDataUrl);
      const side = Math.min(img.width, img.height);
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side,
        ix, iy, IMG, IMG);
    } catch (e) { /* 缺图时保留底色 */ }
  }
  ctx.restore();
  ctx.strokeStyle = "rgba(138,109,59,0.45)";
  ctx.lineWidth = 3;
  rr(ctx, ix, iy, IMG, IMG, 24);
  ctx.stroke();

  // 一句话小结（最多 3 行，超出省略）
  let text = String(summary || "掌纹里的气质小赏析，等你来试试～").trim();
  ctx.font = "32px 'PingFang SC','Microsoft YaHei',sans-serif";
  const MAX_LINES = 3, LH = 46, SUMMARY_TOP = 748;
  let lines = wrap(ctx, text, CARD_W - 150);
  if (lines.length > MAX_LINES) {
    lines = lines.slice(0, MAX_LINES);
    let last = lines[MAX_LINES - 1];
    while (last.length > 1 && ctx.measureText(last + "…").width > CARD_W - 150) {
      last = last.slice(0, -1);
    }
    lines[MAX_LINES - 1] = last + "…";
  }
  ctx.fillStyle = "#4a3d2c";
  let ty = SUMMARY_TOP;
  lines.forEach((ln) => { ctx.fillText(ln, CARD_W / 2, ty); ty += LH; });

  // 底部：App 名 + 小字免责（固定位置，与小结区间隔充足，绝不重叠）
  ctx.fillStyle = "#8a6d3b";
  ctx.font = "600 29px 'Songti SC','STSong',serif";
  ctx.fillText("—— 手相观纹 · 趣味民俗赏析 ——", CARD_W / 2, 912);
  ctx.fillStyle = "#a5987d";
  ctx.font = "19px sans-serif";
  const disc = "民俗赏析仅供娱乐，不构成医学、心理、人生决策建议";
  ctx.fillText(disc, CARD_W / 2, 950);

  return c;
}

async function cardDataUrl(thumb, summary) {
  return (await drawCard(thumb, summary)).toDataURL("image/png");
}

/** 复制分享文案（精简模板，不泄露完整解读，引导他人自己上传） */
async function copyShareText() {
  const PalmPrompt = global.PalmPrompt;
  const Stream = global.Stream;
  await Stream.copyText(PalmPrompt.shareTemplate());
}

/** 保存卡片图片：原生 App 走 Capacitor Filesystem，浏览器走下载 */
async function saveCardImage(dataUrl, nameHint) {
  const cap = global.Capacitor;
  const isNative = cap && cap.isNativePlatform && cap.isNativePlatform();
  const base64 = dataUrl.split(",")[1];
  const name = (nameHint || "palmread-card") + "-" + Date.now() + ".png";

  if (isNative && cap.Plugins && cap.Plugins.Filesystem) {
    const FS = cap.Plugins.Filesystem;
    try {
      // 先尝试公共 Documents 目录（文件管理器可见）
      await FS.writeFile({
        path: name, data: base64, directory: "DOCUMENTS", recursive: true
      });
      global.Stream.toast("已保存到 Documents/" + name);
      return true;
    } catch (e) {
      try {
        await FS.writeFile({ path: name, data: base64, directory: "CACHE" });
        global.Stream.toast("已保存：" + name);
        return true;
      } catch (e2) {
        global.Stream.toast("保存失败：" + (e2.message || e2));
        return false;
      }
    }
  }

  // 浏览器：触发下载
  try {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    global.Stream.toast("卡片已开始下载");
    return true;
  } catch (e) {
    global.Stream.toast("当前环境不支持保存图片");
    return false;
  }
}

const PalmShare = { drawCard, cardDataUrl, copyShareText, saveCardImage, CARD_W, CARD_H };
if (typeof module !== "undefined" && module.exports) module.exports = PalmShare;
global.PalmShare = PalmShare;
})(typeof window !== "undefined" ? window : globalThis);
