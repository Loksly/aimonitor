# aimonitor 📺✨

Un dashboard elegante y de alto rendimiento para mostrar de forma simultánea el estado de tus sesiones de **Claude Code** y **Gemini CLI** en el panel LCD USB **Thermalright Trofeo Vision** (1920×462 / 1920x480).

Este proyecto convierte tu panel de hardware secundario en una "sala de control" del operador de IA: la normalidad es la oscuridad (píxeles apagados), iluminando únicamente las sesiones que reclaman tu atención con un sistema inteligente de jerarquía visual (pesos sólido, marcado y quieto).

---

## 🚀 Características Principales

*   **Soporte Multi-Proveedor:** Registra y muestra simultáneamente sesiones activas tanto de **Claude** como de **Gemini**.
*   **Diseño de Sala de Control de Alta Prioridad:**
    *   🟥 **Sólido:** Únicamente la consola más urgente (bloqueada por permisos) se muestra a pleno color y texto oscuro para verse de reojo.
    *   🟨 **Marcada:** Casillas oscuras con una línea/espina de color a sangre en el canto izquierdo de las que esperan entrada del operador.
    *   🟦 **Quieta:** Sesiones inactivas o trabajando en segundo plano que no reclaman tu atención inmediata.
*   **Optimización de Hardware & Salud del Panel:**
    *   **Pixel-Shifting:** Desplaza de forma invisible todo el layout 1–2 píxeles en un ciclo lento cada pocos minutos para evitar el quemado de pantalla (*image retention*).
    *   **Apagado Inteligente:** Pone la pantalla en negro absoluto (`#000000`) cuando no hay consolas activas, protegiendo la vida del *backlight*.
    *   **Pruning de Zombis:** Descarta automáticamente sesiones en segundo plano que hayan muerto sin cerrarse limpiamente.
*   **Información del Sistema:** Muestra de forma eficiente la memoria **RAM libre/total** en tiempo real y el estado **Git** (ficheros sucios sin commit) por sesión.
*   **Métricas de Consumo Real:** Carril de consumo derecho integrado con la herramienta `ccusage` para rastrear tokens diarios, gasto acumulado en USD y desglose por modelo en tiempo real.

---

## 📦 Instalación

Puedes instalarlo de manera global en tu sistema para usar los binarios directamente:

```bash
npm install -g @loksly/aimonitor
```

### 1. Configurar Reglas Udev (Linux)
Para que el daemon pueda escribir imágenes por USB al panel Thermalright Trofeo Vision sin requerir privilegios de `sudo`, instala las reglas udev incluidas:

```bash
# Copia las reglas a la carpeta del sistema
sudo cp 99-trcc.rules /etc/udev/rules.d/

# Recarga las reglas de udev
sudo udevadm control --reload-rules
sudo udevadm trigger
```

⚠️ **IMPORTANTE:** Es necesario **desenchufar y volver a conectar el cable USB** del panel LCD tras aplicar las reglas para que el sistema le asigne los nuevos permisos.

### 2. Configurar el Arranque Automático (Systemd)
Para que el daemon empiece a funcionar de forma cómoda al iniciar tu sesión de usuario local:

```bash
# Crear directorio de servicios de usuario si no existe
mkdir -p ~/.config/systemd/user/

# Copiar la unidad de servicio
cp aimonitor.service ~/.config/systemd/user/

# Recargar systemd de usuario, habilitar e iniciar el servicio
systemctl --user daemon-reload
systemctl --user enable aimonitor.service
systemctl --user start aimonitor.service
```

Puedes monitorizar la actividad del daemon en tiempo real con:
```bash
journalctl --user -u aimonitor.service -f
```

---

## 🔗 Configuración de los Hooks

Para integrar tus asistentes locales con el panel, debes configurar los disparadores (hooks) de eventos.

### Integración con Claude Code
Añade el hook en tu configuración global de Claude (`~/.anthropic/config.json` o `settings.json` según tu instalación):

```json
{
  "hooks": {
    "on_event": "aimonitor-hook"
  }
}
```

### Integración con Gemini CLI o Scripts Custom
El hook soporta el parámetro `--provider` para clasificar las sesiones. Puedes invocarlo manualmente o desde scripts pasando el JSON del evento por entrada estándar:

```bash
echo '{"event": "UserPromptSubmit", "sessionId": "session-123", "cwd": "/home/loksly/dev/proyecto"}' | aimonitor-hook --provider gemini
```

---

## 🛠️ Configuración Avanzada

Puedes personalizar resoluciones, márgenes, comportamiento y topes de API creando tu archivo de configuración en `~/.aimonitor/config.json`:

```json
{
  "rail": {
    "enabled": true,
    "width": 356
  },
  "tile": {
    "min": 320,
    "max": 430,
    "gap": 12
  },
  "usage": {
    "mode": "api",
    "dailyCap": 15.0,
    "monthlyCap": 300.0,
    "refreshMs": 60000
  },
  "blankWhenIdle": true
}
```

---

## 🎨 Galería y Desarrollo de Previews

El proyecto incluye un robusto sistema de vistas previas offline para desarrollo iterativo sin necesidad de tener el hardware conectado.

Genera todos los escenarios en formato de imagen PNG:
```bash
npm run preview -- --all --out preview
```

Genera una galería HTML interactiva local para ver el aspecto de cada escenario:
```bash
npm run gallery
```

Puedes ver los previews en vivo publicados en **GitHub Pages** (enlazado a tu pipeline de GitHub).

---

## 🗺️ Mapa del Repositorio

*   `src/hook.ts` - CLI de entrada que traduce eventos de IA a archivos JSON de sesión de forma atómica.
*   `src/daemon.ts` - Proceso de fondo reactivo que vigila archivos, ejecuta git, actualiza uso y renderiza.
*   `src/usage.ts` - Adaptador para parsear la salida JSON real de `ccusage`.
*   `src/render.ts` - Motor gráfico que compone la cabecera, casillas con iconos, reloj y carril derecho.
*   `src/select.ts` - Algoritmo que planifica cuántas casillas caben y cómo agrupar las sobrantes.
*   `src/fonts.ts` - Implementación tipográfica, tracking manual de versalitas y elipsis.

---

## 📄 Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Siéntete libre de colaborar, abrir *issues* o enviar *pull requests* para mejorar la experiencia de desarrollo con IA en hardware complementario.
