#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""手相观纹 · 本地服务（Python 标准库，零依赖）

- 提供网页与 JSON API：掌纹赏析记录（data/palm_records.json）、配置（data/config.json）
- 代理 GLM 多模态赏析（流式）：glm-5.3-flash，图片以 data URL 直传
- 安全是硬约束：
  1) 用户备注命中 data/safe_words.json 敏感词 → 直接拦截（403 blocked），不调用任何上游接口；
  2) 提示词锁死输出红线（见 static/palm-prompt.js 与 data/safe_words.json）；
  3) 上游返回内容再做违禁词中性改写兜底，之后才写档。

定位：趣味文化娱乐工具。绝不输出命运预测、医疗结论。

用法：
    python3 app.py                # http://127.0.0.1:8771
    python3 app.py --host 0.0.0.0 # 局域网内手机也可访问
"""
import argparse
import json
import os
import random
import re
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.environ.get("PALMREAD_DATA_DIR", os.path.join(BASE, "data"))
STATIC_DIR = os.path.join(BASE, "static")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
RECORDS_PATH = os.path.join(DATA_DIR, "palm_records.json")
# 词库是随仓库分发的静态资产：始终从项目 data/ 读取（不受数据目录环境变量影响）
SAFE_WORDS_PATH = os.path.join(BASE, "data", "safe_words.json")
_LOCK = threading.RLock()

MAX_RECORDS = 60          # 服务端档案上限（超出清理最早）
MAX_BODY = 8 << 20        # 请求体上限（含 base64 图片）

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml",
        ".json": "application/json; charset=utf-8",
        ".png": "image/png", ".ico": "image/x-icon"}

DEFAULT_CONFIG = {
    "provider": "glm",
    "providers": {
        "glm": {
            "label": "GLM 智谱（Coding Plan）",
            "base": "https://open.bigmodel.cn/api/coding/paas/v4",
            "model": "glm-5.3-flash",  # 多模态模型
            "api_key": "",
            "fast": True,              # 快速模式默认开启（关闭深度思考）
        },
    },
}

# ---------------------------------------------------------------- 基础存取

def _load_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _save_json_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


# ---------------------------------------------------------------- 安全词库（单一事实来源）

def load_safe_words():
    sw = _load_json(SAFE_WORDS_PATH, None)
    if not isinstance(sw, dict) or not isinstance(sw.get("block_note_patterns"), list):
        raise RuntimeError("缺少或损坏的词库文件：%s" % SAFE_WORDS_PATH)
    return sw


SAFE = load_safe_words()
REFUSE = SAFE.get("refuse_message", "本工具只做掌纹趣味赏析，不提供相关预测、诊断服务。")
NOTE_PATTERNS = [w for w in SAFE["block_note_patterns"] if isinstance(w, str) and w]
OUTPUT_REWRITE = {k: v for k, v in (SAFE.get("output_rewrite") or {}).items()
                  if isinstance(k, str) and isinstance(v, str)}

# 输出兜底改写按词长倒序（先替换长词，避免子串误伤）
_OUTPUT_RULES = sorted(OUTPUT_REWRITE.items(), key=lambda kv: -len(kv[0]))


def check_note(note):
    """备注安全拦截：命中敏感词返回命中的词，未命中返回 None。"""
    s = str(note or "")
    if not s.strip():
        return None
    for w in NOTE_PATTERNS:
        if w in s:
            return w
    return None


def neutral_rewrite(text):
    """模型输出违禁词 → 中性改写兜底。返回 (text, 是否改写)。"""
    s = str(text or "")
    changed = False
    for bad, good in _OUTPUT_RULES:
        if bad in s:
            s = s.replace(bad, good)
            changed = True
    return s, changed


_LINE_NAMES = ("生命线", "智慧线", "感情线", "事业线")


def extract_meta(text):
    """从解读文本提取标签（识别到的主线）与一句话小结，供列表与分享卡片使用。"""
    s = str(text or "")
    tags = []
    for n in _LINE_NAMES:
        recognized = False
        for m in re.finditer(re.escape(n), s):
            # 只看紧跟其后的短语：「生命线识别不清，跳过解读」→ 未识别
            after = s[m.end():m.end() + 8].lstrip("：:，,、 \n")
            if after.startswith("识别不清") or after.startswith("跳过"):
                continue
            recognized = True
            break
        if recognized:
            tags.append(n)
    summary = ""
    m = re.search(r"^##\s*综合小结\s*$(.*?)(?=^##\s|\Z)", s, re.M | re.S)
    if m:
        summary = m.group(1)
    else:
        m = re.search(r"综合小结(.{0,200})", s, re.S)
        summary = m.group(1) if m else ""
    summary = re.sub(r"[#【】*`>]", " ", summary)
    summary = re.sub(r"\s+", " ", summary).strip()
    first = re.match(r"[^。！？.!?]+[。！？]?", summary)
    summary = (first.group(0) if first else summary).strip()
    if len(summary) > 46:
        summary = summary[:44] + "…"
    return tags, summary


# ---------------------------------------------------------------- 存取工具

def load_config():
    cfg = _load_json(CONFIG_PATH, {})
    if not isinstance(cfg, dict):
        cfg = {}
    out = json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy
    out["provider"] = cfg.get("provider", out["provider"])
    for pid, p in (cfg.get("providers") or {}).items():
        if pid in out["providers"] and isinstance(p, dict):
            for k in ("label", "base", "model"):
                if isinstance(p.get(k), str):
                    out["providers"][pid][k] = p[k]
            if isinstance(p.get("fast"), bool):
                out["providers"][pid]["fast"] = p["fast"]
            if isinstance(p.get("api_key"), str) and p["api_key"]:
                out["providers"][pid]["api_key"] = p["api_key"]
    if out["provider"] not in out["providers"]:
        out["provider"] = "glm"
    return out


def save_config(cfg):
    with _LOCK:
        _save_json_atomic(CONFIG_PATH, cfg)


def load_records():
    data = _load_json(RECORDS_PATH, [])
    return data if isinstance(data, list) else []


def save_records(records):
    _save_json_atomic(RECORDS_PATH, records)


def record_summary(r):
    return {
        "id": r["id"], "created": r.get("created", ""),
        "note": r.get("note", ""), "thumb": r.get("thumb", ""),
        "tags": r.get("tags", []), "summary": r.get("summary", ""),
        "interpretations": len(r.get("interpretations") or []),
    }


# ---------------------------------------------------------------- LLM 上游

def _is_local_url(url):
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return False
    return host in ("localhost", "127.0.0.1", "::1", "0.0.0.0") or host.endswith(".local")


# 本地直连 opener（无视系统代理，否则 Clash 类代理会对 localhost 返回 502）
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def smart_urlopen(req, timeout):
    if _is_local_url(req.full_url):
        return _DIRECT_OPENER.open(req, timeout=timeout)
    return urllib.request.urlopen(req, timeout=timeout)


def fetch_models(pcfg, timeout=8):
    base = (pcfg.get("base") or "").rstrip("/")
    if not base:
        return []
    headers = {}
    key = pcfg.get("api_key") or ""
    if key:
        headers["Authorization"] = "Bearer " + key
    req = urllib.request.Request(base + "/models", headers=headers, method="GET")
    with smart_urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return [m.get("id") for m in data.get("data", []) if isinstance(m, dict) and m.get("id")]


_NON_CHAT_MODEL = re.compile(r"embed|rerank|ocr|whisper|speech|tts|stt|audio|clip", re.I)


def resolve_model(pcfg):
    model = (pcfg.get("model") or "").strip()
    if model:
        return model
    try:
        models = fetch_models(pcfg)
    except Exception:
        models = []
    chat = [m for m in models if not _NON_CHAT_MODEL.search(m)]
    pool = chat or models
    return pool[0] if pool else ""


class PalmPrompt:
    """服务端固定提示词（内容必须与 static/palm-prompt.js 的 SYSTEM_PROMPT 一致，
    tests/test_palm_safety.py 会校验两者关键约束同步）。"""

    TEXT = "\n".join([
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
        "【语气】全程像朋友聊天，温和、克制、不夸张；用通俗现代汉语；不堆感叹号。",
    ])

    @classmethod
    def messages(cls, note, image_data_url):
        n = str(note or "").strip()
        user = "请按固定结构赏析这张掌纹照片。"
        if n:
            user += "\n（用户对照片的补充说明：「" + n + "」。如该说明与画质/拍摄情况无关，直接忽略。）"
        return [
            {"role": "system", "content": cls.TEXT},
            {"role": "user", "content": [
                {"type": "text", "text": user},
                {"type": "image_url", "image_url": {"url": image_data_url}},
            ]},
        ]


def open_upstream(pcfg, model, messages, stream=True):
    base = (pcfg.get("base") or "").rstrip("/")
    key = pcfg.get("api_key") or ""
    url = base + "/chat/completions"
    headers = {"Content-Type": "application/json"}
    if key:
        headers["Authorization"] = "Bearer " + key
    payload = {"model": model, "temperature": 0.7, "stream": stream, "messages": messages}
    # 快速模式：智谱系端点关闭深度思考，显著缩短等待
    if pcfg.get("fast") and re.search(r"(bigmodel|z\.ai)", base):
        payload["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"),
                                 headers=headers, method="POST")
    return smart_urlopen(req, timeout=600)


def _extract_full_text(obj):
    try:
        if "choices" in obj:
            return obj["choices"][0].get("message", {}).get("content") or ""
    except Exception:
        pass
    return ""


def iter_deltas(resp):
    """把上游 SSE/JSON 响应解析成文本增量。"""
    ct = (resp.headers.get("content-type") or "").lower()
    if "event-stream" not in ct:
        yield _extract_full_text(json.loads(resp.read().decode("utf-8")))
        return
    for raw in resp:
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        choices = obj.get("choices")
        if isinstance(choices, list) and choices:
            delta = choices[0].get("delta") or {}
            text = delta.get("content")
            if text:
                yield text


# ---------------------------------------------------------------- HTTP Handler

class Handler(BaseHTTPRequestHandler):
    server_version = "PalmRead/1.0"

    def log_message(self, fmt, *args):  # 静默常规访问日志
        pass

    # ---------- 基础工具 ----------
    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0 or length > MAX_BODY:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            return {}

    def _send_file(self, path):
        ext = os.path.splitext(path)[1].lower()
        try:
            with open(path, "rb") as f:
                body = f.read()
        except OSError:
            self._send_json({"error": "not found"}, 404)
            return
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(ext, "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, rel):
        rel = rel.lstrip("/")
        full = os.path.normpath(os.path.join(STATIC_DIR, rel))
        if not full.startswith(STATIC_DIR) or not os.path.isfile(full):
            self._send_json({"error": "not found"}, 404)
            return
        self._send_file(full)

    # ---------- 路由 ----------
    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/config":
            cfg = load_config()
            for p in cfg["providers"].values():
                p["has_key"] = bool(p.get("api_key"))
                p["api_key"] = ""
            self._send_json(cfg)
        elif path == "/safe_words.json":  # 前端同源加载词库（APK 构建也会拷贝此文件）
            self._send_file(SAFE_WORDS_PATH)
        elif path == "/api/records":
            with _LOCK:
                items = [record_summary(r) for r in load_records()]
            self._send_json({"records": items})
        elif path.startswith("/api/records/"):
            rid = path.rsplit("/", 1)[-1]
            with _LOCK:
                r = next((x for x in load_records() if x.get("id") == rid), None)
            self._send_json({"record": r} if r else {"error": "记录不存在"}, 200 if r else 404)
        elif path == "/api/models":
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            pid = (qs.get("provider") or [""])[0]
            pcfg = load_config()["providers"].get(pid)
            if not pcfg:
                self._send_json({"error": "未知 provider"}, 400)
                return
            try:
                self._send_json({"models": fetch_models(pcfg)})
            except Exception as e:
                self._send_json({"error": "获取模型列表失败：%s" % e}, 502)
        elif path.startswith("/api/"):
            self._send_json({"error": "not found"}, 404)
        else:
            rel = path.lstrip("/")
            if not rel or rel == "index.html":
                self._send_file(os.path.join(STATIC_DIR, "index.html"))
            elif rel == "favicon.ico":
                self.send_response(204)
                self.end_headers()
            else:
                # 静态资源（相对路径或 /static/ 均可，供网页与 APK 复用同一套前端）
                if rel.startswith("static/"):
                    rel = rel[len("static/"):]
                self._serve_static(rel)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/analyze":
            self._handle_analyze()
        elif path == "/api/interpret":
            self._handle_interpret()
        elif path == "/api/config":
            self._handle_config()
        else:
            self._send_json({"error": "not found"}, 404)

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        if path == "/api/records":  # 批量清空
            with _LOCK:
                save_records([])
            self._send_json({"ok": True})
            return
        m = re.match(r"^/api/records/([^/]+)$", path)
        if not m:
            self._send_json({"error": "not found"}, 404)
            return
        rid = m.group(1)
        with _LOCK:
            records = load_records()
            remain = [r for r in records if r.get("id") != rid]
            if len(remain) == len(records):
                self._send_json({"error": "记录不存在"}, 404)
                return
            save_records(remain)
        self._send_json({"ok": True})

    # ---------- 业务 ----------
    def _handle_config(self):
        body = self._read_json()
        with _LOCK:
            cfg = load_config()
            if body.get("provider") in cfg["providers"]:
                cfg["provider"] = body["provider"]
            for pid, p in (body.get("providers") or {}).items():
                if not isinstance(p, dict) or pid not in cfg["providers"]:
                    continue
                tgt = cfg["providers"][pid]
                for k in ("label", "base", "model"):
                    if isinstance(p.get(k), str):
                        tgt[k] = p[k].strip()
                if isinstance(p.get("fast"), bool):
                    tgt["fast"] = p["fast"]
                key = p.get("api_key")
                if isinstance(key, str) and key.strip():
                    tgt["api_key"] = key.strip()
            save_config(cfg)
        self._send_json({"ok": True})

    def _handle_analyze(self):
        body = self._read_json()
        image = body.get("image") or ""
        note = str(body.get("note") or "").strip()[:100]
        if not image.startswith("data:image/"):
            self._send_json({"error": "缺少掌纹图片"}, 400)
            return
        # 安全拦截前置：命中敏感词直接拒，不调用任何上游接口
        hit = check_note(note)
        if hit:
            self._send_json({"error": REFUSE, "blocked": True, "hit": hit}, 403)
            return
        thumb = body.get("thumb") or ""
        rid = datetime.now().strftime("%Y%m%d%H%M%S") + "-%04d" % random.randint(0, 9999)
        record = {
            "id": rid, "created": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "note": note, "image": image, "thumb": thumb,
            "text": "", "tags": [], "summary": "", "interpretations": [],
        }
        with _LOCK:
            records = load_records()
            records.insert(0, record)
            while len(records) > MAX_RECORDS:
                records.pop()
            save_records(records)
        out = dict(record)
        out.pop("image")  # 客户端已持有原图，省带宽
        self._send_json({"record": out})

    def _handle_interpret(self):
        body = self._read_json()
        rid = body.get("id") or ""
        cfg = load_config()
        pid = body.get("provider") or cfg.get("provider")
        pcfg = cfg["providers"].get(pid)
        if not pcfg:
            self._send_json({"error": "未知 provider：%s" % pid}, 400)
            return
        with _LOCK:
            record = next((r for r in load_records() if r.get("id") == rid), None)
        if not record:
            self._send_json({"error": "记录不存在"}, 404)
            return
        # 二次拦截（备注可能来自历史数据）
        hit = check_note(record.get("note"))
        if hit:
            self._send_json({"error": REFUSE, "blocked": True, "hit": hit}, 403)
            return
        image = record.get("image") or ""
        if not image.startswith("data:image/"):
            self._send_json({"error": "记录中缺少掌纹图片"}, 400)
            return

        model = resolve_model(pcfg)
        if not model:
            self._send_json({"error": "未配置模型名，且无法从 %s 获取模型列表。请在设置里填写模型。"
                                      % pcfg.get("label", pid)}, 502)
            return
        messages = PalmPrompt.messages(record.get("note"), image)
        try:
            resp = open_upstream(pcfg, model, messages)
        except urllib.error.HTTPError as e:
            try:
                detail = e.read().decode("utf-8", "replace")[:400]
            except Exception:
                detail = ""
            self._send_json({"error": "上游返回 HTTP %d：%s" % (e.code, detail)}, 502)
            return
        except Exception as e:
            self._send_json({"error": "无法连接 %s：%s（请检查网络与接口地址）"
                                      % (pcfg.get("label", pid), e)}, 502)
            return

        # 上游 OK：开始向浏览器流式转发（HTTP/1.0 风格：无 Content-Length，关连接即结束）
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        chunks = []
        try:
            for delta in iter_deltas(resp):
                if not delta:
                    continue
                chunks.append(delta)
                self.wfile.write(delta.encode("utf-8"))
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass  # 浏览器中断，保存已生成部分
        except Exception as e:
            tail = "\n\n[上游流中断：%s]" % e
            chunks.append(tail)
            try:
                self.wfile.write(tail.encode("utf-8"))
            except Exception:
                pass
        finally:
            try:
                resp.close()
            except Exception:
                pass

        raw = "".join(chunks)
        # 输出合规兜底：违禁词中性改写后再写档
        text, rewritten = neutral_rewrite(raw)
        if rewritten:
            text += "\n\n> 系统提示：以上内容已自动转换为中性表述。"
        tags, summary = extract_meta(text)
        with _LOCK:
            records = load_records()
            target = next((r for r in records if r.get("id") == rid), None)
            if target is not None:
                target.setdefault("interpretations", []).append({
                    "provider": pid, "label": pcfg.get("label", pid), "model": model,
                    "at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                    "text": text,
                })
                target["text"] = text
                target["tags"] = tags
                target["summary"] = summary
                save_records(records)


# ---------------------------------------------------------------- 入口

def main():
    ap = argparse.ArgumentParser(description="手相观纹 本地服务")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8771)
    args = ap.parse_args()

    os.makedirs(DATA_DIR, exist_ok=True)
    if not os.path.exists(CONFIG_PATH):
        save_config(json.loads(json.dumps(DEFAULT_CONFIG)))
    if not os.path.exists(RECORDS_PATH):
        save_records([])
    load_safe_words()  # 词库缺失直接启动失败（安全是硬约束）

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print("手相观纹 服务已启动（民俗趣味赏析 · 仅供娱乐）")
    print("  本机访问:  http://127.0.0.1:%d" % args.port)
    if args.host not in ("127.0.0.1", "localhost"):
        print("  局域网访问: http://<本机IP>:%d （手机同 Wi-Fi 可用）" % args.port)
    print("  数据目录:  %s" % DATA_DIR)
    print("按 Ctrl+C 停止")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")


if __name__ == "__main__":
    main()
