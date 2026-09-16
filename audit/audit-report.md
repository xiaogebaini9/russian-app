# russian-app 审计主报告

- 对象：C:\Users\Administrator\russian-app（俄语学习 App）
- 版本：v6.5.0（index.html L203 `APP_VERSION='6.5.0'`，单处来源）
- git：main @ 956e309，工作区干净，与 origin/main 同步（`git ls-remote` 核对一致）
- 日期：2026-09-16 · 只读审计

## 1. 执行摘要

| 维度 | 结论 |
|---|---|
| 可构建可运行 | ✅ cap sync 成功、proxy 冒烟通过、云端在线 |
| 线上服务 | ✅ https://aimisi.top 正常（Worker + KV + D1 + Workers AI） |
| 依赖安全 | ⚠️ 4 个漏洞（1 High / 3 Moderate），全部在 @capacitor/cli 构建工具链，运行时依赖无漏洞 |
| 许可证 | ✅ 98 包全部宽松许可（MIT/Apache-2.0/ISC/0BSD/BlueOak/Unlicense） |
| 密钥与 git | ✅ 仓库与历史干净（`git log --all` 证实敏感文件从未入库） |
| 运行时暴露 | ❌ P0：proxy 静态服务无白名单，密钥文件可被局域网下载（实测 200） |
| 代码质量 | 良好。10 项分级问题（P0×1、P1×4、P2×5），无致命 Bug |

## 2. 项目全貌

「俄语学习」Capacitor 混合 App：翻译（快速/深度双引擎）+ 走遍俄罗斯课本 + 测验 + 课堂语音实时转写翻译 + 收藏云同步 + 接入码/账号计费体系。一套 Web 代码，三种交付形态：浏览器直开（免费引擎）、本地 proxy（全功能）、Cloudflare Worker 云端（生产）。

