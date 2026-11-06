# -*- coding: utf-8 -*-
"""API 集成测试：静态页 / 记录创建 / 敏感词拦截不调上游 / 多模态流式代理 / 存档 / 删除清空。

内置一个 stub GLM（OpenAI 兼容 SSE，多模态请求体）：
- 校验拦截生效时 stub 从未被调用（安全前置）
- 校验多模态 payload：system 红线提示词 + user 消息含 image_url(data:image)
- 校验流式转发、违禁词中性改写写档、元信息提取
运行：python3 -m unittest tests.test_api -v
"""
import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.environ["PALMREAD_DATA_DIR"] = tempfile.mkdtemp(prefix="palmread-test-")
sys.path.insert(0, BASE_DIR)

import app as appmod  # noqa: E402

# 1x1 像素 JPEG（data URL 前缀合法即可，stub 不真看图）
TINY_JPEG = ("data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/"
             "2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwcJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==")


class StubLLM(BaseHTTPRequestHandler):
    last_request = None
    call_count = 0

    def log_message(self, *a):
        pass

    def do_POST(self):  # chat/completions（SSE 流式）
        length = int(self.headers.get("Content-Length") or 0)
        StubLLM.last_request = json.loads(self.rfile.read(length))
        StubLLM.call_count += 1
        # 模拟纯文本模型拒绝图片输入（智谱 1210）
        if StubLLM.last_request.get("model") == "stub-text-only":
            body = json.dumps({"error": {"code": "1210",
                              "message": "messages.content.type 参数非法，取值范围 ['text']"}}).encode()
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for piece in ["## 掌纹识别概览\n", "图片清晰，识别到生命线与智慧线，",
                      "感情线识别不清，跳过解读。\n",
                      "## 分线赏析\n【民俗趣味参考】生命线绵长，古人视为「地纹」，讲究一个稳。\n",
                      "【性格倾向参考】这类纹路的人通常心态沉稳。\n",
                      "## 综合小结\n整体气质温和踏实，但近期注意破财，别大意。\n",
                      "## 温馨提示\n掌纹会随着生活习惯、年龄持续变化，仅供游玩参考。"]:
            chunk = {"choices": [{"delta": {"content": piece}}]}
            self.wfile.write(("data: " + json.dumps(chunk, ensure_ascii=False) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def do_GET(self):  # /models
        body = json.dumps({"data": [{"id": "stub-flash"}, {"id": "stub-embed"}]}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class TestAPI(unittest.TestCase):
    rid = None

    @classmethod
    def setUpClass(cls):
        # 硬保险：无论模块导入顺序如何，绝不允许测试写到真实 data/
        assert appmod.DATA_DIR.startswith(tempfile.gettempdir()), \
            "测试环境数据目录异常：%s" % appmod.DATA_DIR
        cls.stub = ThreadingHTTPServer(("127.0.0.1", 0), StubLLM)
        threading.Thread(target=cls.stub.serve_forever, daemon=True).start()
        stub_port = cls.stub.server_address[1]

        cfg = json.loads(json.dumps(appmod.DEFAULT_CONFIG))
        cfg["provider"] = "glm"
        cfg["providers"]["glm"]["base"] = "http://127.0.0.1:%d/v1" % stub_port
        cfg["providers"]["glm"]["model"] = ""  # 留空 → 从 /models 自动取
        appmod.save_config(cfg)

        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), appmod.Handler)
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()
        cls.base = "http://127.0.0.1:%d" % cls.srv.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()
        cls.stub.shutdown()

    def request(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method)
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, data=data, timeout=20) as resp:
                return resp.status, resp.read().decode()
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()

    # ---------- 静态与配置 ----------
    def test_01_static(self):
        status, html = self.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("手相观纹", html)
        _, js = self.request("GET", "/static/app.js")
        self.assertIn("startInterp", js)
        _, prompt_js = self.request("GET", "/static/palm-prompt.js")
        self.assertIn("SYSTEM_PROMPT", prompt_js)
        _, sw = self.request("GET", "/safe_words.json")
        self.assertIn("block_note_patterns", sw)

    def test_02_config(self):
        _, body = self.request("GET", "/api/config")
        cfg = json.loads(body)
        self.assertIn("providers", cfg)
        self.assertEqual(cfg["providers"]["glm"]["model"], "")
        self.assertTrue(cfg["providers"]["glm"]["fast"])  # 快速模式默认开启
        self.assertTrue(cfg["providers"]["glm"]["has_key"] is False)

    # ---------- 创建记录 + 安全拦截 ----------
    def test_10_analyze_ok(self):
        status, body = self.request("POST", "/api/analyze",
                                    {"image": TINY_JPEG, "note": "左手，室内灯光"})
        self.assertEqual(status, 200)
        record = json.loads(body)["record"]
        self.assertTrue(record["id"])
        self.assertEqual(record["note"], "左手，室内灯光")
        self.assertNotIn("image", record)  # 原图不回传（客户端已持有）
        TestAPI.rid = record["id"]

    def test_11_analyze_blocked_note(self):
        StubLLM.call_count = 0
        StubLLM.last_request = None
        status, body = self.request("POST", "/api/analyze",
                                    {"image": TINY_JPEG, "note": "帮我算算还能活多久"})
        self.assertEqual(status, 403)
        out = json.loads(body)
        self.assertTrue(out["blocked"])
        self.assertEqual(out["error"], appmod.REFUSE)
        # 关键：拦截时绝不调用上游
        self.assertEqual(StubLLM.call_count, 0)
        self.assertIsNone(StubLLM.last_request)

    def test_12_analyze_bad_image(self):
        status, _ = self.request("POST", "/api/analyze", {"image": "hello", "note": ""})
        self.assertEqual(status, 400)

    # ---------- 多模态流式解读 ----------
    def test_20_interpret_stream(self):
        self.assertIsNotNone(TestAPI.rid, "依赖 test_10")
        status, text = self.request("POST", "/api/interpret", {"id": TestAPI.rid})
        self.assertEqual(status, 200)
        self.assertIn("## 掌纹识别概览", text)
        # 流式转发的是上游原始增量（stub 故意埋了「破财」）；
        # 合规改写发生在落档（test_21 校验）与前端渲染（app.js neutralize）两处。
        self.assertIn("破财", text)

        # 多模态 payload 校验
        req = StubLLM.last_request
        self.assertTrue(req["stream"])
        # 快速模式只对智谱系端点（bigmodel/z.ai）注入 thinking=disabled；stub 为本地端点，不应注入
        self.assertNotIn("thinking", req)
        msgs = req["messages"]
        self.assertEqual(msgs[0]["role"], "system")
        self.assertIn("最高优先级红线", msgs[0]["content"])
        user_content = msgs[1]["content"]
        self.assertIsInstance(user_content, list)
        self.assertEqual(user_content[0]["type"], "text")
        self.assertEqual(user_content[1]["type"], "image_url")
        self.assertTrue(user_content[1]["image_url"]["url"].startswith("data:image/jpeg;base64,"))

    def test_21_interpret_saved_with_meta(self):
        status, body = self.request("GET", "/api/records/" + TestAPI.rid)
        self.assertEqual(status, 200)
        record = json.loads(body)["record"]
        self.assertTrue(record["text"])
        # 违禁词不落档（服务端中性改写兜底）
        sw = json.load(open(appmod.SAFE_WORDS_PATH, encoding="utf-8"))
        for bad in sw["banned_output_words"]:
            self.assertNotIn(bad, record["text"])
        self.assertIn("已自动转换为中性表述", record["text"])
        # 元信息：感情线被标注「识别不清」→ 不进标签；生命线/智慧线识别到
        self.assertEqual(record["tags"], ["生命线", "智慧线"])
        self.assertTrue(record["summary"].startswith("整体气质温和踏实"))
        self.assertEqual(len(record["interpretations"]), 1)
        # 完整记录仍保留原图
        self.assertTrue(record["image"].startswith("data:image/jpeg;base64,"))

    def test_22_interpret_blocked_history(self):
        # 手动造一条含敏感备注的记录 → interpret 也要拦
        with appmod._LOCK:
            records = appmod.load_records()
            records.insert(0, {"id": "fake-block", "created": "2026-01-01 00:00:00",
                               "note": "我什么时候发财", "image": TINY_JPEG, "thumb": "",
                               "text": "", "tags": [], "summary": "", "interpretations": []})
            appmod.save_records(records)
        StubLLM.call_count = 0
        status, body = self.request("POST", "/api/interpret", {"id": "fake-block"})
        self.assertEqual(status, 403)
        self.assertTrue(json.loads(body)["blocked"])
        self.assertEqual(StubLLM.call_count, 0)

    def test_23_interpret_missing_record(self):
        status, _ = self.request("POST", "/api/interpret", {"id": "no-such-id"})
        self.assertEqual(status, 404)

    def test_24_fallback_when_model_not_multimodal(self):
        # 误配纯文本模型（上游报 1210 拒绝图片）→ 服务端自动回退 glm-5.3-flash 重试
        cfg = appmod.load_config()
        cfg["providers"]["glm"]["model"] = "stub-text-only"
        appmod.save_config(cfg)
        status, body = self.request("POST", "/api/analyze",
                                    {"image": TINY_JPEG, "note": "左手"})
        rid = json.loads(body)["record"]["id"]
        status, text = self.request("POST", "/api/interpret", {"id": rid})
        self.assertEqual(status, 200)
        self.assertIn("## 掌纹识别概览", text)
        _, body = self.request("GET", "/api/records/" + rid)
        interp = json.loads(body)["record"]["interpretations"][0]
        self.assertIn("自动切换", interp["model"])
        self.assertIn("glm-5.3-flash", interp["model"])
        # 恢复配置，避免影响其他用例
        cfg["providers"]["glm"]["model"] = ""
        appmod.save_config(cfg)

    # ---------- 记录列表 / 删除 / 清空 ----------
    def test_30_records_list(self):
        _, body = self.request("GET", "/api/records")
        records = json.loads(body)["records"]
        self.assertTrue(any(r["id"] == TestAPI.rid for r in records))
        item = next(r for r in records if r["id"] == TestAPI.rid)
        self.assertNotIn("image", item)  # 列表不带原图
        self.assertEqual(item["interpretations"], 1)

    def test_31_delete_one(self):
        status, body = self.request("DELETE", "/api/records/" + TestAPI.rid)
        self.assertEqual(status, 200)
        status, _ = self.request("GET", "/api/records/" + TestAPI.rid)
        self.assertEqual(status, 404)
        status, _ = self.request("DELETE", "/api/records/" + TestAPI.rid)
        self.assertEqual(status, 404)

    def test_32_clear_all(self):
        for i in range(3):
            self.request("POST", "/api/analyze", {"image": TINY_JPEG, "note": "第%d张" % i})
        _, body = self.request("GET", "/api/records")
        self.assertGreaterEqual(len(json.loads(body)["records"]), 3)
        status, _ = self.request("DELETE", "/api/records")
        self.assertEqual(status, 200)
        _, body = self.request("GET", "/api/records")
        self.assertEqual(json.loads(body)["records"], [])

    def test_33_models(self):
        _, body = self.request("GET", "/api/models?provider=glm")
        models = json.loads(body)["models"]
        self.assertIn("stub-flash", models)


if __name__ == "__main__":
    unittest.main(verbosity=2)
