# 📖 俄语翻译学习 - 走遍俄罗斯

多功能俄语学习 App，集成翻译、课本、测验、单词本功能。

## 功能特色

| 模块 | 功能 |
|------|------|
| 🌐 翻译 | 俄⇄中翻译，自动检测语言，语音朗读，收藏单词 |
| 📚 学习 | 走遍俄罗斯 1~4 册 + 俄语语法参考 |
| 🎯 测验 | 四选一单词测验，支持选择课本范围 |
| ⭐ 收藏 | 集中管理收藏的单词 |
| ⚙️ 设置 | 主题/字体/语音速度/翻译引擎 |

## 快速使用

### ✅ 最简单：直接打开网页

双击 `index.html` 用浏览器打开即可使用全功能。

> ⚠️ 部分翻译 API 需要网络环境。推荐用 VS Code Live Server 打开。

### 📱 手机使用

1. 把整个文件夹传到手机
2. 用 Chrome/Safari 打开 `index.html`
3. 菜单 → 「添加到主屏幕」→ 像原生 App 一样用

---

## 📦 打包为安卓 APK

### 方法一：GitHub 云构建（推荐，无需本地环境）

1. 在 GitHub 创建仓库
2. 推送代码到 GitHub
3. 进入 Actions 标签页 → 点击 **Build Android APK**
4. 构建完成后，下载 APK 文件

**或者手动触发：**
```
git add .
git commit -m "add russian app"
git remote add origin https://github.com/你的用户名/russian-app.git
git push origin main
```
然后到 GitHub 仓库 → Actions → 选择 workflow → Run workflow

### 方法二：本地构建（需要 Android SDK）

**准备工作：**
1. 安装 [Node.js](https://nodejs.org/) (v18+)
2. 安装 [JDK 17](https://learn.microsoft.com/java/openjdk/download)
3. 安装 [Android Studio](https://developer.android.com/studio)（含 Android SDK）

**构建命令：**
```bash
# 1. 安装依赖
npm install

# 2. 同步 Capacitor 配置
npx cap sync

# 3. 构建 Debug APK
cd android
gradlew assembleDebug
```

APK 生成位置：`android/app/build/outputs/apk/debug/app-debug.apk`

**或者双击运行** `build-apk.bat` 自动构建。

### 方法三：在线 APK 生成器

1. 访问 [PWABuilder.com](https://pwabuilder.com)
2. 输入你的网页 URL 或上传文件
3. 选择 Android → 下载 APK

---

## 项目结构

```
russian-app/
├── index.html          # 主应用（全部功能）
├── manifest.json       # PWA 清单
├── sw.js              # 离线缓存 Service Worker
├── package.json       # npm 配置
├── capacitor.config.json  # Capacitor 配置
├── build-apk.bat      # Windows 构建脚本
├── www/               # 构建用 web 资源
├── android/           # Android 项目
└── .github/workflows/ # GitHub Actions 自动构建
```

## 设置说明

| 设置项 | 选项 |
|--------|------|
| 🎨 主题 | 深色 / 浅色 |
| 🔤 字体大小 | 13~24px 可调 |
| 🔊 语音速度 | 0.25x ~ 2x 共 8 档 |
| 🤖 翻译引擎 | MyMemory / LibreTranslate |

### 关于翻译引擎

- **MyMemory**：神经网络翻译，语料库大，适合句子翻译
- **LibreTranslate**：开源 OPUS-MT 模型，俄语优秀，隐私友好

---

Made with ❤️
