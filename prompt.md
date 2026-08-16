# Dashboard de consolas Claude en panel LCD USB

Quiero que construyas una aplicación en Typescript que muestre el estado de mis
sesiones de Claude Code en un panel LCD externo conectado por USB, colocado
bajo mi monitor principal. Trabaja paso a paso y pregúntame cuando una
decisión dependa de hardware que aún no hemos verificado.

## Hardware

- **Panel:** Thermalright Trofeo Vision 9.16", 1920×480 nominal, IPS.
- **No es un monitor.** No aparece en `xrandr`. Es un dispositivo USB al que
  se le envían imágenes. ID USB esperado `0416:5408`, protocolo interno "LY"
  (bulk troceado).
- **Driver:** el proyecto `thermalright-trcc-linux` (port a Linux del TRCC de
  Windows por ingeniería inversa). Expone CLI (`trcc send`, `trcc detect`) y
  una API REST local. Úsalo como capa de salida — no toques USB directamente.
- **Equipo:** NUC Intel i9, 64 GB RAM, sin GPU dedicada, Linux. Ya tiene dos
  monitores conectados; este panel no consume salida gráfica.

**Antes de asumir la resolución:** ejecuta `trcc detect` y usa la que reporte
el dispositivo. El proyecto documenta un máximo de 1920×462, distinto de los
1920×480 que anuncian las tiendas. Todo el renderizado debe derivar de la
resolución detectada, no estar hardcodeado.

## Arquitectura, tres piezas

1. **Hook receptor** (`claude_lcd_hook.ts`) — lo invoca Claude Code en cada
   evento y recibe un JSON por stdin. Traduce el evento a un fichero de estado
   por sesión en `~/.claude-lcd/sessions/<session_id>.json`.
   - Debe ser rapidísimo: está en el camino crítico de cada tool call.
   - Nunca falla ruidosamente: si algo peta, salir con 0 y en silencio.
     Un hook roto no debe romper mi sesión de Claude.
   - Escritura atómica (tmp + `os.replace`) para que el daemon nunca lea a
     medias.

2. **Daemon** (`claude_lcd_daemon.ts`) — vigila el directorio de estado,
   renderiza un PNG con una librería de manipulación de imágenes en Typescript y lo envía al panel vía `trcc`.

3. **Modo preview** (`--preview salida.png`) — renderiza a fichero sin
   hardware, para iterar el diseño.

### Mapeo de eventos a estados

| Evento de hook | Estado |
|---|---|
| `SessionStart` | `inactiva` |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | `activa` |
| `Notification` (matcher `permission_prompt`, o mensaje que mencione permiso) | `permiso` |
| `Notification` (matcher `idle_prompt` u otros) | `espera` |
| `Stop`, `SubagentStop` | `listo` |
| `SessionEnd` | borrar el fichero |

Guarda en cada registro: `session_id`, `state`, `detail` (nombre de la
herramienta o mensaje, truncado), `project` (basename de `cwd`), `since`
(instante en que entró en el estado actual, para calcular "cuánto lleva así"),
`updated`, `event`.

Detecta sesiones zombi: si una sesión lleva mucho sin actualizarse en estado
`activa`, márcala como obsoleta y quítala.

Genera también el fragmento de `settings.json` con la configuración de hooks
lista para pegar.

## Diseño visual

La dirección es **panel anunciador de sala de control**: la normalidad es la
oscuridad, solo se ilumina lo que reclama al operador. Respétala.

### Tres pesos visuales, no dos

- **Sólido** — únicamente la consola más urgente. Campo de color pleno, texto
  oscuro encima. Se ve de reojo, sin enfocar.
- **Marcada** — el resto de las que me esperan. Casilla oscura con una espina
  de color de 7 px a sangre en el canto izquierdo.
- **Quieta** — trabajando o inactiva. No compite por mi atención.

Esto es lo que hace que funcione. Si las tres que reclaman se encienden a la
vez, ninguna gana.

Prioridad: `permiso` > `espera` > `listo` > `activa`/`inactiva`.
Estados que cuentan como "me reclaman": `permiso`, `espera`, `listo`.

