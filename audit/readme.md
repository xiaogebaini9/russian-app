# russian-app 项目体检报告包

- 生成时间：2026-09-16
- 审计对象：C:\Users\Administrator\russian-app（俄语学习 App v6.5.0，commit 956e309）
- 审计方式：只读。未改动任何业务代码；测试用 proxy 进程已停止。
- 报告语言：中文。所有结论均带文件路径或命令输出，可逐条抽查复现。

## 文件索引

| 文件 | 内容 |
|---|---|
| audit-report.md | 主报告：项目全貌、构建运行验证、密钥检查、异常路径、结论 |
| dependency-audit.md | 依赖与安全审计：98 个包、4 个漏洞、许可证分布、交叉验证 |
| code-issues.md | 代码问题分级清单 I-1～I-10（含位置与复现方法）+ 异常路径 11 条评级 |
| risk-register.md | 风险登记表 R1～R10：影响范围、触发条件、缓解与回滚步骤 |
| roadmap.md | 修复路线图：P0/P1/P2，含工作量与验证方法 |
| handover.md | 交接文档：环境要求、启动命令、环境变量、云端运维、发版流程 |
| audit-overview.html | 总览页（Fathom 科学期刊风格，双击即开） |

## 一句话结论

项目可构建、可运行、线上服务正常、git 历史无密钥泄露；但 proxy.js 静态服务无文件白名单，`keys.json`（DeepSeek Key）、`cloud.json`（adminToken）、`codes.json`、`cloud/.dev.vars` 在局域网内可被任意下载（已实测 HTTP 200），为唯一 P0，需当天修复并轮换密钥。

## 阅读顺序建议

1. 先看 audit-overview.html（5 分钟掌握全貌）
2. 处理 P0：roadmap.md 第一节 + risk-register.md R1
3. 排期 P1/P2：roadmap.md 第二、三节
4. 新接手者：handover.md
