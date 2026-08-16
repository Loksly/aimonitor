import { writeFileSync } from 'node:fs';
import { SCENARIOS } from './fixtures.ts';

function main() {
  const names = Object.keys(SCENARIOS);
  
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Galería de Previews - aimonitor</title>
  <style>
    body {
      background-color: #090c10;
      color: #d3dfea;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      margin: 0;
      padding: 40px 20px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    h1 {
      font-weight: 700;
      color: #ffffff;
      margin-bottom: 8px;
    }
    p {
      color: #627180;
      margin-bottom: 40px;
      font-size: 1.1rem;
    }
    .grid {
      display: flex;
      flex-direction: column;
      gap: 30px;
      max-width: 1200px;
      width: 100%;
    }
    .card {
      background-color: #131920;
      border: 1px solid #202a35;
      border-radius: 8px;
      overflow: hidden;
      padding: 20px;
    }
    .card-title {
      font-size: 1.25rem;
      font-weight: 600;
      margin-bottom: 15px;
      text-transform: capitalize;
      border-bottom: 1px solid #202a35;
      padding-bottom: 10px;
      color: #4da3ff;
    }
    .img-container {
      width: 100%;
      background: #000;
      display: flex;
      justify-content: center;
      padding: 10px 0;
      border-radius: 4px;
    }
    img {
      max-width: 100%;
      height: auto;
      display: block;
    }
  </style>
</head>
<body>
  <h1>aimonitor</h1>
  <p>Galería de estados y escenarios simulados para la pantalla Thermalright Trofeo Vision (1920x462)</p>
  
  <div class="grid">
    ${names.map(name => `
    <div class="card">
      <div class="card-title">Escenario: ${name.replace('-', ' ')}</div>
      <div class="img-container">
        <img src="${name}.png" alt="Escenario ${name}" />
      </div>
    </div>
    `).join('')}
  </div>
</body>
</html>
`;

  writeFileSync('preview/index.html', html, 'utf8');
  console.log('Galería HTML preview/index.html generada con éxito.');
}

main();
