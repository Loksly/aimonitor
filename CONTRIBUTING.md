# Guía de Contribución a aimonitor 🤝✨

¡Nos encanta que quieras contribuir a **aimonitor**! Este proyecto es de código abierto y agradecemos mucho la ayuda de la comunidad para ampliar sus integraciones, refinar su diseño visual o expandir el soporte de hardware.

A continuación, te detallamos cómo configurar tu entorno y proponer cambios.

---

## 🛠️ Configuración de Desarrollo Local

### Requisitos Previos
*   **Node.js** >= 24.0.0
*   **npm** o similar
*   **Fuentes DejaVu** (`fonts-dejavu-core` en sistemas basados en Debian/Ubuntu).

### Pasos para Clonar y Compilar
1.  Clona el repositorio:
    ```bash
    git clone git@github.com:Loksly/aimonitor.git
    cd aimonitor
    ```
2.  Instala las dependencias:
    ```bash
    npm install
    ```
3.  Compila el código de TypeScript a JavaScript:
    ```bash
    npm run build
    ```
4.  Realiza el chequeo de tipos estático (sin compilar):
    ```bash
    npm run check
    ```

---

## 🧪 Pruebas Unitarias y Cobertura

Mantenemos un nivel de cobertura muy alto en las utilidades de negocio utilizando el **corredor de pruebas nativo de Node.js** (sin dependencias adicionales).

*   **Ejecutar los tests con cálculo de cobertura:**
    ```bash
    npm test
    ```

Cualquier funcionalidad nueva o corrección de bugs debería venir acompañada de su correspondiente test unitario en la carpeta `src/`.

---

## 🎛️ Simular y Validar Visualmente

### 1. Generar Previews de Escenarios
Si realizas un cambio en el motor gráfico de Canvas (`src/render.ts`), puedes renderizar todos los escenarios simulados a imágenes PNG estáticas para ver el resultado de inmediato sin necesidad de tener el hardware físico conectado:

```bash
npm run preview -- --all --out preview
```

### 2. Generar Galería Interactiva
Para inspeccionar todas las imágenes renderizadas de forma unificada y con una estética limpia, genera la galería web local:

```bash
npm run gallery
# Abre 'preview/index.html' en tu navegador favorito
```

### 3. Simulador en Tiempo Real (TUI)
Para validar el comportamiento dinámico del daemon y el hook en caliente:
1.  Arranca el daemon en modo preview para vigilar la carpeta local:
    ```bash
    node dist/src/daemon.ts --preview preview/en-vivo.png
    ```
2.  En otra terminal, lanza nuestro simulador de consola interactiva:
    ```bash
    npm run simulate
    ```
3.  Interactúa con el menú para enviar eventos y observa cómo se actualizan instantáneamente las casillas.

---

## 📬 Enviar un Pull Request (PR)

1.  Crea una rama descriptiva para tu cambio: `git checkout -b feat/mi-nueva-funcionalidad`.
2.  Implementa tu cambio y añade pruebas si es necesario.
3.  Asegúrate de que `npm run check` y `npm test` pasan al 100% de manera exitosa.
4.  Haz commit e incluye un mensaje semántico claro (ej. `feat: añade soporte para degradados Gemini`).
5.  Sube la rama a tu fork y abre un Pull Request en GitHub usando nuestra plantilla de PR predefinida.

¡Muchas gracias por hacer de **aimonitor** una herramienta increíble!