| 模块 | 位置 | 规模 | 职责 |
|---|---|---|---|
| 前端主应用 | index.html + style.css + sw.js | 3051 行 / 346KB 单文件 | 全部界面与逻辑；APP_VERSION 单处来源（L203）；escape 覆盖引号（L350）；搜索防抖（L977） |
| 本地代理 | proxy.js | 668 行 | 托管静态 + 13 个 /api/* 代理 + 接入码校验 + 转发本机 Whisper(9000)；端口 8765 |
| 云端 Worker | cloud/worker.js | 988 行 | 与 proxy 接口一致 + 邮箱账号(D1) + 会话 + 设备防刷 + 云语音(Workers AI)；域名 aimisi.top |
| 语音识别（可选） | whisper/stt_server.py | 129 行 | faster-whisper large-v3-turbo-ct2（1.5GB，RTX 3060 CUDA float16），127.0.0.1:9000 |
| Android 壳 | android/ | Capacitor 8.5.0 | com.russian.learn，minSdk 24 / targetSdk 36 / AGP 8.13.0 |
| 运维 CLI | gen-codes.js | 611 行 | 接入码全生命周期 + 云端 key/用户/设备/反馈管理 |
| 发版脚本 | sync.bat / build-apk.bat | — | SW 版本自增（russian-app-vN）+ 三份拷贝同步；APK 构建 |
| CI | .github/workflows/build.yml | 3131B | push main 自动出 APK + Release；支持签名密钥 Secrets 注入 |

三份静态拷贝（根目录 / www\ / android\app\src\main\assets\public\）MD5 逐对一致（index/style/sw/manifest/privacy/proxy 全对齐），且 `npx cap sync android` 执行后 `git status` 仍为空——同步机制有效。

## 3. 构建与运行验证记录（2026-09-16 实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 语法检查 | `node --check proxy.js / gen-codes.js / worker.js` | 全部通过（worker 以 .mjs ESM 校验） |
| 内联脚本 | 提取 index.html 两个 `<script>` 块 | 342 + 272,891 字符均语法通过 |
| 资源同步 | `npx cap sync android` | 成功（0.149s），git 工作区保持干净 |
| 启动服务 | `node proxy.js`（后台） | 监听 0.0.0.0:8765 成功 |
| 冒烟 GET /api/config | — | 200 `{"isOfficial":true}` |
| 冒烟 GET / | — | 200，345,789B 与文件字节一致 |
| 冒烟 未知 API | GET /api/not-exist | 404 ✅ |
| 接入码校验 | GET /api/testkey（有效码） | 200 `{"ok":true,"code":true,"remaining":100}` |
| 语音健康 | GET /api/voice-health | 200 `{"ok":true,"stt":false}`（本地 Whisper 未启动，如实上报） |
| 云端自检 | GET https://aimisi.top/api/diagnose | 200，DeepSeek 可达；MyMemory 当日限额、LibreTranslate 502（见 I-4） |
| 云端静态 | GET https://aimisi.top/ | 200，APP_VERSION 6.5.0 与本地一致；字节差异确认为 Cloudflare Web Analytics 注入，非版本漂移 |
| 云端泄露面 | GET /proxy.js、/codes.json | 均 404 ✅（云端无此问题） |
| 运行截图 | Edge headless 420×900 | 本地与线上各一张（audit-shots\local-proxy-home.png / remote-aimisi-home.png），像素采样 164 色非空白 |

环境：Node v22.22.0、JDK 17.0.20 满足要求；Android SDK 未安装 → 本地出 APK 不可行（环境缺失，非项目缺陷），CI 链路完整可替代。本地 Whisper 模型与 venv 就绪（model.bin 1,543MB）但服务未运行，属可选组件。

## 4. 密钥与配置泄露检查

| 文件 | 内容 | git 状态 | 运行时暴露 |
|---|---|---|---|
| keys.json（DeepSeek Key，掩码 sk-874…1556） | 服务端真 Key | 已忽略，历史无记录 | ❌ HTTP 200 可下载（P0） |
| cloud.json（adminToken 48 位） | 云端管理令牌 | 已忽略，历史无记录 | ❌ HTTP 200 可下载（P0） |
| cloud/.dev.vars（ADMIN_TOKEN） | 本地 Worker 密钥 | 已忽略，历史无记录 | ❌ HTTP 200 可下载（P0） |
| codes.json（9 个接入码） | 码库本地备份 | 已忽略，历史无记录 | ❌ HTTP 200 可下载（P0） |
| android/keystore/（release.keystore 等） | 签名证书 | 已忽略，历史无记录 | ✅ 未暴露 |
| widget.html L78 `const KEY` | 空，运行时读 localStorage | 已跟踪 | ✅ 无硬编码 |

交叉验证：`git log --all --oneline -- <file>` 为空 + `git ls-files` 不含敏感文件 + 全仓 sk- 模式扫描仅命中 keys.json（本机掩码文件）。结论：**git 面干净，问题只在 HTTP 面（见 code-issues.md I-1）**。

## 5. 异常路径处置现状（摘要，评级明细见 code-issues.md 第 2 节）

离线兜底（SW 503 JSON）B；DeepSeek 认证错误即停 A；模型输出四级 JSON 容错 B+；1MB/8MB 上限 B；登录锁定 A-；注册防刷 A-；会话惰性过期 B；试用防刷（设备 ID 三备份+封禁）B+；课堂 75 句终身额度 A-；免费引擎双挂无兜底 C（I-4）。

## 6. 结论

项目工程纪律好于同类个人项目：版本号单源、三份拷贝同步脚本化、escape 覆盖引号、防刷成体系、文档（开发经验清单.md、cloud/管理说明.md）真实反映现状。需要立即处理的是 proxy 静态白名单缺失（P0）；P1/P2 见 roadmap.md。本次审计未改动任何业务代码；测试用 proxy 进程已停止。

---

## 附录 · P0 修复执行记录（2026-09-16 18:21-18:35，已实施）

经用户确认并授权后，P0 三项已于当日完成修复（超出原只读范围，单独记录）：

| 项 | 动作 | 验证结果 |
|---|---|---|
| P0-1 白名单 | proxy.js 静态段改为白名单制（+10/−6 行，白名单 9 项：/ index style sw manifest privacy clear-cache voice-test widget） | 7 个敏感路径（keys.json / cloud.json / codes.json / cloud/.dev.vars / .git/config / package.json / gen-codes.js）全部 404；9 个正常路径全 200；/api/config 不受影响。三份拷贝已同步（MD5 一致 294A7F8B…） |
| P0-2a DeepSeek Key | node gen-codes.js key sk-206***db83（用户提供的 Key） | 云端真实调用成功：class-translate 返回 _model=DeepSeek V4 Flash、remaining=24（计费链路通）；本地 keys.json 同步更新；旧 Key 待用户在平台删除 |
| P0-2b ADMIN_TOKEN | 生成 48 位新 token → cloud/.dev.vars → wrangler secret put ADMIN_TOKEN（Worker russian-app-proxy）→ 更新 cloud.json | 新 token：node gen-codes.js list 正常（9 码可见）；旧 token（74c4…2655）：/admin/list 返回 401 已失效 |
| P0-3 约束 | 写入交接文档 | 公共 Wi-Fi 不运行 proxy；手机访问用热点或可信内网 |

修复过程问题记录：第一次验证时白名单"未生效"，排查发现是 16:34 启动的旧 proxy 实例仍在监听（先前 kill 只杀了 shell 包装进程），新实例 EADDRINUSE 启动失败——杀净旧进程重启后验证通过。教训已记：验证前先核对 8765 端口监听进程的启动时间与 pid。

proxy.js 修复已提交本地 git（见 commit）；audit/ 目录为审计报告包，是否入库由用户决定。
