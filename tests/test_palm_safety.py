# -*- coding: utf-8 -*-
"""安全合规单元测试：敏感词拦截、提示词红线校验、输出中性改写、词库 JS/Python 同步。

运行：python3 -m unittest tests.test_palm_safety -v
"""
import json
import os
import re
import sys
import unittest

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BASE_DIR)

import app as appmod  # noqa: E402

PROMPT_JS = os.path.join(BASE_DIR, "static", "palm-prompt.js")
SAFE_WORDS = os.path.join(BASE_DIR, "data", "safe_words.json")

# 合规抽查用的预测类语句（工具任何输出都不应包含）
PREDICTIVE_SAMPLES = [
    "你的寿命大约还有五十年",
    "手相显示你会有大灾",
    "近期要破财",
    "你三年内必发财",
    "这是短命之相",
    "婚后有离异风险",
    "身体方面要提防大病",
    "大富大贵之相",
]


class TestNoteInterception(unittest.TestCase):
    """备注敏感词本地拦截（不调 LLM，直接拒）。"""

    def test_block_disease(self):
        for note in ["帮我看看有没有病", "最近身体有隐疾吗", "会不会得癌症"]:
            self.assertIsNotNone(appmod.check_note(note), note)

    def test_block_life_death(self):
        for note in ["我能活多久", "测测寿命", "什么时候死", "今年会有灾祸吗"]:
            self.assertIsNotNone(appmod.check_note(note), note)

    def test_block_fortune_marriage(self):
        for note in ["我什么时候发财", "财运怎么样", "婚期是什么时候", "会离婚吗", "帮我算命"]:
            self.assertIsNotNone(appmod.check_note(note), note)

    def test_block_occult(self):
        for note in ["占卜一下运势", "算算吉凶", "帮我改命转运"]:
            self.assertIsNotNone(appmod.check_note(note), note)

    def test_allow_plain_notes(self):
        for note in ["左手，室内灯光", "下午自然光下拍的", "右手 手掌放平", "刚洗完手拍的",
                     "", "   "]:
            self.assertIsNone(appmod.check_note(note), note)

    def test_refuse_message_wording(self):
        sw = json.load(open(SAFE_WORDS, encoding="utf-8"))
        self.assertIn("只做掌纹趣味赏析", sw["refuse_message"])
        self.assertIn("不提供相关预测、诊断服务", sw["refuse_message"])

    def test_disclaimer_required_text(self):
        sw = json.load(open(SAFE_WORDS, encoding="utf-8"))
        d = sw["disclaimer"]
        for kw in ["免责声明", "民俗文化趣味赏析工具", "不构成医学、心理、人生决策建议",
                   "请勿以此作为判断健康、命运的依据"]:
            self.assertIn(kw, d)


class TestPromptCompliance(unittest.TestCase):
    """提示词红线校验：服务端与前端提示词都必须锁死禁区。"""

    REQUIRED_MARKERS = [
        "最高优先级红线",
        "禁止词汇清单",
        "【民俗趣味参考】",
        "【性格倾向参考】",
        "识别不清，跳过解读",
        "掌纹识别概览",
        "分线赏析",
        "综合小结",
        "温馨提示",
        "仅供游玩参考",
    ]

    FORBIDDEN_TOPICS = ["寿命", "死亡", "疾病", "婚期", "财运大小", "吉凶祸福"]

    def test_server_prompt_has_redlines(self):
        for kw in self.REQUIRED_MARKERS:
            self.assertIn(kw, appmod.PalmPrompt.TEXT, kw)

    def test_server_prompt_bans_topics(self):
        for topic in self.FORBIDDEN_TOPICS:
            self.assertIn(topic, appmod.PalmPrompt.TEXT, "提示词应明确禁止：" + topic)

    def test_js_prompt_sync_with_server(self):
        js = open(PROMPT_JS, encoding="utf-8").read()
        for kw in self.REQUIRED_MARKERS:
            self.assertIn(kw, js, "前端提示词缺少：" + kw)
        # 两个提示词实质同步：服务端文本的每条红线关键词也出现在 JS 源中
        for topic in self.FORBIDDEN_TOPICS:
            self.assertIn(topic, js, "前端提示词应明确禁止：" + topic)

    def test_words_file_sync_with_js_embed(self):
        sw = json.load(open(SAFE_WORDS, encoding="utf-8"))
        js = open(PROMPT_JS, encoding="utf-8").read()
        for key in ("block_note_patterns", "banned_output_words"):
            for w in sw[key]:
                self.assertIn('"%s"' % w, js, "palm-prompt.js 内置词库缺少：%s" % w)

    def test_messages_structure(self):
        msgs = appmod.PalmPrompt.messages("左手", "data:image/jpeg;base64,xxx")
        self.assertEqual(msgs[0]["role"], "system")
        self.assertEqual(msgs[1]["role"], "user")
        content = msgs[1]["content"]
        self.assertEqual(content[0]["type"], "text")
        self.assertIn("左手", content[0]["text"])
        self.assertEqual(content[1]["type"], "image_url")
        self.assertTrue(content[1]["image_url"]["url"].startswith("data:image/"))


