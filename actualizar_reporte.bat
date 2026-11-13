@echo off
title Actualizador Siigo - Agilex Express
cd /d "%~dp0"
echo ====================================================
echo    ACTUALIZADOR DIARIO DE REPORTE SIIGO
echo ====================================================
echo.
node descargar_reporte.js
echo.
if %ERRORLEVEL% equ 0 (
    echo [OK] Proceso terminado exitosamente.
) else (
    echo [ERROR] Ocurrio un fallo durante la ejecucion.
)
echo.
pause
