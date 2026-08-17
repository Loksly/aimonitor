import { writeFileSync } from 'node:fs';
import { SCENARIOS } from './fixtures.ts';
import { listPages, nav, shell } from './docs.ts';

function main() {
  const names = Object.keys(SCENARIOS);
  const pages = listPages();

  const body = `
    <h1>Galería de escenarios</h1>
    <p class="console-note">
      Cómo se ve cada estado en el panel Thermalright Trofeo Vision (1920×462).
      Renderizado sin hardware, con los mismos fixtures que usan los tests.
    </p>
    ${
      pages.length
        ? `<p>¿Montándolo por primera vez? Empieza por la
             <a href="${pages[0]!.file}">${pages[0]!.title.toLowerCase()}</a>.</p>`
        : ''
    }
    <div class="grid">
    ${names
      .map(
        (name) => `
      <div class="card">
        <div class="card-title">${name.replace(/-/g, ' ')}</div>
        <div class="img-container">
          <img src="${name}.png" alt="Escenario ${name}" loading="lazy" />
        </div>
      </div>`,
      )
      .join('')}
    </div>
    <style>
      .grid { display: flex; flex-direction: column; gap: 26px; margin-top: 32px; }
      .card {
        background: var(--surface);
        border: 1px solid var(--edge);
        border-radius: 8px;
        padding: 18px;
      }
      .card-title {
        font-size: 1.1rem;
        font-weight: 600;
        text-transform: capitalize;
        color: var(--accent);
        border-bottom: 1px solid var(--edge);
        padding-bottom: 10px;
        margin-bottom: 14px;
      }
      .img-container { background: #000; border-radius: 4px; padding: 10px 0; display: flex; justify-content: center; }
    </style>`;

  writeFileSync('preview/index.html', shell('Galería', nav(pages, 'index.html'), body), 'utf8');
  console.log('preview/index.html generada.');
}

main();
