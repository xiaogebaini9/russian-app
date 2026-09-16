# 修复路线图（P0 / P1 / P2）

- 日期：2026-09-16 · 顺序即建议执行顺序 · 每项含工作量与验证方法
- 原则：只读审计不直接改代码；以下动作需你确认后另行执行（P0-1/P0-2 除外——它们是安全止损，建议今天做）。

## P0 · 立即（今天，合计约 1.5 小时）

### P0-1 · proxy.js 静态白名单（0.5h）

- 改动：静态文件段（proxy.js L692-711）从"读任何存在的文件"改为白名单匹配：`['/index.html','/style.css','/sw.js','/manifest.json','/privacy.html','/clear-cache.html','/voice-test.html','/widget.html']` + `'/'` 重定向；命中白名单才 join ROOT。
- 工作量：约 10 行。
- 验证：重启 `node proxy.js` 后 `curl --path-as-is` 五个路径 `/keys.json` `/cloud.json` `/codes.json` `/cloud/.dev.vars` `/.git/config` 全 404；`/`、`/style.css`、`/manifest.json` 全 200；手机浏览器过一遍五大页面无 404。

### P0-2 · 轮换两把密钥（0.5h）

- DeepSeek Key：`node gen-codes.js key sk-新Key`（即时生效，无需重新部署）。
- ADMIN_TOKEN：编辑 `cloud/.dev.vars` → `cd cloud && wrangler secret put ADMIN_TOKEN` → 更新本地 `cloud.json` 的 adminToken 字段。
- 验证：`node gen-codes.js list` 用新 token 成功返回码库；旧 token 调 /admin/list 返回 401；旧 DeepSeek Key 在平台侧已失效。

### P0-3 · 使用约束（0 成本，决策项）

- 公共 Wi-Fi（如当前 Ruijie-s209C_5G）不运行 proxy；需要手机访问时改手机热点或仅在可信局域网开启。
- 验证：无需验证，写进 handover.md 的"日常使用注意"。

## P1 · 本周（合计 4-6 小时）

### P1-1 · 依赖修复（1h）

- `npm audit fix` → `npx cap sync` → commit & push（CI 自动出 APK 验证）。
- 验证：`npm audit` 归零；`npm outdated` 三行全部消失；CI build 绿。

### P1-2 · 快速翻译引擎兜底（2h）

- 加第三引擎（建议自建/公共 LibreTranslate 实例或 Google web 端点），或至少 MyMemory 限额 / 5xx 时 toast"快速引擎今日限额，试试深度模式"。
- 验证：把引擎列表临时置空模拟双挂，确认第三引擎接管或引导文案出现。

### P1-3 · SW 离线兜底 + diagnose 修复（1h）

- sw.js：非 HTML 请求离线时返回 503 而非 200 文本；记得让 sync.bat 升缓存版本。
- diagnose：两处 Content-Type 补 `charset=utf-8`；DeepSeek 探测把 401 归为"可达但未鉴权"单列。
- 验证：DevTools Offline 模式刷新页面看 console 无语法错误；curl diagnose 输出中文正常。

### P1-4 · keystore 备份 + 双密码分离（0.5h）

- 加密备份到两处介质；build.yml 增加 `ANDROID_KEY_PASSWORD` secret（先与 store 同值）。
- 验证：备份文件可解密且解出 keystore 的 SHA-256 与原文件一致；CI 跑一次 signed release。

### P1-5 · 语音 proxy 超大请求返回 413（0.5h，顺带）

- proxy.js 语音段 `req.destroy()` 前先尝试写 413 响应再断开，让前端拿到可读错误。
- 验证：本地发 >1MB 音频，前端显示"音频过大"而非网络错误。

## P2 · 月底（合计 1-2 天）

### P2-1 · Android allowBackup 收紧（0.5h）

- `android:allowBackup="false"` 或加 backup rules；出下一版 APK 生效。
- 验证：`adb backup`（或云备份检查）不再包含 WebView 数据。

### P2-2 · 账号体系加固（1h）

- PBKDF2 迭代提升（登录时透明重哈希）；isAdmin/密码比较改常量时间（crypto.timingSafeEqual 思路，Workers 上用双 hash 比较）。
- 验证：老用户登录无感（重哈希日志一条）；新会话正常。

### P2-3 · 仓库清理（1h）

- 删 `.gitignore.new`；`index.html.backup-*` 与 archive/ 移出仓（或 git rm --cached 后本地保留）；restyle 分支合并或删除；README 注明编码或转存 BOM 版。
- 验证：`git status` 干净，clone 新目录后按 README 无乱码。

### P2-4 · balance 空 Key 友好返回（0.5h）

- 无 x-api-key 时直接 400 `{"error":"未填写 API Key"}`（proxy 与 worker 两处）。
- 验证：curl 不带 Key 返回 400 而非 500。

### P2-5 · 前端模块化拆分（长期，建议下个版本周期启动）

- index.html 3051 行按 screen 拆模块（构建可用轻量 esbuild 拼 bundle，保持"一次部署单 Worker"现状）。验证：拆分后三份拷贝哈希一致 + 全功能回归。

### P2-6 · 最小监控（1h）

- 复用 pushplus 通道加"DeepSeek 余额低于阈值"告警；系统计划任务或 cron 每日 GET /api/diagnose，异常时推送。
- 验证：人为把阈值调高于余额，收到推送。

## 里程碑对照

| 时间 | 里程碑 | 完成标志 |
|---|---|---|
| 今天 | P0 全部 | 密钥已轮换 + 白名单上线 + 五路径 404 |
| 本周 | P1 全部 | npm audit 归零 + 引擎兜底上线 + keystore 有异地备份 |
| 月底 | P2 全部 | 新 APK 生效 allowBackup=false + 仓库卫生 + 告警上线 |
