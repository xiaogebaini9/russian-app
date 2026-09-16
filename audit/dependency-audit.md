# 依赖与安全审计清单

- 日期：2026-09-16 · lockfile：package-lock.json（98 个包）· Node v22.22.0 / npm 10.9.4
- 交叉验证方式：npm audit --json 与 `npm ls @xmldom/xmldom uuid xcode elementtree` 依赖链核对，结论一致，非单源定论。

## 1. 直接依赖（package.json）

| 包 | 版本（锁定） | 最新 | 落后 | 许可证 | 角色 |
|---|---|---|---|---|---|
| @capacitor/android | 8.5.0 | 8.5.2 | minor | MIT | 运行时 |
| @capacitor/core | 8.5.0 | 8.5.2 | minor | MIT | 运行时 |
| @capacitor/cli | 8.5.0 | 8.5.2 | minor | MIT | 构建工具链 |

运行时依赖（core/android）**零已知漏洞**。`npm outdated` 显示三项 wanted/latest 均为 8.5.2，属平滑 minor 升级。

## 2. 已知漏洞（4 项，均在构建工具链）

| # | 包（锁定版本） | 严重度 | 通告 | 引入链 | 影响面 | 建议 |
|---|---|---|---|---|---|---|
| V1 | @xmldom/xmldom 0.9.10 | **High** | GHSA-6gmq-8vp8-gcm6 等 13 条（XML 注入 / ReDoS / 二次方复杂度） | @capacitor/cli → plist | 仅 `cap sync` 处理 config.xml 等构建期 XML，不进 APK | `npm audit fix` 升至 0.9.x 修复版 |
| V2 | uuid 7.0.3 | Moderate | GHSA-w5hq-g745-h8pq（v3/v5/v6 buf 边界） | @capacitor/cli → xcode | 仅 iOS 项目操作场景 | 同上自动修复 |
| V3 | xcode 3.0.1 | Moderate | 依赖 V2 的 uuid | @capacitor/cli | 同上 | 随 V2 修复 |
| V4 | @capacitor/cli 8.5.0 | Moderate | 依赖 V3 | 直接依赖 | 开发机 | 升 8.5.2（npm audit fix 可达） |

`npm audit` 官方结论：`fix available via npm audit fix`，无 breaking change。风险定性：**构建期低暴露**（本仓无 iOS 目录，xcode 路径几乎不触发；xmldom 只接触自有 config 文件），不阻塞发布，但应本周内修掉。

## 3. 许可证风险

98 个包许可证分布：MIT 71、ISC 12、Apache-2.0 3（elementtree、xcode、@capacitor 链内）、BlueOak-1.0.0 5、Unlicense 3、0BSD 1、其余 MIT 变体。**无 GPL/AGPL/LGPL 等 copyleft 组件**，对当前闭源分发（APK + 收费接入码）无许可证义务冲突。

## 4. 供应链与锁定状态

- package-lock.json 存在且与 package.json 一致；CI 使用 `npm ci`（build.yml L41），锁定安装 ✅。
- 无 postinstall 脚本、无 git 依赖、无 file: 依赖；依赖全部来自 npm 官方源。
- 运行时自身依赖为零第三方（前端纯原生 JS，proxy/worker 均用 Node 18+ 内置 fetch），供应链面极小。

## 5. 处理清单

1. `npm audit fix`（预计升 @capacitor/cli 8.5.2 + 内部链修复）→ `npx cap sync` → push 触发 CI 验证。
2. 升级后复查 `npm outdated` 归零。
3. 建议季度复查一次（当前依赖树小，成本低）。
