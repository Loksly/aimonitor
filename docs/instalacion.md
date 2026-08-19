# Guía de instalación y puesta en marcha

Cómo dejar funcionando **aimonitor** sobre un panel LCD USB **Thermalright
Trofeo Vision 9.16"** en Linux, de cero.

Esta guía documenta la instalación real sobre Ubuntu 22.04, incluidos **los
cuatro puntos donde el panel se queda mostrando el logo de fábrica** y no es
evidente por qué. Si has llegado aquí buscando *"mi Trofeo Vision sólo muestra
el logo"*, ve directo a [El panel sólo muestra el logo](#el-panel-solo-muestra-el-logo).

---

## Resumen para impacientes

```bash
# 1. Dependencias externas
sudo apt install pipx libusb-1.0-0 sg3-utils p7zip-full libxcb-cursor0
pipx install trcc-linux
npm install -g ccusage

# 2. Permisos USB (requiere sudo)
sudo cp 99-trcc.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger --attr-match=idVendor=0416
#    ...y DESENCHUFAR Y VOLVER A ENCHUFAR el cable USB

# 3. Comprobar que el panel responde
trcc detect
#   0416:5408  Winbond Trofeo Vision 9.16 LCD  (wire=ly, resolution=1920×462)

# 4. aimonitor  (necesita >= 1.1.0; ver nota más abajo)
npm install -g @loksly/aimonitor

# 5. Los DOS servicios (el orden importa)
mkdir -p ~/.config/systemd/user/
cp trcc-serve.service aimonitor.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now trcc-serve.service
systemctl --user enable --now aimonitor.service

# 6. Hooks de Claude Code -> ~/.claude/settings.json (ver más abajo)
```

---

## Instalar aimonitor

> ⚠️ **Necesitas la versión 1.1.0 o superior.** La arquitectura que describe
> esta guía —API REST, *keepalive*, unidad `trcc-serve.service`— se introdujo en
> la 1.1.0. Las versiones anteriores invocaban la CLI de `trcc` con un
> subcomando que no existe y **nunca llegaban a pintar nada**, así que el
> diagnóstico de más abajo no te servirá con ellas.

```bash
npm install -g @loksly/aimonitor
npm ls -g --depth=0 @loksly/aimonitor     # comprueba la versión instalada
```

Si en el registro todavía no hay una versión ≥ 1.1.0, instala desde el
repositorio:

```bash
git clone https://github.com/Loksly/aimonitor.git
cd aimonitor
npm install && npm run build && npm install -g .
```

> 💡 **Dónde están los ficheros auxiliares.** Los comandos de esta guía copian
> `99-trcc.rules`, `trcc-serve.service` y `aimonitor.service` desde el
> directorio actual, lo cual funciona si has clonado el repositorio. Con una
> instalación global de npm viven en:
>
> ```bash
> cd "$(npm root -g)/@loksly/aimonitor"
> ```

---

## El hardware

| Dato | Valor |
|---|---|
| Modelo | Thermalright Trofeo Vision 9.16" |
| ID USB | `0416:5408` (se presenta como *Winbond Electronics — USBDISPLAY*) |
| Protocolo | `ly` (bulk troceado) |
| Resolución **real** | **1920 × 462** |

> ⚠️ **No es un monitor.** No aparece en `xrandr` ni consume salida gráfica: es
> un dispositivo USB al que se le envían imágenes.

> ⚠️ **1920×462, no 1920×480.** Las tiendas anuncian 480 px de alto; el
> dispositivo reporta 462 en el *handshake*. Un layout de 462 sobre un panel de
> 480 haría letterbox, pero al revés **se recorta**. No lo fijes a mano:
> `aimonitor` pregunta la resolución al arrancar y renderiza con lo que reporte
> el hardware.

---

## 1. Dependencias externas

`aimonitor` **no habla USB directamente**. Delega en dos herramientas externas,
y sin ellas arranca pero no hace nada visible:

