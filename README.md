# 手相观纹 · 掌纹民俗图像赏析

> **免责声明：本App仅为传统手相民俗文化趣味赏析工具，不构成医学、心理、人生决策建议；手纹会随年龄、劳作、体态发生变化，请勿以此作为判断健康、命运的依据。**

本地网页版 + 安卓 App：拍一张掌纹照片，由智谱 **GLM-5.3-Flash（多模态）** 流式输出「传统民俗趣味释义 + 现代性格倾向参考」。定位是**趣味文化娱乐工具**：不做命运预测、不做医学诊断、绝无吉凶祸福结论——提示词锁死 + 敏感词本地拦截 + 输出中性改写三重把关。

**零第三方依赖**：网页与服务端只需 Python 3.9+ 标准库；前端为原生 HTML/JS/CSS。

## 快速开始

```bash
cd ~/DEV/palmread
python3 app.py
# 打开 http://127.0.0.1:8771
```

手机（同 Wi-Fi）使用：

```bash
python3 app.py --host 0.0.0.0
# 手机浏览器访问 http://<Mac的IP>:8771
```

## 用法

1. **拍掌纹**：手心朝上、光线充足、手掌放平、手指自然分开；相机拍摄或相册选取 → 固定正方形裁剪框对齐掌心 → 前端压缩后上传。
2. **确认勾选**：提交前须勾选「我已知晓本内容仅为民俗娱乐赏析，不具备诊断、预测效力」，不勾选无法提交。
3. **AI 赏析**（流式输出，固定四段结构）：
   - `## 掌纹识别概览`——列出识别到的生命线、智慧线、感情线、事业线；识别不到的纹路如实说明「该纹路识别不清，跳过解读」，不编造；
   - `## 分线赏析`——每条纹路两块内容：**【民俗趣味参考】**（古人意象，不断吉凶）与 **【性格倾向参考】**（思维/情绪/处事习惯，不贴心理疾病标签）；
   - `## 综合小结`——朋友闲聊式的温和总结；
   - `## 温馨提示`——固定一句话：掌纹会随着生活习惯、年龄持续变化，仅供游玩参考。
4. **历史档案**：服务模式存 `data/palm_records.json`（原图 + 缩略图 + 解读 + 标签）；App 离线模式存本机 localStorage（上限 20 条，超出自动清理最早记录并提示）。支持查看、删除、清空。
5. **分享**：一键复制模板文案（不含解读内容，引导朋友自己上传），或生成古风宣纸卡片保存到本地。

## 安全与合规约束（最高优先级）

| 层级 | 机制 |
|---|---|
| 提交前 | 必须手动勾选免责知晓声明，否则无法提交 |
| 备注拦截 | 备注文字命中疾病 / 生死 / 算命 / 财运 / 婚期等关键词（`data/safe_words.json`）→ **本地直接拦截，不调用任何 API**，提示：本工具只做掌纹趣味赏析，不提供相关预测、诊断服务 |
| 提示词 | 固定系统提示词写入红线：禁止输出寿命、疾病、伤病、灾祸、婚期、财运大小、吉凶祸福等预测性结论；每条民俗释义强制带【民俗趣味参考】，性格解读强制带【性格倾向参考】；识别不清必须如实跳过 |
| 输出兜底 | 模型返回后再次扫描违禁词，自动改写为中性表述（服务端落档前 + 前端渲染前双重执行） |
| 页面固定 | 首页 / 结果页 / 档案页 / 设置页 / 分享卡片 / README 均带完整免责声明 |

免责声明全文（App 各页面固定展示）：

> 免责声明：本App仅为传统手相民俗文化趣味赏析工具，不构成医学、心理、人生决策建议；手纹会随年龄、劳作、体态发生变化，请勿以此作为判断健康、命运的依据。

## 配置 GLM（设置页）

- Base URL：`https://open.bigmodel.cn/api/coding/paas/v4`，模型默认 `glm-5.3-flash`（多模态）
- 「快速模式」默认开启（关闭深度思考，出结果更快）
- API Key 须用**开通了 Coding Plan 的账号**创建「Coding Plan 类型」密钥；个人类型 Key 会报 `429 1113 余额不足`
- API Key 只保存在本机（服务模式在 `data/config.json`，App 模式在本机存储），请求直连智谱，不经第三方

