# 代码问题分级清单与异常路径评级

- 日期：2026-09-16 · 每条含文件位置，均可抽查复现
- 分级：P0 = 立即处理；P1 = 本周；P2 = 排期整改

## 1. 代码问题清单（I-1 ～ I-10）

### I-1 · P0 · proxy 静态服务无白名单，密钥文件可被局域网下载

- 位置：proxy.js L692-711（静态文件段）、L728（`server.listen(PORT, '0.0.0.0')`）
- 复现：启动 `node proxy.js` 后，同网段任意机器执行 `curl http://<IP>:8765/keys.json` → HTTP 200 返回 50 字节（含 DeepSeek Key）；`/cloud.json`（101B，adminToken）、`/codes.json`（665B，9 个码）、`/cloud/.dev.vars`（60B，ADMIN_TOKEN）、`/.git/config`（381B）同样 200。
- 已排除项：目录穿越防护实测有效（`curl --path-as-is` 的 `/../`、`..\` 变体全部 404，因 `path.normalize` 先归一化再 join）；云端 Worker 不存在此问题（/proxy.js、/codes.json 均 404）。
- 根因：静态段只做了"防向上穿越"，没有做"允许清单"——项目根目录下的任何文件（包括根目录里的密钥文件）都可读。README"方式一：node proxy.js + 手机同 Wi-Fi"正是推荐这个暴露面；实测主机在公共 Wi-Fi（Ruijie-s209C_5G，Public 配置文件），风险即现实。
- 修复：静态段加显式白名单（index.html、style.css、sw.js、manifest.json、privacy.html、clear-cache.html、voice-test.html、widget.html 及对应扩展名），约 10 行；详见 roadmap.md P0-1。

### I-2 · P1 · SW 离线兜底返回 200 纯文本

- 位置：sw.js L31-37
- 问题：cache-miss 且网络失败时对所有请求返回 `new Response('离线模式', {status:200})`。对 JS/CSS 请求会以语法错误形式失败（浏览器把"离线模式"当脚本/样式解析），对 JSON 同理。
- 建议：按请求类型分流——HTML 回兜底页，其余返回 503/504 状态码让前端走现有 friendlyErr。

### I-3 · P1 · /api/diagnose 输出乱码 + 误报

- 位置：proxy.js L670-690（Content-Type 无 `charset=utf-8`，Invoke-WebRequest 实测中文乱码）；worker.js L834-849 同样缺 charset。
- 问题 2：DeepSeek `/v1/models` 无鉴权探测，HTTP 401（未带 Key）也记为 `ok:true "可达"`，把"网络可达"与"服务可用"混为一谈，误导排查。
- 建议：补 charset；401 视为"可达但未鉴权"单列状态。

### I-4 · P1 · 快速翻译双免费引擎同时不可用（线上实测）

- 位置：index.html L341-342（LibreTranslate→MyMemory 回退链）；引擎列表 L204（仅两个免费引擎）。
- 实测（2026-09-16）：MyMemory 返回 "YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY"（按 IP 限额），备用 LibreTranslate(translate.terraprint.co) HTTP 502。快速模式当日不可用，且无第三引擎、无"引导用户切深度模式"的提示。
- 建议：加第三引擎（如 Google web 兜底或自建 LibreTranslate 实例）；限额/5xx 时 toast 引导切换。

### I-5 · P1 · 签名配置单点

- 位置：.github/workflows/build.yml 签名段（storePassword 与 keyPassword 用同一 secret）；本地 android/keystore/（release.keystore 3,696B 等）仅存本机，无异地备份。
- 影响： keystore 丢失 → 用户无法覆盖升级，只能卸载重装。
- 建议：keystore 加密异地备份；CI 增加独立 KEY_PASSWORD secret（可先同值）。

### I-6 · P2 · 口令哈希迭代数与非常量时间比较

- 位置：cloud/worker.js L229-235（PBKDF2-SHA256 100,000 次；OWASP 现行建议 600,000）；L357-361 isAdmin、登录比较均为 `===`（非常量时间）。
- 缓解：Workers CPU 限制下 10 万次属权衡；登录有 10 分钟 5 次锁定（L746-756），爆破面窄。建议下次动账号模块时一并升级（登录时透明重哈希）。

### I-7 · P2 · Android allowBackup

- 位置：android/app/src/main/AndroidManifest.xml L7 `android:allowBackup="true"`
- 影响：云备份/adb backup 可提取 WebView localStorage 中的会话令牌与接入码。
- 建议：改 false 或加 backup rules 排除 WebView 数据。

### I-8 · P2 · /api/balance 空 Key 透传

- 位置：proxy.js L217-236；worker.js L627-634
- 实测：无 x-api-key 时本地返回 500（`Bearer ` + 空值打上游）；云端同样透传。建议 4xx 友好返回"未填写 Key"。

### I-9 · P2 · 仓库卫生

- `.gitignore.new`（L5 含 proxy.js、widget.html）与现用 .gitignore 语义冲突，误换名会导致 git 状态混乱，建议删除；`index.html.backup-20260828-defects`（123KB）与 archive/ 历史包袱可归档清理；`restyle` 分支长期未合并；README.md 为无 BOM UTF-8（旧版记事本乱码，可加 BOM 或注明）。

### I-10 · P2 · widget.html 默认 localhost

- 位置：widget.html L82（`ru_widget_api` 缺省 `http://localhost:8765`）
- 影响：仅本地开发场景（widget 未进 www/），换机后失效；建议缺省值跟随主应用 API_BASE 或页面提示填写。

