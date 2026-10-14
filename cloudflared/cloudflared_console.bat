@echo off
title Cloudflare Tunnel - Console Interativo
color 0A

echo ======================================================
echo   Cloudflare Tunnel - Terminal Interativo
echo ======================================================
echo.

:: Detecta arquitetura
set "ARCH="
if "%PROCESSOR_ARCHITECTURE%"=="AMD64" set "ARCH=amd64"
if "%PROCESSOR_ARCHITECTURE%"=="ARM64" set "ARCH=arm64"
if "%PROCESSOR_ARCHITECTURE%"=="x86"   set "ARCH=386"

if "%ARCH%"=="" (
    if not "%PROCESSOR_ARCHITEW6432%"=="" (
        if "%PROCESSOR_ARCHITEW6432%"=="AMD64" set "ARCH=amd64"
        if "%PROCESSOR_ARCHITEW6432%"=="ARM64" set "ARCH=arm64"
    )
)
if "%ARCH%"=="" set "ARCH=386"

set "BIN_NAME=cloudflared-windows-%ARCH%.exe"
set "TARGET_NAME=cloudflared.exe"

:: Verifica se o binário específico existe
if exist "%~dp0%BIN_NAME%" (
    set "SOURCE=%~dp0%BIN_NAME%"
    goto :check_target
)
if exist "%~dp0%TARGET_NAME%" (
    set "SOURCE="
    goto :ready
)

echo [ERRO] Nenhum binario encontrado!
echo Procurei por: %BIN_NAME% ou cloudflared.exe
pause
exit /b 1

:check_target
:: Se o binário específico existe mas não o cloudflared.exe, cria uma cópia (não renomeia para preservar o original)
if not exist "%~dp0%TARGET_NAME%" (
    echo [INFO] Criando %TARGET_NAME% a partir de %BIN_NAME%...
    copy "%~dp0%BIN_NAME%" "%~dp0%TARGET_NAME%" >nul
    if errorlevel 1 (
        echo [ERRO] Falha ao copiar. Tente executar como Administrador.
        pause
        exit /b 1
    )
    echo [OK] Arquivo %TARGET_NAME% criado.
)
goto :ready

:ready
:: Adiciona a pasta atual ao PATH da sessão
set "PATH=%~dp0;%PATH%"

echo.
echo ======================================================
echo   Terminal pronto! Digite seus comandos EXATAMENTE:
echo.
echo   cloudflared tunnel login
echo   cloudflared tunnel create NOME
echo   cloudflared tunnel route dns NOME coin.your-domain.com
echo   cloudflared tunnel run NOME
echo.
echo   Para sair, digite EXIT
echo ======================================================
echo.

:: Inicia um novo cmd.exe que herda as variáveis e o PATH
cmd /k "echo Bem-vindo! & echo."
