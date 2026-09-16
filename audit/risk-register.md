# 风险登记表

- 日期：2026-09-16 · 与 code-issues.md 的 I 编号、roadmap.md 的步骤编号互相对应
- 每条含：影响范围 / 触发条件 / 缓解与回滚（可执行步骤，不是"有问题"三个字）

## R1 · P0 · 密钥经 proxy 静态服务泄露（对应 I-1）

- 影响范围：DeepSeek API Key（盗刷余额）、adminToken（云端全权：生成/停用接入码、封禁设备、看全部用户邮箱、换服务端 Key）、9 个接入码与用量、本地 ADMIN_TOKEN、.git 元数据。
- 触发条件：proxy.js 在非回环网卡监听（0.0.0.0）且任何人访问 `http://<IP>:8765/keys.json` 等。当前机器连公共 Wi-Fi（Ruijie-s209C_5G / Public profile），代理一开即暴露。
- 缓解：
  1. proxy.js 静态段加白名单（约 10 行，roadmap P0-1），重启后用 curl 验证五个敏感路径全 404、`/` 正常；
  2. 立即轮换 Key：`node gen-codes.js key sk-新Key`（立即生效）；轮换 ADMIN_TOKEN：改 `cloud/.dev.vars` + `wrangler secret put ADMIN_TOKEN` + 同步更新本地 `cloud.json`；
  3. 公共 Wi-Fi 不跑 proxy；确需手机访问时用手机热点或回家内网。
- 回滚：白名单若误伤静态资源，把对应文件名加入白名单数组即可（单文件单函数，git revert 一步可退）。

## R2 · P1 · 快速翻译双引擎同日不可用（对应 I-4）

- 影响范围：免费用户的翻译/词典快速模式；当日全量不可用（MyMemory 按 IP 限额 + terraprint LibreTranslate 502）。
- 触发条件：MyMemory 当日限额耗尽（今天已发生）且备用引擎宕机（今天已发生）。
- 缓解：加第三引擎或限额时 toast 引导切深度模式（roadmap P1-2）；临时口径：让用户用深度模式（需接入码）。
- 回滚：引擎链改动独立函数，revert 即回双引擎现状。

## R3 · P1 · 构建工具链漏洞（对应依赖审计 V1-V4）

- 影响范围：开发机构建期；不进 APK 运行时。
- 触发条件：恶意构造的 XML/项目文件被 cap sync/xcode 工具解析（本仓无 iOS 目录，实际暴露极小）。
- 缓解：`npm audit fix` → `npx cap sync` → CI 绿。
- 回滚：lockfile 变更走 git，revert + `npm ci` 即回滚。

## R4 · P1 · 签名单点丢失（对应 I-5）

- 影响范围：全部 APK 用户——丢失即永久无法覆盖升级，只能卸载重装。
- 触发条件：本机磁盘故障/误删 android/keystore/（3 个文件）且 CI Secrets 缺失或账号丢失。
- 缓解：keystore 加密（7z+强口令）备份两处（网盘+移动硬盘）；CI 双密码分离。
- 回滚：不适用（丢失不可逆），因此缓解即全部。当前 keystore 完好，今天就可以备份。

## R5 · P1 · SW 离线兜底 200 文本（对应 I-2）

- 影响范围：PWA 网页端离线时的次级体验；不丢数据。
- 触发条件：离线 + 请求的资源不在 v65 缓存清单（URLS 仅 4 项）。
- 缓解：按类型分流返回 503（roadmap P1-3 顺带）。
- 回滚：sw.js 有版本号机制（sync.bat 自增），发 v66 修复、revert 发 v67。

## R6 · P2 · 账号体系加固项（对应 I-6）

- 影响范围：云端注册用户口令哈希。
- 触发条件：D1 数据库泄露 + 离线爆破（当前迭代数 10 万低于 OWASP 现行建议）。
- 缓解：下次动账号模块时提升迭代数并登录时透明重哈希；比较改常量时间。
- 回滚：哈希带 salt 逐用户迁移，重哈希逻辑保留旧值兼容期。

## R7 · P2 · Android 备份提取令牌（对应 I-7）

- 影响范围：用户设备上的会话令牌/接入码。
- 触发条件：用户开启云备份且设备被克隆/adb backup。
- 缓解：allowBackup=false 或 backup rules 排除（roadmap P2-1）。
- 回滚：manifest 单行，revert 即可。

## R8 · P2 · diagnose 误报误导排查（对应 I-3）

- 影响范围：运维诊断体验，不影响业务。
- 触发条件：查看 /api/diagnose 时。
- 缓解：charset + 401 语义单列（roadmap P1-3）。
- 回滚：单函数 revert。

## R9 · P2 · 仓库卫生（对应 I-9）

- 影响范围：开发体验与 git 状态正确性（.gitignore.new 误用会误标删除 proxy.js/widget.html）。
- 触发条件：误把 .gitignore.new 当现用规则。
- 缓解：删除 .gitignore.new、归档 backup/archive、处理 restyle 分支（roadmap P2-3）。
- 回滚：文件移动操作，git 可完全还原。

## R10 · 监控缺失（新增项）

- 影响范围：云端 Worker 无任何错误/用量告警；DeepSeek Key 余额无阈值提醒；MyMemory 限额无探测。故障只能等用户反馈。
- 触发条件：Key 余额耗尽 / Worker 异常 / 上游引擎变更。
- 缓解（低成本起步）：现有 pushplus 推送通道（worker.js 反馈已接）复用一条"余额低于阈值告警"；Cron 触发 /api/diagnose 每日自检（roadmap P2-6）。
- 回滚：告警逻辑独立，删任务即回。
