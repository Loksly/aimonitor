# aimonitor 📺✨

Un dashboard elegante y de alto rendimiento para mostrar de forma simultánea el estado de tus sesiones de **Claude Code** y **Gemini CLI** en el panel LCD USB **Thermalright Trofeo Vision** (1920×462).

Este proyecto convierte tu panel de hardware secundario en una "sala de control" del operador de IA: la normalidad es la oscuridad (píxeles apagados), iluminando únicamente las sesiones que reclaman tu atención con un sistema inteligente de jerarquía visual (pesos sólido, marcado y quieto).

> 📖 **[Guía de instalación y puesta en marcha →](https://loksly.github.io/aimonitor/instalacion.html)**
>
> Paso a paso completo, **diagnóstico de problemas** y las trampas del hardware
> que cuestan una tarde si las descubres por tu cuenta. Si tu panel **sólo
> muestra el logo de fábrica**, la respuesta está ahí.
>
> [Galería de escenarios →](https://loksly.github.io/aimonitor/)

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
    *   **Imagen fija (*keepalive*):** El firmware LY de este panel **descarta lo que muestra pasados ~2-3 s sin recibir un frame** y vuelve al logo de fábrica. El daemon mantiene la imagen clavada reenviándola cada 0,15 s, mientras el renderizado caro sigue disparándose sólo por eventos. [Por qué, en detalle →](https://loksly.github.io/aimonitor/instalacion.html#3-la-parte-que-no-es-obvia-por-que-hacen-falta-dos-servicios)
*   **Columna de vitales adaptativa:** Con pocas consolas sobra mucho ancho (1088 px con una sola sesión). Ese hueco se llena con temperatura de CPU, uso **por núcleo**, RAM, disco y una sparkline del gasto por bloque de 5 h. Se encoge por niveles y desaparece sola a partir de cuatro casillas, sin tocar el layout. Todo se lee de `/proc`, `/sys` y `os`: cero dependencias nuevas. [Detalle →](https://loksly.github.io/aimonitor/instalacion.html#la-columna-de-vitales)
*   **Resolución detectada, no supuesta:** El panel reporta **1920×462** en el *handshake*, no los 1920×480 que anuncian las tiendas. Todo el layout deriva de lo que diga el hardware al arrancar.
*   **Información del Sistema:** Muestra de forma eficiente la memoria **RAM libre/total** en tiempo real y el estado **Git** (ficheros sucios sin commit) por sesión.
*   **Métricas de Consumo Real:** Carril de consumo derecho integrado con la herramienta `ccusage` para rastrear tokens diarios, gasto acumulado en USD y desglose por modelo en tiempo real.

---

## 📦 Instalación

Puedes instalarlo de manera global en tu sistema para usar los binarios directamente:

```bash
npm install -g @loksly/aimonitor
```

### 1. Instalar las dependencias externas

El daemon no habla USB directamente: delega en **`trcc`**
([thermalright-trcc-linux](https://github.com/Lexonight1/thermalright-trcc-linux)),
y lee el consumo con **`ccusage`**. Sin estos dos binarios en el `PATH` el
panel se queda a oscuras y el carril de consumo, vacío.

```bash
# Driver del panel (pipx lo instala en ~/.local/bin, sin sudo)
sudo apt install pipx libusb-1.0-0 sg3-utils p7zip-full libxcb-cursor0
pipx install trcc-linux

# Métricas de consumo
npm install -g ccusage
```

Comprueba que el panel responde antes de seguir — la resolución que reporte
aquí es la que usará el daemon:

```bash
trcc detect
#  0416:5408  Winbond Trofeo Vision 9.16 LCD  (wire=ly, resolution=1920×462)
```

### 2. Configurar Reglas Udev (Linux)
Para que el daemon pueda escribir imágenes por USB al panel Thermalright Trofeo Vision sin requerir privilegios de `sudo`, instala las reglas udev incluidas:

```bash
# Copia las reglas a la carpeta del sistema
sudo cp 99-trcc.rules /etc/udev/rules.d/

# Recarga las reglas de udev
sudo udevadm control --reload-rules
sudo udevadm trigger
```

⚠️ **IMPORTANTE:** Es necesario **desenchufar y volver a conectar el cable USB** del panel LCD tras aplicar las reglas para que el sistema le asigne los nuevos permisos.

### 3. Configurar el Arranque Automático (Systemd)

Son **dos** unidades, y el orden importa:

*   `trcc-serve.service` — un único proceso que **posee el USB** y expone la API REST local.
*   `aimonitor.service` — el daemon, que le manda los frames por HTTP.

```bash
mkdir -p ~/.config/systemd/user/
cp trcc-serve.service aimonitor.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now trcc-serve.service
systemctl --user enable --now aimonitor.service
```

#### ⚠️ Por qué hacen falta dos procesos (y no uno)

El panel impone dos restricciones que condicionan toda la arquitectura de salida:

1.  **El firmware LY descarta la imagen.** Pasados **~2-3 s sin recibir un
    frame**, el panel vuelve solo al logo de fábrica. No basta con pintar
    cuando algo cambia: hay que **reenviar el último frame varias veces por
    segundo** para dejarlo fijo.
2.  **El interfaz USB es exclusivo.** Dos procesos de `trcc` no pueden
    hablarle a la vez; el segundo falla con
    `interface is in use by another process`.

Juntas, obligan a que **un solo proceso** haga las dos cosas. De ahí
`trcc serve`: posee el dispositivo, mantiene el bucle de reenvío y acepta
frames nuevos por HTTP, serializando ambos.

El coste es menor de lo que parece: la carga que `trcc` pone en el bus son ~145 KB por frame (el PNG que genera el daemon pesa 60-85 KB), así que
clavarlo a 0,15 s son ~1 MB/s sobre un bus de 480 Mbps. El renderizado caro
(canvas, git, `ccusage`) **sigue disparándose por eventos**; lo único
periódico es el reenvío, que no vuelve a dibujar nada.

Puedes monitorizar la actividad del daemon en tiempo real con:
```bash
journalctl --user -u aimonitor.service -f
```

---

## 🔗 Configuración de los Hooks

Para integrar tus asistentes locales con el panel, debes configurar los disparadores (hooks) de eventos.

### Integración con Claude Code
Los hooks se declaran en `~/.claude/settings.json`, **uno por evento**, y cada
entrada lleva su propia lista de comandos. Claude Code entrega el evento por
stdin, así que el comando no necesita argumentos.

Pega este fragmento dentro de tu `settings.json` (si ya tienes hooks en alguno
de estos eventos, **añade** la entrada a la lista existente en lugar de
reemplazarla):

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "PreToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "PostToolUse":      [{ "matcher": "*", "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "Notification":     [{ "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "SubagentStop":     [{ "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }],
    "SessionEnd":       [{ "hooks": [{ "type": "command", "command": "aimonitor-hook", "timeout": 5 }] }]
  }
}
```

Si `aimonitor-hook` no está en el `PATH` que ve Claude Code, pon la ruta
absoluta al intérprete y al script:
`"\"/ruta/a/node\" \"/ruta/a/aimonitor/dist/src/hook.js\""`.

El hook lee los campos reales del evento (`hook_event_name`, `session_id`,
`cwd`, `tool_name`, `tool_input`, `notification_type`, …) y conserva el
instante en que la sesión entró en su estado actual, que es lo que alimenta el
contador grande de "cuánto lleva así".

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

Genera el sitio completo (PNGs + documentación + galería), igual que hace el workflow de Pages:
```bash
npm run pages
```

O cada pieza por separado:
```bash
npm run docs      # docs/*.md  ->  preview/*.html
npm run gallery   # galería de escenarios -> preview/index.html
```

El sitio publicado sale de `preview/`:
**[galería](https://loksly.github.io/aimonitor/)** ·
**[guía de instalación](https://loksly.github.io/aimonitor/instalacion.html)**.

> 💡 Los `docs/*.md` del repositorio son la **fuente de verdad**: las páginas de
> GitHub Pages se generan a partir de ellos, así que no hay dos copias del mismo
> texto que se puedan desincronizar. Añadir un `.md` a `docs/` lo publica y lo
> añade a la navegación automáticamente.

---

## 🗺️ Mapa del Repositorio

*   `src/hook.ts` - CLI de entrada que traduce eventos de IA a archivos JSON de sesión de forma atómica.
*   `src/daemon.ts` - Proceso de fondo reactivo que vigila archivos, ejecuta git, actualiza uso y renderiza.
*   `src/panel.ts` - Capa de salida: habla con la API de `trcc serve` y mantiene la imagen fija en el panel.
*   `src/system.ts` - Vitales de la máquina desde `/proc`, `/sys` y `os`, sin dependencias.
*   `src/sparkline.ts` - Geometría pura de la sparkline (sin canvas, por eso es testeable).
*   `src/usage.ts` - Adaptador para parsear la salida JSON real de `ccusage`.
*   `src/render.ts` - Motor gráfico que compone la cabecera, casillas, reloj y carril derecho.
*   `src/select.ts` - Algoritmo que planifica cuántas casillas caben y cómo agrupar las sobrantes.
*   `src/fonts.ts` - Implementación tipográfica, tracking manual de versalitas y elipsis.
*   `src/docs.ts` - Genera las páginas de GitHub Pages a partir de `docs/*.md`.
*   `docs/` - Documentación en Markdown (fuente de verdad del sitio publicado).
*   `trcc-serve.service` / `aimonitor.service` - Las dos unidades de systemd.

---

## 📄 Licencia

Este proyecto se distribuye bajo la licencia **MIT**. Siéntete libre de colaborar, abrir *issues* o enviar *pull requests* para mejorar la experiencia de desarrollo con IA en hardware complementario.