### Paleta

```
BG          #090C10   fondo, negro con sesgo frío
TILE_OFF    #131920   casilla en reposo
TILE_EDGE   #202A35   borde
INK_BRIGHT  #D3DFEA
INK_DIM     #627180
INK_FAINT   #384450

permiso     #F5453D   rojo señal: bloquea, no avanza sin mí
espera      #FFB020   ámbar: lleva rato parada
listo       #4DA3FF   azul: turno terminado, me toca
activa      #2E8A82   teal apagado: trabajando, no molestar
```

### Tipografía

- Rótulos: DejaVu Sans Condensed Bold, versalitas, con tracking manual
  (si la librería usada para renderizar no trae letter-spacing; impleméntalo dibujando carácter a carácter).
- Datos técnicos y tiempos: DejaVu Sans Mono.

El par condensada + monoespaciada es del mundo del panel de control. No lo
cambies por un serif de display.

### Estructura de la tira

Cabecera de 60 px: `CLAUDE · N CONSOLAS · N TE ESPERAN` a la izquierda, reloj
a la derecha, regla fina debajo.

Casilla, de arriba abajo:
1. Rótulo del estado (versalitas condensadas) + id corto de sesión a la derecha
2. Regla fina
3. **Nombre del proyecto**, grande (≈48 px) — es lo que identifica la consola
4. Detalle en mono: herramienta y argumento
5. **Tiempo transcurrido, grande abajo** (≈52 px mono bold) — la pregunta real
   no es "¿está esperando?" sino "¿cuánto lleva esperando?"
6. Pie de casilla: número de ficheros pendientes de commit, en mono pequeño
   (≈16 px).

No pongas la ruta completa debajo del nombre: duplica el nombre del proyecto.

### Carril de consumo (derecha, ≈356 px, configurable)

Fuente de datos: `ccusage` con salida JSON, que lee los JSONL locales de
Claude Code. Sirve tanto con suscripción como con pago por uso — cambia qué se
muestra, no de dónde sale.

- **Modo Max:** dos barras horizontales, ventana de 5 h y semana, cada una con
  su etiqueta encima, porcentaje a la derecha, y cuándo reinicia debajo.
- **Modo API:** gasto de hoy y del mes contra topes que yo configure.
- Pie común: tokens del día y reparto por modelo.

Las barras heredan el mismo semáforo que las casillas: azul por debajo del
60%, ámbar por encima, rojo por encima del 85%. No inventes un segundo
lenguaje de color.

Barras **horizontales** bajo su propia etiqueta. Probé verticales y no se
distinguía qué barra correspondía a qué etiqueta.

Deja el carril activable por configuración: con él caben cuatro consolas, sin
él cinco.

## Comportamiento

- **Redibuja solo cuando cambia algo**, más el reloj cada minuto. Nada de
  refrescar a N fps: cada frame son ~1,7 MB por USB.
- **Desplazamiento de píxel:** mueve todo el layout 1–2 px en un ciclo lento
  de varios minutos, para evitar retención de imagen en el LCD.
- **Apagado en reposo:** sin sesiones activas, negro o brillo al mínimo. Es
  por el backlight, que es lo que de verdad se gasta con las horas.
- **Número variable de consolas:** define un ancho mínimo y máximo de casilla.
  Con una sola sesión no debe estirarse a 1920; con muchas, muestra las más
  urgentes y resume el resto.

## Entregables

1. `claude_lcd_hook.ts`
2. `claude_lcd_daemon.ts` con `--preview`
3. Fragmento de `settings.json`
4. Unidad systemd de usuario para el daemon
5. `README.md` con instalación, incluyendo las reglas udev necesarias y el
   aviso de que hay que desenchufar y reconectar el USB tras instalarlas

## Verificación previa

Antes de escribir código, comprueba conmigo:
1. `lsusb` → que el ID sea `0416:5408`
2. `trcc detect` → resolución real reportada
3. Que `ccusage` esté instalado y su salida JSON tenga los campos que necesitas