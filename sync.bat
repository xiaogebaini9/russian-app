@echo off
cd /d %~dp0
rem ============ 三份同步脚本 sync.bat ============
rem 说明：升缓存版本号 + 同步 www + 同步 APK 资产
rem 要求：本文件 GBK + CRLF 编码，中文才能正常显示

rem 1. 自动升级 sw.js 缓存版本号（v8 -> v9 -> v10 ...）
rem    ※ 用 UTF-8 无 BOM 读写，避免把 sw.js 里的中文改坏
powershell -NoProfile -Command "$p=(Join-Path $PWD 'sw.js'); $s=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8); $m=[regex]::Match($s,'russian-app-v(\d+)'); if(!$m.Success){Write-Host 'ERR: not found russian-app-vN'; exit 1}; $n=[int]$m.Groups[1].Value+1; $s=[regex]::Replace($s,'russian-app-v\d+',('russian-app-v'+$n)); [IO.File]::WriteAllText($p,$s,(New-Object Text.UTF8Encoding($false))); Write-Host ('OK: sw.js cache v'+$n)" || goto :err

rem 2. 同步 www（Capacitor Web 资源）
copy /y index.html www\ >nul
copy /y style.css www\ >nul
copy /y sw.js www\ >nul
copy /y manifest.json www\ >nul

rem 3. 同步 APK 资产（assets 里不需要 proxy.js）
copy /y index.html android\app\src\main\assets\public\ >nul
copy /y style.css android\app\src\main\assets\public\ >nul
copy /y sw.js android\app\src\main\assets\public\ >nul
copy /y manifest.json android\app\src\main\assets\public\ >nul

echo 三份同步完成，需要 APK 的话再跑 build-apk.bat
pause
exit /b 0

:err
echo [失败] sw.js 版本号升级失败，请检查 sw.js 是否存在且含 russian-app-vN
pause
exit /b 1