| Binario | Para qué | Si falta |
|---|---|---|
| [`trcc`](https://github.com/Lexonight1/thermalright-trcc-linux) | Driver del panel | La pantalla se queda a oscuras |
| [`ccusage`](https://github.com/ryoppippi/ccusage) | Métricas de consumo | El carril derecho queda vacío / obsoleto |

```bash
# Dependencias de sistema del driver
sudo apt install pipx libusb-1.0-0 sg3-utils p7zip-full libxcb-cursor0   # Debian/Ubuntu/Mint
sudo dnf install pipx libusb-1.0.0 sg3_utils p7zip                       # Fedora

pipx install trcc-linux     # se instala en ~/.local/bin, sin sudo
npm install -g ccusage
```

`trcc-linux` es un port a Linux del *TRCC* de Windows hecho por ingeniería
inversa. Es un proyecto vivo (>160 versiones publicadas): si algo no encaja con
esta guía, contrasta primero con su propio `--help`, que manda sobre lo que
digan estas páginas.

---

## 2. Permisos USB (reglas udev)

Recién enchufado, el nodo del dispositivo pertenece a `root` y tu usuario sólo
puede leerlo:

```console
$ ls -la /dev/bus/usb/003/004
crw-rw-r-- 1 root root 189, 259 /dev/bus/usb/003/004
#      ^-- sin permiso de escritura para tu usuario
```

Cualquier intento de pintar falla con:

```
PermissionError_: USB access denied for 0416:5408 — check udev rules
```

Instala la regla incluida en el repositorio:

```bash
sudo cp 99-trcc.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules
sudo udevadm trigger --attr-match=idVendor=0416
```

> ⚠️ **Desenchufa y vuelve a enchufar el cable USB.** udev aplica el nuevo modo
> cuando el dispositivo se vuelve a enumerar; sobre un dispositivo ya conectado
> la regla puede no surtir efecto.

Comprobación — debe aparecer `rw` para todos, y una `+` (ACL de `uaccess`):

```console
$ ls -la /dev/bus/usb/003/007
crw-rw-rw-+ 1 root root 189, 262 /dev/bus/usb/003/007
```

> 💡 Tras el replug **cambia el número de dispositivo** (`004` → `007`). Si
> tenías una terminal con el número viejo, verás `USB device not found`: no es
> un fallo, es que estás mirando un nodo que ya no existe.

---

## 3. La parte que no es obvia: por qué hacen falta dos servicios

Éste es el hallazgo que más tiempo cuesta si lo descubres a base de prueba y
error. El panel impone **dos restricciones** que, juntas, determinan toda la
arquitectura de salida.

### Restricción 1 — el firmware descarta la imagen

El firmware LY **borra lo que esté mostrando pasados ~2-3 segundos sin recibir
un frame nuevo**, y vuelve solo al logo de fábrica. Lo dice la propia ayuda de
`trcc`:

> *"Workaround for Bulk/LY firmware that drops the displayed image when the
> internal buffer ages out. Bulk/LY firmware reverts to the built-in logo after
> ~2-3 s without a frame; default 0.150 s keeps the screen pinned."*

Es decir: **no basta con pintar cuando algo cambia**. Hay que reenviar el
último frame varias veces por segundo para dejar la imagen fija. El síntoma, si
no lo haces, es inconfundible: *el dashboard parpadea y vuelve al logo cada 1-2
segundos*.

### Restricción 2 — el USB es de acceso exclusivo

Sólo un proceso puede tener abierto el interfaz. El segundo recibe:

```
USB device 0416:5408 interface is in use by another process.
Close any other TRCC instances and try again.
```

Esto descarta la solución intuitiva —un proceso que reenvíe + otro que mande
los frames nuevos— porque **se bloquean mutuamente**.

### La solución

Un **único proceso posee el dispositivo** y sirve las dos cosas, serializándolas:
`trcc serve`, la API REST local.

```
   hooks de Claude Code
            │  (escriben JSON de sesión)
            ▼
   ~/.aimonitor/sessions/*.json
            │  (inotify)
            ▼
   ┌───────────────────┐   HTTP    ┌──────────────────┐   USB    ┌───────┐
   │ aimonitor.service │ ────────► │ trcc-serve       │ ───────► │ panel │
   │  render por       │  frames   │  (dueño del USB) │  bulk    │  LCD  │
   │  eventos          │           │  + keepalive     │          └───────┘
   └───────────────────┘           └──────────────────┘
```

* `POST /devices/{key}/display/send-image` → sólo cuando cambia algo.
* `POST /devices/{key}/display/keepalive` → petición de larga duración que
  reenvía **el último frame** cada 0,15 s.

Verificado: el servidor acepta un `send-image` mientras el keepalive está
corriendo (una sola instancia, así que los serializa en lugar de chocar), y el
keepalive pasa a reenviar el frame **nuevo**. Los cambios se propagan.

### ¿No es un desperdicio refrescar a 6,7 fps?

Menos de lo que parece, y desde luego menos de lo que costaría no hacerlo:

* Un frame son **~145 KB** en el bus (el PNG ronda los 60-85 KB), no 1,7 MB.
* Clavarlo a 0,15 s son **~1 MB/s** sobre un bus de 480 Mbps: **menos del 2 %**.
* El trabajo **caro** (componer el canvas, consultar git, leer `ccusage`)
  **sigue disparándose por eventos**. Lo único periódico es reenviar bytes ya
  calculados, que no vuelve a dibujar nada.

---

## 4. Los dos servicios de systemd

```bash
mkdir -p ~/.config/systemd/user/
cp trcc-serve.service aimonitor.service ~/.config/systemd/user/

systemctl --user daemon-reload
systemctl --user enable --now trcc-serve.service   # primero: abre el USB
systemctl --user enable --now aimonitor.service    # después: manda frames
```

`aimonitor.service` declara `Wants=` y `After=trcc-serve.service`, así que el
orden se respeta solo al iniciar sesión.

> ⚠️ **systemd no lee tu `~/.bashrc` ni tu `~/.profile`.** El `PATH` de una
> unidad de usuario **no** incluye ni `~/.local/bin` (donde pipx pone `trcc`) ni
> el `bin` de nvm (donde están `node` y `ccusage`). Sin una línea
> `Environment=PATH=...` el daemon arranca —y parece sano— pero no encuentra
> ninguna de las dos herramientas: panel a oscuras y carril vacío, sin un error
> claro. Ambas unidades incluidas ya la traen; **ajusta la ruta de nvm a la
> tuya**:
>
> ```bash
> dirname "$(which node)"
> ```

Seguimiento en vivo:

```bash
journalctl --user -u aimonitor.service -f
journalctl --user -u trcc-serve.service -f
```

Un arranque correcto tiene esta pinta:

```
Iniciando daemon de aimonitor...
Panel detectado: 0416:5408 a 1920x462
Panel reconectado.
Imagen fijada: reenvío cada 0.15s (el firmware LY la descarta a los ~2-3s)
Vigilando cambios en: /home/usuario/.aimonitor/sessions
```

---

## 5. Hooks de Claude Code

Los hooks se declaran en `~/.claude/settings.json`, **uno por evento**, cada uno
con su lista de comandos. Claude Code entrega el evento por *stdin*, así que el
comando no lleva argumentos.

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

> ⚠️ **Si ya tienes hooks en alguno de esos eventos, añade la entrada a la lista
> existente en lugar de reemplazarla.** El array admite varios comandos por
> evento y se ejecutan todos.

Si `aimonitor-hook` no está en el `PATH` que ve Claude Code, pon rutas absolutas:

```json
"command": "\"/ruta/a/node\" \"/ruta/a/aimonitor/dist/src/hook.js\""
```

### Cómo comprobar que el hook funciona

El hook **falla en silencio por diseño** (sale con 0 pase lo que pase, para no
romper tu sesión de Claude), así que no esperes un error si algo va mal.
Pruébalo a mano:

```bash
echo '{"hook_event_name":"Notification","session_id":"t1","cwd":"'$PWD'","notification_type":"permission_prompt"}' \
  | aimonitor-hook
cat ~/.aimonitor/sessions/t1.json     # -> "state": "permiso"

echo '{"hook_event_name":"SessionEnd","session_id":"t1","cwd":"'$PWD'","session_end_reason":"clear"}' \
  | aimonitor-hook
ls ~/.aimonitor/sessions/t1.json      # -> ya no existe
```

El hook lee los nombres **reales** de los campos de Claude Code
(`hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`,
`notification_type`, `last_assistant_message`…) y conserva el instante en que la
sesión entró en su estado actual, que es lo que alimenta el contador grande de
*"cuánto lleva así"*.

---

## 6. El carril de consumo

`ccusage` **no expone el límite del plan**, así que en modo `max` no hay
denominador con el que calcular un porcentaje honesto. En lugar de inventarse
uno, `aimonitor` calibra el 100 % **contra tu propio histórico**:

```json
"usage": {
  "mode": "max",
  "calibration": { "metric": "cost", "lookbackDays": 30, "percentile": 100 }
}
```

* `metric: "cost"` — usa el coste equivalente, mejor proxy de quema de plan que
  los tokens brutos (dominados por lecturas de caché).
* `percentile: 100` — el 100 % de la barra es tu bloque **más cargado** de los
  últimos `lookbackDays`.

> 💡 Con `percentile: 100` las barras se quedan bajas salvo en tu sesión récord.
> Si las prefieres más expresivas, baja a `90`.

En modo `api` se muestra el gasto de hoy y del mes contra `dailyCap` y
`monthlyCap`, en USD.

---

## La columna de vitales

Cuando hay pocas consolas sobra mucho ancho: **1088 px con una sesión**, 646 con
dos y 204 con tres. A partir de cuatro casillas no sobra nada. Ese hueco lo
ocupa una columna con la temperatura de CPU, el uso por núcleo, la RAM, el disco
y una sparkline del gasto por bloque de 5 h.

Se adapta al sitio disponible:

| Ancho sobrante | Qué se dibuja |
|---|---|
| ≥ 700 px | cuatro cifras + **una barra por núcleo** + sparkline con el pico |
| 380–700 px | cuatro cifras + barra de disco con detalle + sparkline |
| 190–380 px | rejilla 2×2 de cifras + sparkline compacta |
| < 190 px | nada: no cabe nada legible |

> 💡 **Los umbrales son propios y más altos que los del consumo** (0,85 / 0,95
> frente a 0,6 / 0,85). No es un descuido: una RAM al 70 % es un martes
> cualquiera, y con los umbrales del carril la columna viviría encendida en
> ámbar compitiendo con las consolas que sí reclaman al operador. En normalidad
> la columna se lee **apagada**; sólo se enciende al cruzar el umbral.

Todo se lee de `/proc`, `/sys` y `os`: **ninguna dependencia nueva** y ninguna
llamada de red. En particular **no** se usa la API de sensores de `trcc`, por lo
que se explica en la nota de abajo.

Se ajusta en `~/.aimonitor/config.json`:

```json
"system": {
  "enabled": true,
  "minWidth": 190,
  "perCoreMinWidth": 700,
  "diskPath": "/",
  "warn": 0.85,
  "alert": 0.95,
  "tempWarn": 85,
  "tempAlert": 95
}
```

`diskPath` es el sistema de ficheros que quieres vigilar; pon el del disco donde
trabajas si no es el raíz.

---

## Aviso de la próxima reunión (Microsoft Teams / Outlook)

**Función opcional, desactivada por defecto.** Si no la configuras, no se
descarga nada, no se toca la red y ni siquiera se carga su dependencia. Cuando
se activa, la próxima reunión del día aparece como **una casilla más**, con el
título, la hora de inicio y la cuenta atrás, subiendo de color conforme se
acerca.

### Activarla

Son dos pasos, y el primero sólo hace falta si quieres esta función:

```bash
# 1. La dependencia, que es opcional
npm install -g ical.js

# 2. Activarla en ~/.aimonitor/config.json (ver más abajo)
```

`ical.js` está declarada en `optionalDependencies`, así que `npm install` la
instala por comodidad pero **no falla si no puede**, y el daemon arranca
igualmente sin ella. Si activas el calendario sin tenerla, el aviso lo dice
claro en el log y el resto del panel se sigue pintando:

```
Advertencia: no se pudo leer el calendario: el calendario está activado pero
falta la dependencia opcional `ical.js`.
```

Para quitarla del todo:

```bash
npm uninstall -g ical.js   # y "calendar": { "enabled": false }
```

### Varios calendarios a la vez

`icsUrl` admite una lista además de una URL suelta:

```json
"calendar": {
  "enabled": true,
  "icsUrl": [
    "https://outlook.office365.com/owa/calendar/.../calendar.ics",
    "https://calendar.google.com/calendar/ical/.../basic.ics"
  ]
}
```

Se descargan **en paralelo** y se funden en una sola agenda: gana la reunión más
próxima, venga de donde venga. Tres detalles que importan:

- **Una fuente caída no te deja sin las demás.** Se usa `allSettled`, no `all`,
  y cada calendario conserva su propia copia local para sobrevivir a un corte de
  red. El log avisa una vez por calendario roto, no cada cinco minutos, y **cita
  la posición en la lista, nunca la URL** —que es un secreto portador.
- **Los duplicados se descartan** por hora y título. En cuanto compartes agenda
  con alguien, la misma reunión aparece en dos calendarios.
- **La caché va por URL**, con el nombre derivado de un hash de la propia
  dirección (`~/.aimonitor/calendar-<hash>.ics`, permisos `600`). Así añadir o
  quitar calendarios no reordena los ficheros ni deja a un feed leyendo la caché
  de otro. El `calendar.ics` de la versión de una sola URL se borra solo.

### Por qué por ICS y no por Teams

En Linux no hay atajo:

* Microsoft **retiró el cliente de Teams para Linux**, así que no hay caché
  local de calendario que leer.
* Microsoft 365 **no expone CalDAV**, de modo que Thunderbird —que sólo trae
  CalDAV y almacenamiento local— no puede suscribirse a la agenda corporativa.
* `evolution-ews` usa EWS, que Microsoft está retirando, y en Ubuntu 22.04 es
  una versión de 2022.

Quedan dos vías: **publicar el calendario como ICS** (lo que hace esta
integración) o **Microsoft Graph** con registro de app en Azure AD. El ICS no
necesita autenticación ni permisos de administrador, así que es el camino corto
si tu organización lo permite.

### Cómo obtener la URL

Outlook Web → **Configuración** → **Calendario** → **Calendarios compartidos** →
**Publicar un calendario**. Elige el nivel de detalle y copia el enlace `.ics`.

> ⚠️ **Esa URL es un secreto portador.** Quien la tenga lee tu agenda entera sin
> autenticarse, y no caduca. Guárdala sólo en `~/.aimonitor/config.json`, que se
> escribe con permisos `600`, y no la pegues en tickets, capturas ni chats. Si se
> te escapa, despublica y vuelve a publicar: se genera una URL nueva y la
> anterior deja de servir.

```json
"calendar": {
  "enabled": true,
  "icsUrl": "https://outlook.office365.com/owa/calendar/.../calendar.ics",
  "refreshMs": 300000,
  "showTitle": true,
  "titleMaxChars": 34,
  "ignorePatterns": ["tiempo de concentración", "focus time"],
  "minutes": { "grey": 120, "listo": 30, "espera": 10, "permiso": 3 }
}
```

### La escalera de color

Hereda el semáforo de las consolas en lugar de inventar un idioma nuevo:

| Falta | Color | Lectura |
|---|---|---|
| > 120 min | gris | informa, no reclama |
| 120–30 min | teal apagado | está en el horizonte |
| 30–10 min | azul | ve cerrando |
| 10–3 min | ámbar | ya |
| < 3 min o en curso | **rojo sólido** | llegas tarde |

Una reunión que reclama **se lleva el peso sólido por delante de una consola
bloqueada**: el permiso te espera, la reunión no. Mientras sólo informa (gris) no
le roba el sitio a nadie.

### Qué se descarta, y por qué importa

Sin filtros esto sería insoportable. Se ignoran:

* Eventos **de todo el día** («Vacaciones Juan» te dejaría el panel encendido).
* Los marcados como **libre**, **transparentes** o **fuera de la oficina**.
* Los que encajen con `ignorePatterns`. Por defecto incluye los **bloques de
  concentración** de Outlook, que van marcados como *ocupado* y si no te
  encenderían el panel media mañana.
* Las reuniones **ya terminadas**; una en curso sí sigue contando.

Las marcadas como **privadas** en el calendario nunca muestran su título, aunque
`showTitle` esté activo.

> 💡 **Piensa dónde está el panel.** Si lo tienes bajo el monitor y usas
> webcam, los títulos pueden acabar en cámara durante una videollamada o a la
> vista de quien pase por detrás. Con `"showTitle": false` avisa igual de bien
> —hora y cuenta atrás— sin enseñar nombres de cliente o de proyecto.

### Detalles de implementación

El parseo usa [`ical.js`](https://github.com/kewisch/ical.js) (el de Mozilla, el
que lleva Thunderbird; cero dependencias) y no un parser propio, por dos motivos
que se ven en cualquier ICS de Outlook:

* Las horas llevan `TZID` con **nombres de zona de Windows** (`Romance Standard
  Time`) y el fichero adjunta sus bloques `VTIMEZONE` con las reglas de horario
  de verano. Resolver eso a mano es de donde salen los errores de una hora.
* Las reuniones recurrentes vienen como `RRULE` y hay que **expandirlas**: el
  *daily* de la mañana es justo una de ellas.

Un fallo aquí no se ve como un fallo, se ve como una hora equivocada. El ICS se
cachea en `~/.aimonitor/calendar.ics` (también con permisos `600`) y se
revalida con `ETag`, así que un corte de red no deja el panel sin avisos.

---

## El mensaje de cada casilla

El detalle —la orden en curso, el prompt, o el último mensaje del asistente— se
reparte en varias líneas en lugar de cortarse a media frase. Las líneas crecen
**hacia arriba**, hacia el aire que dejaba el nombre del proyecto, así que el
contador de tiempo no se mueve de sitio.

```json
"tile": { "detailLines": 3 }
```

Con `1` se vuelve al comportamiento de una sola línea.

> 💡 **Hay dos recortes, y conviene no confundirlos.** El hook guarda hasta 240
> caracteres (recorte de *almacenamiento*); el render decide cuántos caben de
> verdad según el ancho real de la casilla (recorte de *presentación*). Si el
> hook cortara al tamaño de una línea, como hacía antes con 80 caracteres, el
> mensaje llegaría ya mutilado y subir `detailLines` no recuperaría nada.

---

## El guiño de cada cuarto de hora

Cada quince minutos el panel deja el cuadro de mando durante unos veinte
segundos y pone una carrera de plataformas de 8 bits.

No sale siempre igual. Cada pasada se siembra con la franja horaria, y el
reparto de finales hace que unas veces el corredor se caiga por un hueco, otras
se lo lleve un bicho por delante, y **cuatro de cada catorce** llegue al
castillo. Una animación idéntica cada cuarto de hora deja de mirarse a la
tercera vez; una que a veces sale bien, no.

```json
"easterEgg": {
  "enabled": true,
  "everyMs": 900000,
  "fps": 12,
  "source": "",
  "maxSeconds": 30,
  "skipWhenBusy": true
}
```

Para quitarlo, `"enabled": false`.

### Cuándo no sale

Con `skipWhenBusy` (por defecto), el guiño se salta la franja si hay una sesión
en **permiso** o **espera**, o si hay una reunión lo bastante cerca como para
estar ya coloreada. Tapar con un dibujo justo lo que estabas esperando ver es
la forma más rápida de que alguien acabe poniendo `enabled: false`.

La cuenta va contra el reloj de pared, no contra «han pasado quince minutos
desde el último»: con el valor por defecto salta en punto, y cuarto, y media, y
menos cuarto, en vez de ir derivando según cuándo se arrancara el daemon.

### Por qué está dibujada y no es un vídeo

El bus del panel comprime cada frame antes de mandarlo, así que **el contenido
decide los fps**. Medido en este hardware, a 1920x462:

| Contenido | Bytes por frame | Techo real |
|---|---|---|
| Arte plano de 8 bits | ~83 KB | ~12 fps |
| Imagen fotográfica | ~517 KB | ~5 fps |

El cuello de botella es el USB, no el keepalive ni el rasterizado: parando el
`trcc serve` sale el mismo número. Un clip grabado se arrastra; los colores
planos van finos.

Y hay un segundo motivo: el panel es un rectángulo de 4,2:1. Eso es una ventana
pésima para un vídeo —sale una postal diminuta entre dos franjas negras— y en
cambio es la forma exacta de un nivel de scroll lateral.

Los frames **no se cachean**. Dibujar uno cuesta unos 26 ms y mandarlo unos 80,
así que rasterizar el siguiente mientras viaja el actual sale gratis; cachear
costaría decenas de MB por variante y mataría justo lo que le da la gracia, que
es que cada pasada sea distinta.

### Poner tus propios clips

`source` acepta la ruta de un vídeo o GIF **de tu disco**, o la de un
**directorio** de clips del que se elige uno distinto en cada pasada:

```json
"easterEgg": { "source": "/home/tu-usuario/videos/partidas", "fps": 8 }
```

Se reconocen `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v` y `.gif`. La
elección es determinista por franja horaria pero está revuelta: `franja % n`
recorrería siempre el mismo ciclo corto y acabarías viendo el mismo clip a la
misma hora todos los días.

Un directorio vacío **no es un error**: vuelve a la animación integrada, así que
puedes dejarlo configurado mientras vas grabando clips.

#### Cómo grabar los clips

**La proporción importa mucho más que el códec.** El panel es un 4,16:1 y una
captura de NES es 4:3: encajada de alto ocupa 512 de 1920 px, o sea **el 27 %
del ancho**, y el resto es negro.

| Recorte del original | Escala entera | Ancho en el panel | Se ve |
|---|---|---|---|
| ninguno (256×240) | ×1 | 256 px (13 %) | no cabe ni al doble |
| overscan (256×224) | ×2 | 512 px (27 %) | el fotograma entero |
| franja (256×115) | ×4 | 1024 px (53 %) | sin marcador ni cielo alto |
| franja (256×77) | ×6 | 1536 px (80 %) | sólo la banda del suelo |

El recorte se configura con `crop`, en formato `ancho:alto:x:y` de ffmpeg:

```json
"easterEgg": {
  "source": "/home/tu-usuario/videos/partidas",
  "crop": "256:115:0:110",
  "fps": 12
}
```

**Resolución.** Graba a la resolución nativa del emulador (256×240 en NES) o a
un múltiplo entero de ella. No dejes que el emulador aplique sus propios filtros
de suavizado: escalar allí y volver a escalar aquí pierde nitidez dos veces. Si
puedes recortar el overscan a 256×224, mejor: entra exactamente al doble en los
462 px de alto del panel.

**Códec.** Lo que más daño hace al pixel art es el submuestreo de croma: con
`yuv420p` la resolución de color se parte por la mitad y los bordes de un
píxel se tiñen. Con un original de 256 px de ancho se nota. Por orden:

```bash
# Mejor: sin pérdida, y ffmpeg lo lee de forma nativa
ffmpeg ... -c:v ffv1 -level 3 -an partida.mkv

# Bien: H.264 sin pérdida
ffmpeg ... -c:v libx264 -qp 0 -an partida.mkv

# Aceptable: H.264 con croma completo
ffmpeg ... -c:v libx264 -crf 12 -pix_fmt yuv444p -an partida.mp4
```

No hace falta audio (`-an`): el panel no tiene altavoz.

**Contenedor.** Se reconocen `.mkv`, `.mp4`, `.webm`, `.mov`, `.avi`, `.m4v` y
`.gif`. `.mkv` es el más cómodo porque admite FFV1 sin líos.

**Fotogramas por segundo.** Ésta es la parte delicada, y no por el número sino
por la **cadencia**.

El panel no pasa de unos 8 fps con pixel art detallado (los fondos con textura
llegan al bus a ~450 KB por frame). Así que casi siempre hay que descartar. La
regla es que `fps / speed` **divida de forma exacta** a la tasa del clip: si no,
ffmpeg reparte los descartes de forma desigual —de 12 a 8 tira uno de cada
tres, y el hueco entre frames alterna 1/12 y 2/12 de segundo— y **eso se ve como
tirones mucho más que un framerate bajo pero regular**. El daemon avisa por el
log cuando la división no es exacta.

`speed` decide qué se hace con el exceso de frames:

| `fps` | `speed` | Despiece | Con un clip de 12 fps | Resultado |
|---|---|---|---|---|
| 8 | 1 | 8 fps | ✗ irregular | tirones |
| 6 | 1 | 6 fps | ✓ 1 de cada 2 | tiempo real, saltos grandes |
| 6 | 0,5 | 12 fps | ✓ todos | media velocidad, lo más suave |

A `speed: 0,5` no se descarta ni un frame: se enseñan todos, a mitad de ritmo.
El movimiento entre fotogramas consecutivos se reduce a la mitad, que es
exactamente lo que quita los tirones en el desplazamiento lateral —donde más se
notan, porque se mueve la pantalla entera.

`maxSeconds` cuenta **lo que dura en el panel**, no lo que dura el clip: a media
velocidad, medio clip llena el mismo rato.

Si vas a volver a grabar, lo ideal es capturar a la **tasa nativa de la lógica
del juego** (sin muestrear) y compensar con `speed`. Con mariohtml5, que corre a
24 ticks/s, eso son 24 fps y `fps: 8, speed: 0,333`: se enseñan los 24 frames de
cada segundo de juego a un tercio de velocidad, el doble de suave que lo
anterior. A cambio necesitas clips más cortos: 10 s de partida llenan 30 s de
panel.

**Duración.** `maxSeconds` corta a 30 s por defecto. Una partida completa del
1-1 son unos 100 segundos, así que decide: o grabas trozos cortos, o subes
`maxSeconds` y asumes que el panel se va a pasar minuto y medio sin cuadro de
mando cada cuarto de hora.

Los clips se despiezan con `ffmpeg` a la resolución del panel y se cachean en
`~/.aimonitor/easteregg/`. Cada uno son **decenas de MB** en PNGs, así que sólo
se guardan los `cacheClips` últimos (3 por defecto); el resto se vuelve a
despiezar cuando toque. El despiece ocurre **antes** de soltar el keepalive, así
que el cuadro de mando sigue en pantalla mientras `ffmpeg` trabaja.

El clip se encaja entero y se centra sobre negro; no se recorta, porque con esta
proporción recortar para llenar el ancho se comería casi todo el encuadre. Se
despiezan como mucho `maxSeconds` segundos. Hace falta `ffmpeg` en el `PATH`
(`sudo apt install ffmpeg`); si falta, el daemon lo dice y sigue pintando el
cuadro de mando.

Baja los `fps` si el clip es de imagen real: pedir más de lo que da el bus sólo
hace que se tiren frames.

Esta opción existe por una razón concreta. La pregunta natural es «¿y no puede
salir el Mario de verdad?», y la respuesta es que los sprites de Super Mario
Bros son de Nintendo: que haya repositorios en GitHub que los alojan no los
licencia. Este proyecto se publica en npm, así que meterlos aquí sería
redistribuirlos. Los ficheros de tu propia máquina son otra cosa, y para eso
está `source`.

El dibujo que viene de serie (`src/platformer.ts`) es original, en la paleta del
propio panel.

### Probarlo sin esperar al cuarto de hora

```bash
systemctl --user stop aimonitor.service
aimonitor-daemon --guino
systemctl --user start aimonitor.service
```

Reproduce una pasada y sale. **Hay que parar el servicio antes**: el keepalive
del daemon en marcha posee el USB y se pelearía con los frames de la animación,
que es justamente el motivo por el que existe `src/panel.ts`.

Sirve para dar el visto bueno a unos clips nuevos, o para ver el efecto de
cambiar `speed` sin tener que esperar.

### Mezclar clips de distinta cadencia

Cuidado al ir añadiendo grabaciones: `fps / speed` tiene que dividir de forma
exacta a **cada** clip del directorio. Con `fps: 8, speed: 0.667` el despiece va
a 12, que divide a los clips de 12 fps (1:1) y a los de 24 (2:1), así que
conviven. Pero si bajas a `speed: 0.333` el despiece sube a 24, y ahí un clip de
12 fps obligaría a duplicar frames y volverían los tirones.

El daemon avisa por el log cuando pasa. Si tienes clips de cadencias distintas y
no quieres perderlos, mételos en un subdirectorio: el listado **no es
recursivo**, así que quedan fuera del sorteo sin borrarlos.

### Editar el nivel

El nivel es un mapa de caracteres en `src/platformer.ts`, siete filas de tiles
de 66 px:

```
  `#` suelo    `B` ladrillo   `?` bloque sorpresa
  `P` esquina superior izquierda de una tubería
  `e` bicho    `F` mástil     `C` castillo
```

Hay tres reglas que la física impone y que `src/platformer.test.ts` comprueba:

1. **Los huecos no pasan de 3 tiles.** El salto alcanza 3,75 y el corredor
   despega desde el borde.
2. **Las tuberías son de un tile de alto.** El vuelo pasa por encima de 132 px
   de altura durante 1,87 tiles, menos de los 2 que mide una tubería de ancho:
   una de dos tiles de alto no se puede cruzar por arriba.
3. **Los ladrillos van donde el corredor nunca vuela.** No hay colisiones con
   bloques, así que uno dentro de un arco de salto se atravesaría. Los tramos
   seguros del nivel actual son las columnas 3-10 y 21-29.

El alcance del salto no se calcula con la fórmula `2·v/g`, sino **integrando el
mismo salto que hace la simulación**. A 12 fps la integración es tan gruesa que
la fórmula se equivoca en casi un frame entero, y con ella el corredor
aterrizaba un píxel corto de la cabeza del bicho y se lo comía al frame
siguiente.

## Consolas fantasma

Si el panel enseña más consolas de las que tienes abiertas, son registros
huérfanos. El hook borra el suyo al recibir `SessionEnd`, pero ese evento **no
llega** si matas el terminal, la máquina suspende o Claude Code se cae.

Dos plazos hacen de red, porque las señales son distintas:

| Ajuste | Por defecto | A quién afecta |
|---|---|---|
| `zombieMs` | 15 min | Sólo las sesiones **activas**: dicen estar trabajando, así que si callan tanto rato están muertas. |
| `staleMs` | 2 h | **Todas**. Las que esperan al operador merecen manga ancha —para eso está el panel—, pero no la eternidad. |

Al caer, su fichero se borra de `~/.aimonitor/sessions/`. Es seguro: si la
sesión resucita, el siguiente evento del hook lo vuelve a crear. Ignorarlas sin
borrarlas no bastaba, porque se acumulan y cada frame paga un `git status` por
cada cadáver.

Si sueles dejar consolas esperando permiso muchas horas, sube `staleMs`.

## Diagnóstico de problemas

### El panel sólo muestra el logo

Recorre estas cuatro causas **en orden**; cada una da un síntoma distinto.

#### a) El logo fijo, nada más

Falta la regla udev, o no has hecho el replug. Compruébalo:

```bash
ls -la /etc/udev/rules.d/99-trcc.rules
trcc detect
```

Un `PermissionError` o un nodo sin `rw` confirman el diagnóstico → [sección 2](#2-permisos-usb-reglas-udev).

#### b) El dashboard parpadea y vuelve al logo cada 1-2 segundos

**Éste es el síntoma clásico del firmware LY.** No hay nada sobrescribiéndote:
el panel está descartando la imagen por falta de frames. Necesitas el keepalive
→ [sección 3](#3-la-parte-que-no-es-obvia-por-que-hacen-falta-dos-servicios).

```bash
systemctl --user is-active trcc-serve.service    # debe decir: active
```

#### c) La imagen se queda congelada (el reloj no avanza)

El keepalive está clavando un frame antiguo, pero **nadie está renderizando**.
El daemon está parado o no consigue mandar:

```bash
systemctl --user is-active aimonitor.service
journalctl --user -u aimonitor.service -n 20
```

#### d) `interface is in use by another process`

Hay más de un proceso peleándose por el USB. Averigua **quién** lo tiene abierto
de verdad, en lugar de matar a ciegas:

```bash
NODE=$(for d in /sys/bus/usb/devices/*/; do
  [ "$(cat $d/idVendor 2>/dev/null)" = "0416" ] && \
  printf "/dev/bus/usb/%03d/%03d" $(cat $d/busnum) $(cat $d/devnum); done)

for p in $(ls /proc | grep -E '^[0-9]+$'); do
  for fd in /proc/$p/fd/*; do
    [ "$(readlink "$fd" 2>/dev/null)" = "$NODE" ] && \
      echo "pid=$p $(tr '\0' ' ' < /proc/$p/cmdline | cut -c1-90)"
  done
done 2>/dev/null
```

Lo normal es que el único dueño legítimo sea `trcc serve`. Si además hay
instancias sueltas (un `trcc display ...` que se quedó colgado, o una GUI
abierta), ciérralas y reinicia:

```bash
systemctl --user restart trcc-serve.service
systemctl --user restart aimonitor.service
```

> ⚠️ Ojo con `pkill -f trcc`: el patrón **también encaja con la propia línea de
> comandos que lo ejecuta**, así que se mata a sí mismo (y a tu shell). Filtra
> por la ruta del venv de pipx o mata por PID.

### El dashboard se ve, pero el carril de consumo está vacío

`ccusage` no está en el `PATH` que ve el servicio → [aviso del `PATH` en la sección 4](#4-los-dos-servicios-de-systemd).

```bash
systemctl --user show-environment | grep PATH
which ccusage
```

### Los rótulos salen como cuadraditos vacíos

Faltan glifos: DejaVu **no trae emoji**. Los rótulos de estado son texto plano a
propósito; el color y el peso ya comunican el estado. Si has personalizado
`STATE_LABEL`, quítale los emoji.

### El panel no aparece en `lsusb`

```bash
lsusb | grep 0416
```

Sin salida, el problema es físico: cable de **datos** (no sólo alimentación),
puerto, o alimentación insuficiente. Ningún ajuste de software lo arregla.

---

## Trampas conocidas de la API de `trcc`

Documentadas aquí porque cuestan un rato largo de depurar:

| Trampa | Detalle |
|---|---|
| `POST /connect` **no es idempotente** | Llamarlo cuando el dispositivo ya está abierto devuelve `400 interface is in use` **y además deja inservible la conexión anterior**. Conéctate en diferido: sólo cuando un envío falle. |
| `send-image` puede "tener éxito" sin pintar | Devuelve `ok: true` con el mensaje `"saved (device not connected)"`. Es un éxito que no ha pintado nada: hay que mirar el mensaje, no sólo el estado. |
| `keepalive` necesita un frame previo | Responde `400 No cached frame for keepalive` si arrancas el bucle antes de haber enviado nada. Manda un frame primero. |
| El número de dispositivo cambia al replug | `/dev/bus/usb/003/004` → `.../007`. Un `USB device not found` justo después de un replug suele ser esto. |
| `send-image` es efímero | *"no theme staging, no persistence"*. `load-image` sí persiste el tema, pero **ninguno de los dos evita** que el firmware descarte la imagen: eso sólo lo arregla el keepalive. |
| Un `keepalive` sin fin sobrevive al cliente | Pedirlo con `count: 0` deja un bucle en el servidor que **no muere aunque muera quien lo pidió**. A partir de ahí el servidor sólo atiende POST y ningún GET, así que el siguiente daemon no puede ni detectar el panel y se queda esperando indefinidamente. Por eso `aimonitor` lo pide en **ráfagas acotadas** (`burstS`) que se renuevan: un huérfano caduca solo. |

---

## Desarrollo sin hardware

Todo el diseño se puede iterar sin panel conectado:

```bash
npm run preview                     # un escenario a PNG
npm run preview -- --all --out preview
npm run gallery                     # galería HTML de todos los escenarios
npm run simulate                    # sesiones falsas para ver el layout vivo

aimonitor-daemon --preview salida.png   # el frame real, a fichero
```

`--preview` no toca el hardware: si `trcc` no responde, cae a la resolución de
`config.json` y sigue funcionando.