class TestOutputNeutralRewrite(unittest.TestCase):
    """输出兜底：违禁词 → 中性表述。"""

    def test_rewrite_banned_words(self):
        cases = {
            "近期注意破财": "开支起伏",
            "有短命之相": "节奏偏紧",
            "必发财": "进账机会",
            "这是大富大贵的纹": "顺遂富足",
            "防血光之灾": "小的磕碰",
        }
        for src, expect in cases.items():
            out, changed = appmod.neutral_rewrite(src)
            self.assertTrue(changed, src)
            self.assertIn(expect, out, src)

    def test_rewrite_result_free_of_banned(self):
        sw = json.load(open(SAFE_WORDS, encoding="utf-8"))
        for sample in PREDICTIVE_SAMPLES:
            out, _ = appmod.neutral_rewrite(sample)
            for bad in sw["banned_output_words"]:
                self.assertNotIn(bad, out, "%s → %s 仍含 %s" % (sample, out, bad))

    def test_no_change_for_clean_text(self):
        out, changed = appmod.neutral_rewrite("纹路深长清晰，心态沉稳，做事有条理。")
        self.assertFalse(changed)
        self.assertEqual(out, "纹路深长清晰，心态沉稳，做事有条理。")


class TestExtractMeta(unittest.TestCase):
    """输出结构解析：标签与一句话小结（列表页 / 分享卡片用）。"""

    SAMPLE = (
        "## 掌纹识别概览\n图片清晰，识别到生命线、智慧线与感情线；事业线识别不清，跳过解读。\n"
        "## 分线赏析\n"
        "【民俗趣味参考】生命线绵长，古人叫「地纹」，认为它像大树的根，讲究一个稳。\n"
        "【性格倾向参考】这类纹路的人通常作息规律，情绪稳定，遇事先想再动。\n"
        "## 综合小结\n整体气质温和踏实，像老朋友一样让人放松。手上的纹路有你自己的节奏。\n"
        "## 温馨提示\n掌纹会随着生活习惯、年龄持续变化，仅供游玩参考。"
    )

    def test_tags(self):
        tags, _ = appmod.extract_meta(self.SAMPLE)
        self.assertEqual(tags, ["生命线", "智慧线", "感情线"])

    def test_summary_one_sentence(self):
        _, summary = appmod.extract_meta(self.SAMPLE)
        self.assertTrue(summary.startswith("整体气质温和踏实"))
        self.assertLessEqual(len(summary), 46)

    def test_non_palm_output_no_summary(self):
        tags, summary = appmod.extract_meta("## 掌纹识别概览\n未能识别到手掌，请重新上传清晰的掌纹照片。")
        self.assertEqual(tags, [])
        self.assertEqual(summary, "")


if __name__ == "__main__":
    unittest.main(verbosity=2)