## 2. 异常路径处置现状评级（验收标准要求逐条记录）

| 场景 | 现有处理 | 位置 | 评级 |
|---|---|---|---|
| API 离线/代理挂 | SW 拦 /api/* 返回 503 JSON"离线模式"，前端 friendlyErr 统一显示 | sw.js L10-14 | B |
| DeepSeek 认证错误 | 立即终止不换模型重试，错误消息透传 | proxy.js L105-140 | A |
| 模型输出非法 JSON | 四级容错提取（代码块剥离→直接解析→截取清洗→数组兜底），失败降级"直译" | proxy.js L142-184 | B+ |
| 请求体/音频超大 | 1MB JSON / 8MB 音频上限，413 拒绝（proxy 语音路径直接 destroy 无响应体，扣半分） | proxy.js L30-47、L632-660 | B |
| 登录爆破 | 同邮箱 10 分钟 5 次锁定（KV TTL 600s） | worker.js L746-756 | A- |
| 注册刷号 | 每设备 2 账号 + 每 IP 每日 5 次 + 设备封禁闸门 | worker.js L86-89、L711-744 | A- |
| 会话过期 | 30 天，读时惰性删除 | worker.js L204、L237-253 | B |
| 刷免费试用 | 设备 ID 三重备份（localStorage+Cookie+IndexedDB）+ 继承试用起始日 + 管理员封禁名单 | index.html L231-260、worker.js L94-159 | B+ |
| 课堂体验额度 | 75 句终身一次，用尽 403 明确提示，注册/登录才计 | worker.js L206、L643-660 | A- |
| 免费引擎故障 | 仅报错，无第三引擎/引导 | index.html L341-342 | C（I-4） |
| 静态文件缺失 | 404 文本；白名单缺失是安全问题非可用性问题（I-1） | proxy.js L707-711 | C（安全） |

## 3. 死代码与遗留 TODO

- 无 TODO/FIXME/XXX/HACK 残留（全仓 grep 仅命中正常文案）。
- 形似死代码实为运维件：cloud/.wrangler/（本地 wrangler 状态，.gitignore 已排除）；whisper/test_*.wav、test_transcribe.py 为自测脚本，建议移入 whisper/tests/ 归位（P2 顺手项）。
- index.html 内大量行内 onclick 与内联 style 属风格债，不影响正确性，随模块化拆分处理（roadmap P2-5）。
