@echo off
chcp 65001 >nul
title 俄语学习 - APK 构建工具

echo ========================================
echo   俄语翻译学习 - APK 构建工具
echo ========================================
echo.

:: 检查 JDK
echo [1/5] 检查 Java 环境...
where java >nul 2>&1
if %errorlevel% neq 0 (
    echo [!!] 未找到 Java，正在安装 JDK 17...
    echo      请先安装 JDK 17: https://learn.microsoft.com/java/openjdk/download
    echo      或使用 winget install EclipseAdoptium.Temurin.17.JDK
    pause
    exit /b
)
java -version 2>&1 | findstr "17" >nul
if %errorlevel% neq 0 (
    echo [!!] 需要 JDK 17，当前版本不是 17
    echo      请安装 JDK 17: https://learn.microsoft.com/java/openjdk/download
    pause
    exit /b
)
echo [OK] Java 17 已安装

:: 检查 Android SDK
echo [2/5] 检查 Android SDK...
if "%ANDROID_HOME%"=="" (
    if not exist "%LOCALAPPDATA%\Android\Sdk" (
        echo [!!] 未找到 Android SDK
        echo      请安装 Android Studio: https://developer.android.com/studio
        echo      或设置 ANDROID_HOME 环境变量
        pause
        exit /b
    )
    set ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk
)
echo [OK] Android SDK: %ANDROID_HOME%

:: 检查 Node.js
echo [3/5] 检查 Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [!!] 未找到 Node.js
    echo      请安装 Node.js: https://nodejs.org/
    pause
    exit /b
)
echo [OK] Node.js 已安装

:: 安装依赖
echo [4/5] 安装 npm 依赖...
call npm install
echo [OK] 依赖安装完成

:: 同步并构建
echo [5/5] 同步 Capacitor 并构建 APK...
call npx cap sync
if %errorlevel% neq 0 (
    echo [!!] Capacitor 同步失败
    pause
    exit /b
)

cd android
call gradlew assembleDebug
cd ..

if %errorlevel% equ 0 (
    echo ========================================
    echo   ✅ APK 构建成功！
    echo ========================================
    echo   文件位置:
    echo   android\app\build\outputs\apk\debug\
    echo.
    dir /b android\app\build\outputs\apk\debug\*.apk 2>nul
    echo.
    echo   安装到手机:
    echo   直接传输 APK 文件到手机安装即可
    echo ========================================
) else (
    echo [!!] 构建失败，请检查错误信息
)

pause
