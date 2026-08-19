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
*   **Aviso de la próxima reunión (opcional, apagado por defecto):** Lee **uno o varios** calendarios ICS publicados de Outlook/Teams y muestra la siguiente reunión del día como una casilla más, subiendo de color conforme se acerca. Una reunión inminente se lleva el peso sólido por delante de una consola bloqueada: el permiso te espera, la reunión no. Filtra eventos de todo el día, bloques de concentración y los marcados como libre. Su dependencia (`ical.js`) es **opcional y se carga en diferido**: quien no use la función no paga ni su instalación ni su arranque. [Cómo activarlo →](https://loksly.github.io/aimonitor/instalacion.html#aviso-de-la-proxima-reunion-microsoft-teams-outlook)
*   **Guiño cada cuarto de hora:** El panel deja el cuadro de mando unos veinte segundos y pone una carrera de plataformas de 8 bits, dibujada a mano en la paleta del propio panel. **No sale siempre igual**: cada pasada se siembra con la franja horaria, así que unas veces el corredor se cae por un hueco, otras se lo lleva un bicho por delante y cuatro de cada catorce llega al castillo. Se salta la franja si hay una sesión esperando permiso o una reunión encima. Va dibujada y no en vídeo por una razón medida: el bus comprime cada frame, y el arte plano da **12 fps** contra los **5** de una imagen fotográfica. Admite apuntar `easterEgg.source` a un vídeo propio o a un **directorio de clips**, del que elige uno distinto cada vez; `aimonitor-daemon --guino` reproduce una pasada al momento para probarlos. [Detalle →](https://loksly.github.io/aimonitor/instalacion.html#el-guino-de-cada-cuarto-de-hora)
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

Todo se configura en `~/.aimonitor/config.json`. **Sólo hace falta poner lo que quieras cambiar**: se funde con los valores por defecto, así que un fichero con tres líneas es perfectamente válido. Tienes un ejemplo completo y comentado en [`config.json.example`](config.json.example).

> El fichero puede contener URLs de calendario, que son **secretos portadores**. Créalo con permisos `600`.

### 🎮 El guiño de cada cuarto de hora

Cada `everyMs` el panel deja el cuadro de mando y pone una animación de plataformas.

```json
"easterEgg": {
  "enabled": true,
  "everyMs": 900000,
  "fps": 12,
  "speed": 1,
  "source": "",
  "maxSeconds": 30,
  "pixelated": true,
  "crop": "",
  "cacheClips": 3,
  "skipWhenBusy": true
}
```

| Opción | Qué hace |
|---|---|
| `enabled` | Ponlo a `false` para quitarlo del todo. |
| `everyMs` | Cada cuánto sale. Va **contra el reloj de pared**: con 900000 salta en punto, y cuarto, y media, no a los 15 minutos de arrancar. |
| `fps` | Fotogramas por segundo en el panel. El bus comprime cada frame, así que el techo lo pone el contenido: **~12 fps** con colores planos, **~8** con pixel art detallado, **~5** con imagen fotográfica. |
| `speed` | `1` = tiempo real; `0.5` = mitad de velocidad enseñando **todos** los frames del origen. Bajarla es lo que quita los tirones del desplazamiento lateral. |
| `source` | Vacío = la animación dibujada que viene de serie. Si no, la ruta de un vídeo, un GIF **o un directorio** de clips del que se elige uno distinto cada vez. Un directorio vacío vuelve a la animación integrada. |
| `maxSeconds` | Segundos que dura **en el panel** (no del clip: a media velocidad, medio clip llena el mismo rato). |
| `pixelated` | Escalado por factor entero y vecino más próximo. Correcto para capturas retro; ponlo a `false` para vídeo de imagen real. |
| `crop` | Recorte de ffmpeg (`ancho:alto:x:y`) antes de escalar. El panel es 4,16:1 y una captura 4:3 sólo llena el 27 % del ancho; recortando una franja apaisada se llega al 53 %. |
| `cacheClips` | Clips despiezados que se guardan. Cada uno son decenas de MB. |
| `skipWhenBusy` | Se salta la franja si hay una consola esperando permiso o una reunión encima. |

**Regla importante al usar clips propios:** `fps / speed` debe dividir de forma **exacta** a la cadencia de cada fichero del directorio. Si no, ffmpeg reparte los descartes de forma desigual y eso se ve como tirones mucho más que un framerate bajo pero regular. El daemon avisa por el log cuando pasa.

Para probar sin esperar al cuarto de hora:

```bash
systemctl --user stop aimonitor.service && aimonitor-daemon --guino; systemctl --user start aimonitor.service
```

[Cómo grabar los clips, con códec y resolución →](https://loksly.github.io/aimonitor/instalacion.html#el-guino-de-cada-cuarto-de-hora)

### 📅 Aviso de la próxima reunión

Desactivado por defecto. Requiere la dependencia opcional `ical.js` (`npm install -g ical.js`).

```json
"calendar": {
  "enabled": true,
  "icsUrl": ["https://outlook.office365.com/owa/calendar/.../calendar.ics"],
  "refreshMs": 300000,
  "showTitle": true,
  "titleMaxChars": 34,
  "ignorePatterns": ["tiempo de concentración", "focus time"],
  "minutes": { "grey": 120, "listo": 30, "espera": 10, "permiso": 3 }
}
```

| Opción | Qué hace |
|---|---|
| `icsUrl` | Una URL o **una lista de ellas** para vigilar varios calendarios a la vez (trabajo y personal, por ejemplo). Se funden en una sola agenda, se quitan los duplicados por hora y título, y gana la reunión más próxima. Que una fuente esté caída no te deja sin las otras. |
| `showTitle` | Con `false`, sólo hora y cuenta atrás. Los eventos marcados como privados ocultan el título igualmente. |
| `ignorePatterns` | Asuntos que no son reuniones. Los bloques de concentración de Outlook van marcados como «ocupado» y sin esto encenderían el panel media mañana. |
| `minutes` | Escalera de color según los minutos que falten: gris por encima de `grey`, luego teal, azul, ámbar y rojo sólido. |

> ⚠️ Cada URL publicada es un **secreto portador**: quien la tenga lee esa agenda entera sin autenticarse, y no caduca. Si se te escapa una, revócala republicando el calendario en Outlook.

[Cómo obtener la URL →](https://loksly.github.io/aimonitor/instalacion.html#aviso-de-la-proxima-reunion-microsoft-teams-outlook)

### 📊 La columna de vitales

Rellena el ancho que sobra cuando hay pocas consolas, y desaparece sola a partir de cuatro. Se lee de `/proc`, `/sys` y `os`: sin dependencias.

```json
"system": {
  "enabled": true,
  "minWidth": 190,
  "perCoreMinWidth": 700,
  "diskPath": "/",
  "warn": 0.85, "alert": 0.95,
  "tempWarn": 85, "tempAlert": 95
}
```

Se dibuja por niveles según el hueco disponible: por debajo de `minWidth` no sale, y sólo por encima de `perCoreMinWidth` aparecen las barras **por núcleo**. Sus umbrales son más altos que los del consumo a propósito: una RAM al 70 % es un martes cualquiera, y con los umbrales del carril la columna viviría encendida compitiendo con las consolas que sí reclaman.

### 📝 El mensaje de cada casilla

```json
"tile": { "min": 320, "max": 430, "gap": 12, "detailLines": 3 }
```

`detailLines` es cuántas líneas puede ocupar el mensaje antes de recortar con elipsis. Crecen **hacia arriba**, hacia el aire que dejaba el nombre del proyecto, así que el contador de tiempo no se mueve. Ponlo a `1` para el comportamiento anterior.

### 🧹 Higiene de sesiones

```json
"zombieMs": 900000,
"staleMs": 7200000
```

El hook borra el registro de una consola al recibir `SessionEnd`, pero ese evento **no llega** si matas el terminal, la máquina suspende o Claude Code se cae. Estos dos plazos son la red debajo:

- `zombieMs` — una sesión **activa** que lleva este rato sin emitir ningún evento está muerta.
- `staleMs` — cualquier sesión, en el estado que sea. Las que esperan al operador merecen manga ancha (para eso está el panel), pero no la eternidad: si llevas horas sin tocarla, te has ido a casa.

Cuando una cae, su fichero se borra de `~/.aimonitor/sessions/`. Es seguro: si la sesión resucita, el siguiente evento del hook lo vuelve a crear.

### 🖥️ Panel y salida

```json
"trcc": {
  "api": { "url": "http://127.0.0.1:8099" },
  "keepalive": { "enabled": true, "intervalS": 0.15, "burstS": 30 }
},
"blankWhenIdle": true,
"pixelShift": { "enabled": true, "amplitude": 2, "periodMs": 480000 }
```

La resolución **no se configura**: se toma la que reporte el panel en el *handshake* (1920×462 en este modelo, no los 1920×480 que anuncian las tiendas). `intervalS` es cada cuánto se reenvía la imagen para que el firmware LY no vuelva al logo, y `burstS` acota cada ráfaga para que un keepalive no sobreviva a la muerte del daemon.

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
*   `src/calendar.ts` - Próxima reunión desde un ICS publicado (zonas horarias y recurrencias vía `ical.js`).
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
