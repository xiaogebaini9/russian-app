# 交接文档（新人上手指南）

- 项目：俄语学习 App（russian-app）· 版本 v6.5.0 · 本文档基于 2026-09-16 审计时的真实状态
- 目标：只靠这份文档 + 本机仓库，独立把三套形态跑起来并完成一次发版。

## 1. 项目是什么

面向俄语学习者的混合 App：翻译（快速=免费引擎 / 深度=DeepSeek）、走遍俄罗斯 1-4 课本、四选一测验、课堂语音实时转写翻译、收藏云同步、接入码/账号计费。一套 Web 代码（index.html 单文件前端），三种交付形态：

| 形态 | 入口 | 说明 |
|---|---|---|
| 浏览器直开 | 双击 index.html | 只有快速翻译可用（免费引擎），其余功能需代理或云端 |
| 本地代理 | `node proxy.js` → http://localhost:8765 | 全功能（深度翻译/词典/变体/课堂），真 Key 在服务端 |
| 云端生产 | https://aimisi.top（Cloudflare Worker） | 正式环境：网页+API 同域，KV 存码库，D1 存账号，Workers AI 云语音 |

## 2. 环境要求

| 组件 | 要求 | 本机现状（审计时） |
|---|---|---|
| Node.js | ≥18（实测 v22.22.0） | ✅ D:\autoclaw\resources\node |
| JDK | 17（本地出 APK 需要） | ✅ 17.0.20 |
| Android SDK | 本地出 APK 需要 | ❌ 未安装——用 CI 出包替代 |
| Cloudflare 账号 | 部署 Worker | 已部署（wrangler.toml 在 cloud/） |
| GPU（可选） | 本地 Whisper 语音 | RTX 3060，模型 1.5GB 已下载，服务默认不启动 |

## 3. 日常开发流程

```bash
# 1) 本地起服务（全功能调试）
node proxy.js
# 浏览器打开 http://localhost:8765；手机同 Wi-Fi 访问 http://<电脑IP>:8765

# 2) 改前端代码后同步三份拷贝（根目录 / www / android assets）+ 自动升 SW 缓存版本
sync.bat

# 3) 出 APK（推荐 CI）：git push 到 main，GitHub Actions 自动构建并发布 Release
git add . && git commit -m "..." && git push origin main
# 或本地出包（需 Android SDK）：build-apk.bat
# APK 产物：android/app/build/outputs/apk/debug/app-debug.apk

# 4) 改云端 Worker 后部署（网页 + API 一次全发）
cd cloud && wrangler deploy
```

## 4. 环境变量与密钥清单

| 位置 | 变量 | 用途 | 注意 |
|---|---|---|---|
| proxy.js 环境 | PORT | 监听端口（默认 8765） | — |
| proxy.js 环境 | DS_BASE_URL | DeepSeek 上游（可指中转） | 结尾 /v1 自动兼容 |
| cloud/.dev.vars | ADMIN_TOKEN | 本地 wrangler 部署/管理令牌 | 已 gitignore；轮换见 roadmap P0-2 |
| cloud/wrangler.toml [vars] | DS_BASE_URL | 云端 DeepSeek 上游 | 官方地址可不填 |
| Worker Secret | ADMIN_TOKEN | 云端管理接口鉴权 | `wrangler secret put ADMIN_TOKEN` |
| GitHub Secrets | ANDROID_KEYSTORE_B64 / ANDROID_KEYSTORE_PASS | 正式签名 | 未配置则 CI 出 debug 包 |
| 服务端 Key 存储 | keys.json（本地）/ KV config.deepseekKey（云端） | DeepSeek 真 Key | 换 Key 用 `node gen-codes.js key sk-新Key` |

**绝对不能外传/入库的文件**：keys.json、cloud.json（含 adminToken）、cloud/.dev.vars、codes.json、android/keystore/。均已列入 .gitignore 且历史上从未提交（审计已验证）。

## 5. 云端运维速查（都在项目根目录）

```bash
node gen-codes.js 8                # 生成 8 个码（默认每日 100 次）
node gen-codes.js 8 --days 30      # 月卡
node gen-codes.js 8 --total 3000   # 次数卡
node gen-codes.js list             # 码库与今日用量
node gen-codes.js del <码>          # 停用
node gen-codes.js key sk-xxx       # 更新服务端 Key（即时生效）
node gen-codes.js users / devices  # 用户 / 设备清单
node gen-codes.js device-block <设备号> on|off
node gen-codes.js feedback         # 看用户反馈
node gen-codes.js backup / import  # 云端码库 ⇄ 本地 codes.json 备份恢复
```

云端架构细节与历史决策：读 cloud/管理说明.md；课堂语音模块现状与待办：读 cloud/进行中-语音识别.md；开发避坑清单：读 开发经验清单.md（11 个历史 Bug 的教训，新功能前必读）。

## 6. 部署注意事项

- wrangler.toml 的 routes 必须保持在所有 [table] 之前（历史踩坑注释在文件内）。
- 云端一次 deploy 同时更新网页与 API；APK 用户要等下次出包——改 API 时注意两端版本兼容。
- 发版三查：APP_VERSION（index.html L203 单处）已改 → sync.bat 跑过（SW 版本自增）→ push 后 CI Release 出包。
- Worker 静态资产来自 www/ 目录（[assets] directory = "../www"），根目录的 index.html 改完必须 sync 才会生效到云端。
- 签名：CI 用 Secrets 注入 keystore；本地 keystore 在 android/keystore/（已忽略）。**丢失无法恢复，先备份（roadmap P1-4）。**

## 7. 已知问题与当前优先级（详见 roadmap.md）

- P0（2026-09-16 已修复并验证）：静态白名单上线（敏感路径全 404）；DeepSeek Key 与 ADMIN_TOKEN 均已轮换；旧 token 实测 401。公共 Wi-Fi 不运行 proxy；需要手机访问用热点或可信内网。
- P1：依赖漏洞修复（npm audit fix）、快速翻译引擎兜底、SW 离线兜底与 diagnose 修复、keystore 备份。
- P2：allowBackup、账号哈希加固、仓库清理、监控告警。
- 本地 Whisper 未随 proxy 自动启动；需要本地语音时手动 `whisper\venv\Scripts\python.exe whisper\stt_server.py`（端口 9000）。

## 8. 冒烟验证清单（接手后先跑一遍）

```bash
node proxy.js
# 然后：
curl http://localhost:8765/api/config        # 期望 {"isOfficial":true}
curl http://localhost:8765/ -o NUL           # 期望 200
curl http://localhost:8765/api/testkey -H "x-api-key: <接入码>"   # 期望 {"ok":true,...}
curl --path-as-is http://localhost:8765/keys.json   # P0 修复后期望 404
curl https://aimisi.top/api/voice-health     # 期望 {"ok":true,"stt":true,...,"device":"cloud"}
```
