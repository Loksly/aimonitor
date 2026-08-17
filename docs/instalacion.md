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

* Un frame son **~145 KB** (PNG comprimido), no 1,7 MB.
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
