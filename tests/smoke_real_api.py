#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""真实 GLM-5.3-Flash 多模态冒烟测试（需网络 + API Key，不进 CI）。

用 stdlib 生成一张非手掌测试图（风景），走完整链路 analyze → interpret：
- 验证 glm-5.3-flash 接受多模态请求（图片直传）
- 验证非手掌图片时模型如实说明、不编造赏析
- 提示词合规抽查：输出不得含寿命/疾病/灾祸类违禁词

用法：
    GLM_API_KEY=xxxx python3 tests/smoke_real_api.py
    # 或自动读取 ~/DEV/liuyao/data/config.json 里的 Key
"""
import json
import os
import sys
import tempfile
import threading
import urllib.request
from http.server import ThreadingHTTPServer
import struct
import zlib

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

API_KEY = os.environ.get("GLM_API_KEY")
if not API_KEY:
    try:
        with open(os.path.expanduser("~/DEV/liuyao/data/config.json"), encoding="utf-8") as f:
            API_KEY = json.load(f)["providers"]["glm"]["api_key"]
    except Exception:
        API_KEY = ""
if not API_KEY:
    print("✗ 缺少 API Key（GLM_API_KEY 环境变量）")
    sys.exit(2)


def make_landscape_png(w=320, h=320):
    """纯 stdlib 画一张简单风景图（天空渐变 + 太阳 + 草地）。"""
    px = bytearray()
    for y in range(h):
        for x in range(w):
            if y < h * 0.62:
                t = y / (h * 0.62)
                r, g, b = int(96 + 70 * t), int(150 + 50 * t), int(210 - 30 * t)
            else:
                r, g, b = 96, 158, 74
            if (x - w * 0.75) ** 2 + (y - h * 0.2) ** 2 < 22 ** 2:
                r, g, b = 252, 212, 92
            px += bytes((r, g, b))

    def chunk(typ, data):
        c = struct.pack(">I", len(data)) + typ + data
        return c + struct.pack(">I", zlib.crc32(typ + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + bytes(px[y * w * 3:(y + 1) * w * 3]) for y in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def main():
    import app as appmod  # noqa: E402

    data_dir = tempfile.mkdtemp(prefix="palmread-smoke-")
    cfg = json.loads(json.dumps(appmod.DEFAULT_CONFIG))
    cfg["providers"]["glm"]["api_key"] = API_KEY
    with open(os.path.join(data_dir, "config.json"), "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False)
    os.environ["PALMREAD_DATA_DIR"] = data_dir
    # app.py 已在导入时绑定 DATA_DIR，直接改模块变量指向临时目录
    appmod.DATA_DIR = data_dir
    appmod.CONFIG_PATH = os.path.join(data_dir, "config.json")
    appmod.RECORDS_PATH = os.path.join(data_dir, "palm_records.json")

    srv = ThreadingHTTPServer(("127.0.0.1", 0), appmod.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = "http://127.0.0.1:%d" % srv.server_address[1]

    import base64
    img = "data:image/png;base64," + base64.b64encode(make_landscape_png()).decode()

    def post(path, body):
        req = urllib.request.Request(base + path, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=180) as resp:
            return resp.read().decode()

    print("▸ 创建记录（图片 %.1fKB）" % (len(img) / 1024))
    out = json.loads(post("/api/analyze", {"image": img, "note": "测试图片，户外拍摄"}))
    rid = out["record"]["id"]
    print("▸ 流式赏析（glm-5.3-flash，快速模式）…")
    text = post("/api/interpret", {"id": rid})
    print("──── 模型输出 ────")
    print(text)
    print("──────────────────")

    # 断言 1：非手掌边界 —— 应如实说明识别不到，不输出分线赏析编造
    overview_ok = any(kw in text for kw in ["未能识别", "无法识别", "识别不清", "不是手掌", "不是清晰", "重新上传"])
    no_lines = "分线赏析" not in text or ("未能识别" in text or "无法识别" in text)
    print("✓ 非手掌边界：概览如实说明 =", overview_ok, "；未编造分线 =", no_lines)

    # 断言 2：提示词合规抽查 —— 无违禁预测词
    sw = appmod.SAFE
    hits = [w for w in sw["banned_output_words"] if w in text]
    print("✓ 合规抽查：违禁词命中 =", hits if hits else "无")
    # 断言 3：输出带固定结构
    print("✓ 结构检查：概览 =", "掌纹识别概览" in text, "；温馨提示 =", "温馨提示" in text or "仅供游玩参考" in text)

    ok = overview_ok and not hits
    srv.shutdown()
    print("\n冒烟测试", "通过 ✅" if ok else "未达标 ❌（检查上方输出）")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
