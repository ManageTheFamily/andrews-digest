@echo off
setlocal

cd /d E:\Lucas\Personal-Productivity\digest

echo [%date% %time%] Starting digest generation...

node fetch-digest.js
if %ERRORLEVEL% neq 0 (
    echo [%date% %time%] Digest generation failed with exit code %ERRORLEVEL%
    exit /b 1
)

copy /y output\digest-latest.html index.html

git add output/ index.html
git commit -m "Daily digest - %date:~-4%-%date:~-10,2%-%date:~-7,2%"
git push origin main

echo [%date% %time%] Digest complete and pushed.
