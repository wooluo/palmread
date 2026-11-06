"use strict";
/* 手相观纹 · 图片上传模块：相机/相册唤起、分辨率压缩、固定正方形裁剪框、预览（原生 JS 零依赖） */
(function (global) {

const OUT_SIZE = 1000;     // 裁剪输出边长（px）
const OUT_QUALITY = 0.82;  // JPEG 质量 —— 控制上传体积（一般 150~350KB）

function nativeCap() {
  const cap = global.Capacitor;
  return (cap && cap.isNativePlatform && cap.isNativePlatform()) ? cap : null;
}

function pickFile(capture) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    if (capture) input.setAttribute("capture", "environment");
    input.style.display = "none";
    document.body.appendChild(input);
    let done = false;
    input.addEventListener("change", () => {
      done = true;
      const f = input.files && input.files[0];
      input.remove();
      if (!f) return resolve(null);
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result));
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(f);
    });
    // 取消选择（focus 回到页面）后稍等清理
    window.addEventListener("focus", function onCancel() {
      setTimeout(() => { if (!done) { input.remove(); resolve(null); } window.removeEventListener("focus", onCancel); }, 300);
    }, { once: true });
    input.click();
  });
}

// 原生环境：Capacitor 相机插件；浏览器：文件选择（capture 起系统相机）
async function openCamera() {
  const cap = nativeCap();
  const Camera = cap && cap.Plugins && cap.Plugins.Camera;
  if (Camera) {
    try {
      const photo = await Camera.getPhoto({
        resultType: "DataUrl", source: "Camera",
        quality: 90, width: 2048, height: 2048, correctOrientation: true, saveToGallery: false
      });
      return photo.dataUrl || photo;
    } catch (e) { return null; } // 用户取消
  }
  return pickFile(true);
}

async function openAlbum() {
  const cap = nativeCap();
  const Camera = cap && cap.Plugins && cap.Plugins.Camera;
  if (Camera) {
    try {
      const photo = await Camera.getPhoto({
        resultType: "DataUrl", source: "Photos",
        quality: 90, width: 2048, height: 2048, correctOrientation: true
      });
      return photo.dataUrl || photo;
    } catch (e) { return null; }
  }
  return pickFile(false);
}

function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片读取失败"));
    img.src = dataUrl;
  });
}

