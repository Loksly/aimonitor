---
name: Reporte de Bug 🐛
about: Informa sobre un comportamiento inesperado o un error en aimonitor.
title: "[BUG] "
labels: bug
assignees: ''

---

**Describe el Bug**
Una descripción clara y concisa de cuál es el problema.

**Pasos para Reproducir**
Pasos para reproducir el comportamiento:
1. Configuración de hooks en `settings.json` o ejecución manual.
2. Comando de IA ejecutado (Claude Code o Gemini CLI).
3. Ver el log en `journalctl --user -u aimonitor.service -f`.
4. Detalle del error arrojado.

**Comportamiento Esperado**
Una descripción clara y concisa de lo que esperabas que sucediera.

**Capturas de Pantalla (si procede)**
Si es un problema de renderizado visual, añade un preview o captura aquí.

**Información de tu Entorno:**
 - Sistema Operativo: [ej. Ubuntu 24.04, Arch Linux]
 - Versión de Node.js: [ej. v24.1.0]
 - Versión de aimonitor: [ej. v1.0.0]
 - Tipo de Panel / Resolución: [ej. Thermalright Trofeo Vision 1920x462]

**Logs Adicionales**
Pega cualquier salida de log relevante de tu terminal o del servicio de systemd.
