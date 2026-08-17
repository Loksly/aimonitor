/**
 * Genera las páginas HTML de GitHub Pages a partir de los Markdown de `docs/`.
 *
 * El Markdown es la fuente de verdad: se lee en el repositorio y se publica en
 * Pages, así que no hay dos copias del mismo texto que se puedan desincronizar.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { marked } from 'marked';
import { PALETTE, STATE_COLOR } from './config.ts';

const DOCS_DIR = 'docs';
const OUT_DIR = 'preview';

export interface Page {
  /** Nombre de fichero de salida, p. ej. `instalacion.html`. */
  file: string;
  /** Título que aparece en la navegación. */
  title: string;
}

/** Primer `# encabezado` del documento; si no hay, el nombre del fichero. */
function extractTitle(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim() : fallback;
}

/**
 * Ancla a partir del texto de un encabezado.
 *
 * `marked` dejó de generar `id` en los encabezados, así que los enlaces
 * internos (`[…](#…)`) apuntarían a la nada. Se quitan los acentos para que
 * "por qué" y "sólo" produzcan anclas ASCII estables.
 */
export function slug(text: string): string {
  return text
    .replace(/<[^>]*>/g, '') // el texto puede traer <code>, <em>…
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

marked.use({
  renderer: {
    heading(token: any) {
      const text = this.parser.parseInline(token.tokens);
      return `<h${token.depth} id="${slug(text)}">${text}</h${token.depth}>\n`;
    },
  },
});

/**
 * Estilos compartidos. Se reusa la misma paleta que pinta el panel para que la
 * documentación y el dispositivo se vean como la misma cosa.
 */
function styles(): string {
  return `
    :root {
      --bg: ${PALETTE.BG};
      --surface: ${PALETTE.TILE_OFF};
      --edge: ${PALETTE.TILE_EDGE};
      --ink: ${PALETTE.INK_BRIGHT};
      --ink-dim: ${PALETTE.INK_DIM};
      --accent: ${STATE_COLOR.listo};
      --warn: ${STATE_COLOR.espera};
      --alert: ${STATE_COLOR.permiso};
    }
    * { box-sizing: border-box; }
    body {
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      line-height: 1.65;
      margin: 0;
      padding: 0 20px 80px;
    }
    .wrap { max-width: 860px; margin: 0 auto; }
    nav {
      border-bottom: 1px solid var(--edge);
      margin-bottom: 40px;
      padding: 20px 0;
      display: flex;
      gap: 22px;
      align-items: baseline;
      flex-wrap: wrap;
    }
    nav .brand { font-weight: 700; color: #fff; letter-spacing: .02em; }
    nav a { color: var(--ink-dim); text-decoration: none; font-size: .95rem; }
    nav a:hover, nav a.active { color: var(--accent); }
    h1 { color: #fff; font-size: 2.1rem; line-height: 1.2; margin: .2em 0 .6em; }
    h2 {
      color: #fff;
      margin-top: 2.2em;
      padding-bottom: .3em;
      border-bottom: 1px solid var(--edge);
    }
    h3 { color: var(--accent); margin-top: 1.8em; }
    h4 { color: var(--ink); margin-top: 1.5em; }
    a { color: var(--accent); }
    code {
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: 4px;
      padding: .12em .4em;
      font-size: .88em;
      font-family: ui-monospace, "DejaVu Sans Mono", SFMono-Regular, Menlo, monospace;
    }
    pre {
      background: var(--surface);
      border: 1px solid var(--edge);
      border-radius: 8px;
      padding: 16px 18px;
      overflow-x: auto;
    }
    pre code { background: none; border: 0; padding: 0; font-size: .85rem; }
    blockquote {
      margin: 1.4em 0;
      padding: .1em 1.1em;
      border-left: 3px solid var(--warn);
      background: rgba(255, 176, 32, .06);
      color: var(--ink);
      border-radius: 0 6px 6px 0;
    }
    blockquote p { margin: .8em 0; }
    table { border-collapse: collapse; width: 100%; margin: 1.4em 0; display: block; overflow-x: auto; }
    th, td { border: 1px solid var(--edge); padding: 9px 12px; text-align: left; }
    th { background: var(--surface); color: #fff; }
    hr { border: 0; border-top: 1px solid var(--edge); margin: 2.5em 0; }
    img { max-width: 100%; height: auto; }
    .console-note { color: var(--ink-dim); font-size: .9rem; }
    footer {
      margin-top: 60px;
      padding-top: 20px;
      border-top: 1px solid var(--edge);
      color: var(--ink-dim);
      font-size: .88rem;
    }
  `;
}

/** Barra de navegación común, marcando la página actual. */
export function nav(pages: Page[], current: string): string {
  const links = [{ file: 'index.html', title: 'Galería' }, ...pages]
    .map(
      (p) =>
        `<a href="${p.file}"${p.file === current ? ' class="active"' : ''}>${p.title}</a>`,
    )
    .join('\n      ');
  return `<nav>
      <span class="brand">aimonitor</span>
      ${links}
      <a href="https://github.com/Loksly/aimonitor">GitHub ↗</a>
    </nav>`;
}

export function shell(title: string, navHtml: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} · aimonitor</title>
  <style>${styles()}</style>
</head>
<body>
  <div class="wrap">
    ${navHtml}
    ${body}
    <footer>
      aimonitor · panel Thermalright Trofeo Vision 9.16" (1920×462) ·
      <a href="https://github.com/Loksly/aimonitor">código y issues</a>
    </footer>
  </div>
</body>
</html>
`;
}

/** Lista los documentos disponibles, para que la navegación no se codifique a mano. */
export function listPages(): Page[] {
  if (!existsSync(DOCS_DIR)) return [];
  return readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const md = readFileSync(join(DOCS_DIR, f), 'utf8');
      const name = basename(f, '.md');
      return { file: `${name}.html`, title: extractTitle(md, name) };
    });
}

function main(): void {
  const pages = listPages();
  if (pages.length === 0) {
    console.log('No hay documentos en docs/; nada que generar.');
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });

  for (const page of pages) {
    const source = join(DOCS_DIR, page.file.replace(/\.html$/, '.md'));
    const html = marked.parse(readFileSync(source, 'utf8'), { async: false }) as string;
    const out = join(OUT_DIR, page.file);
    writeFileSync(out, shell(page.title, nav(pages, page.file), html), 'utf8');
    console.log(`${out}  ←  ${source}`);
  }
}

// Sólo al ejecutarse como script; `gallery.ts` importa este módulo por la
// navegación y no debe disparar la generación.
if (process.argv[1] && /docs\.[tj]s$/.test(process.argv[1])) main();