// ---------------- 正方形裁剪弹层 ----------------
// 固定正方形取景框（掌心主体），拖动移动、双指/滑杆缩放，输出 OUT_SIZE² JPEG
function showCrop(dataUrl) {
  return new Promise((resolve) => {
    const VIEW = 560;                      // 画布内部分辨率
    const CROP = Math.round(VIEW * 0.78);  // 固定裁剪框（内部坐标）
    let img = null;
    let scale = 1, base = 1, ox = 0, oy = 0; // ox/oy：图片中心相对视口中心的偏移（内部坐标）
    let dragging = false, lastX = 0, lastY = 0, pinchDist = 0, pinchScale = 1;

    const wrap = document.createElement("div");
    wrap.className = "crop-mask";
    wrap.innerHTML = `
      <div class="crop-panel">
        <div class="crop-title">对齐手掌 <span>把掌心放进方框 · 手指自然分开</span></div>
        <div class="crop-stage" id="crop-stage">
          <canvas id="crop-canvas" width="${VIEW}" height="${VIEW}"></canvas>
          <div class="crop-frame" style="width:${(CROP / VIEW * 100).toFixed(1)}%;height:${(CROP / VIEW * 100).toFixed(1)}%">
            <i class="c c1"></i><i class="c c2"></i><i class="c c3"></i><i class="c c4"></i>
          </div>
        </div>
        <div class="crop-zoom">
          <span>缩放</span>
          <input type="range" id="crop-zoom" min="1" max="4" step="0.01" value="1">
        </div>
        <div class="crop-hint">掌心朝上 · 光线充足 · 手掌放平 · 不要逆光、不要遮挡掌纹</div>
        <div class="crop-btns">
          <button class="btn ghost" id="crop-cancel">取消</button>
          <button class="btn primary" id="crop-ok">就选这张</button>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    const canvas = wrap.querySelector("#crop-canvas");
    const ctx = canvas.getContext("2d");
    const zoomEl = wrap.querySelector("#crop-zoom");
    const stage = wrap.querySelector("#crop-stage");

    const clamp = () => {
      // 图片必须始终覆盖裁剪框
      const half = CROP / 2 * scale / base; // 相对视口中心允许的最大偏移（内部坐标）
      const limitX = Math.max(0, img.width * scale / 2 - CROP / 2);
      const limitY = Math.max(0, img.height * scale / 2 - CROP / 2);
      const lim = Math.min(limitX, limitY);
      ox = Math.max(-lim, Math.min(lim, ox));
      oy = Math.max(-lim, Math.min(lim, oy));
    };

    function draw() {
      const vw = VIEW, vh = VIEW;
      ctx.clearRect(0, 0, vw, vh);
      ctx.fillStyle = "#241f18";
      ctx.fillRect(0, 0, vw, vh);
      if (!img) return;
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, vw / 2 + ox - w / 2, vh / 2 + oy - h / 2, w, h);
    }

    function setBase() {
      base = CROP / Math.min(img.width, img.height) * 1.04; // 略放大避免边缘缝隙
      scale = base * parseFloat(zoomEl.value);
      ox = 0; oy = 0;
      draw();
    }

    loadImage(dataUrl).then((im) => { img = im; setBase(); }).catch(() => { close(); resolve(null); });

    // 拖动（鼠标 + 单指）
    function pos(e) {
      const r = canvas.getBoundingClientRect();
      const p = e.touches ? e.touches[0] : e;
      return { x: (p.clientX - r.left) / r.width * VIEW, y: (p.clientY - r.top) / r.height * VIEW };
    }
    function down(e) {
      if (e.touches && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchDist = Math.hypot(dx, dy); pinchScale = scale;
        return;
      }
      dragging = true; const p = pos(e); lastX = p.x; lastY = p.y;
    }
    function move(e) {
      if (e.touches && e.touches.length === 2) {
        e.preventDefault();
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const d = Math.hypot(dx, dy);
        if (pinchDist > 0) {
          scale = Math.max(base, Math.min(base * 4, pinchScale * d / pinchDist));
          zoomEl.value = (scale / base).toFixed(2);
          clamp(); draw();
        }
        return;
      }
      if (!dragging) return;
      e.preventDefault();
      const p = pos(e);
      ox += p.x - lastX; oy += p.y - lastY;
      lastX = p.x; lastY = p.y;
      clamp(); draw();
    }
    function up() { dragging = false; pinchDist = 0; }
    stage.addEventListener("mousedown", down); stage.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    stage.addEventListener("touchstart", down, { passive: true });
    stage.addEventListener("touchmove", move, { passive: false });
    stage.addEventListener("touchend", up);
    zoomEl.addEventListener("input", () => {
      if (!img) return;
      scale = base * parseFloat(zoomEl.value);
      clamp(); draw();
    });

    function close() {
      window.removeEventListener("mouseup", up);
      wrap.remove();
    }

    wrap.querySelector("#crop-cancel").addEventListener("click", () => { close(); resolve(null); });

    wrap.querySelector("#crop-ok").addEventListener("click", () => {
      if (!img) return;
      // 裁剪框（内部坐标）映射回源图，输出正方形
      const cx = VIEW / 2 + ox, cy = VIEW / 2 + oy;
      const srcSize = CROP / scale;
      const sx = img.width / 2 + (cx - VIEW / 2) / scale - srcSize / 2;
      const sy = img.height / 2 + (cy - VIEW / 2) / scale - srcSize / 2;
      const out = document.createElement("canvas");
      out.width = OUT_SIZE; out.height = OUT_SIZE;
      out.getContext("2d").drawImage(img, sx, sy, srcSize, srcSize, 0, 0, OUT_SIZE, OUT_SIZE);
      const result = out.toDataURL("image/jpeg", OUT_QUALITY);
      close();
      resolve(result);
    });
  });
}

// 生成正方形缩略/预览图（中心裁剪，控制本地存储体积；默认 240px）
async function makeThumb(dataUrl, size) {
  const s = size || 240;
  try {
    const img = await loadImage(dataUrl);
    const out = document.createElement("canvas");
    out.width = s; out.height = s;
    const side = Math.min(img.width, img.height);
    out.getContext("2d").drawImage(
      img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, s, s);
    return out.toDataURL("image/jpeg", 0.7);
  } catch (e) { return ""; }
}

const PalmUpload = { openCamera, openAlbum, showCrop, makeThumb, loadImage, OUT_SIZE };
if (typeof module !== "undefined" && module.exports) module.exports = PalmUpload;
global.PalmUpload = PalmUpload;
})(typeof window !== "undefined" ? window : globalThis);