## 安卓 App（Capacitor）

同一套前端（`static/`）打包为安卓 App：App 内**直连 GLM、掌纹存本机、原生 SSE 流式插件逐字输出**，无需运行 Python 服务。

```bash
cd mobile && ./build.sh
# 产物：手相观纹.apk（正式签名版）、手相观纹-debug.apk（调试版）
```

- `tools/` 为指向 `~/DEV/liuyao/tools` 的符号链接（复用 JDK 21 + Android SDK，不入库）；首次构建请先确保 liuyao 工具链就位或自建 `tools/` 目录。
- 权限仅 INTERNET 一项（相机走系统拍照 Intent，无需 CAMERA 权限）；`allowBackup=false`；挖孔屏适配 `adjustMarginsForEdgeToEdge=force` + 状态栏深色图标（`windowLightStatusBar`）。
- 正式版签名密钥在 `mobile/palmread-release.jks` + `mobile/keystore.properties`（均不入库，**务必备份**，丢失后无法对已装用户发布升级）。

### 离线限制

- 无网络 / 无 API Key 时：可浏览本机历史档案、查看图片与已生成的解读，**无法进行新的 AI 赏析**；
- 离线模式的敏感词拦截、免责勾选、分享卡片等功能均正常（本地实现）。

## 项目结构

```
palmread/
├── app.py                 # 本地服务：静态页 + API + GLM 多模态流式代理 + 存档（Python 标准库）
├── static/                # 前端（原生 HTML/JS/CSS，无框架）
│   ├── stream.js          #   流式逐字渲染 / 思考进度 / loading / 民俗·性格分块着色（复用自六爻项目）
│   ├── palm-prompt.js     #   固定多模态提示词 + 违禁词过滤 + 中性改写 + 输出解析
│   ├── palm-upload.js     #   相机/相册唤起、分辨率压缩、固定正方形裁剪框、缩略图
│   ├── palm-history.js    #   掌纹记录存储：服务端 JSON / localStorage（20 条上限）双模式
│   ├── palm-share.js      #   Canvas 古风分享卡片 + 复制文案 + 保存图片
│   └── app.js             #   路由与页面（赏析 / 结果 / 档案 / 设置）+ 流式调用
├── data/
│   ├── safe_words.json    # 违禁词库 / 免责文案 / 中性改写表（JS·Python 单一事实来源）
│   ├── config.json        # API 配置（不入库）
│   └── palm_records.json  # 掌纹档案（不入库）
├── mobile/                # Capacitor 安卓工程（www 为 static 同步副本）
│   ├── build.sh           # 一键打包：同步前端 → cap sync → debug + 签名 release
│   └── android/…/StreamHttpPlugin.java  # 原生 OkHttp SSE 流式插件（复用自六爻项目）
├── tests/
│   ├── test_palm_safety.py   # 敏感词拦截 / 提示词红线 / 中性改写 / JS·Python 词库同步
│   ├── test_api.py           # stub GLM 全链路：拦截不调上游 / 多模态 payload / 流式转发 / 存档
│   ├── test_palm_client.js   # 离线模式：模式探测（含 WebView 200-HTML 误判坑）/ 历史 20 条上限 / 分享
│   └── smoke_real_api.py     # 真实 GLM 冒烟：非手掌图如实说明、不编造（需网络）
└── tools -> ../liuyao/tools  # JDK21 + Android SDK（符号链接，不入库）
```

## 测试

```bash
python3 -m unittest tests.test_palm_safety tests.test_api -v   # Python 侧 31 项
node tests/test_palm_client.js                                  # 前端离线模式 11 项
GLM_API_KEY=xxx python3 tests/smoke_real_api.py                 # 真实模型冒烟（可选）
```

覆盖：模式切换（在线流式 / 离线降级 / WebView 200-HTML 兜底不误判）、敏感备注本地拦截零调用、多模态边界（非手掌图如实说明）、提示词合规抽查（输出无寿命/疾病/灾祸类语句）、历史增删清空、分享文案与卡片保存。

---

*民俗趣味赏析 · 仅供娱乐 ｜ 不做命运预测 · 不做医学诊断*
