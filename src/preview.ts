#!/usr/bin/env node
/**
 * Modo preview: renderiza a fichero sin hardware, para iterar el diseño.
 * Usa exactamente el mismo `renderFrame` que usará el daemon, así que lo que
 * se ve aquí es lo que se enviará al panel.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig, type Config } from './config.ts';
import { SCENARIOS, T0, USAGE_API, USAGE_MAX } from './fixtures.ts';
import { renderFrame } from './render.ts';
import type { UsageSnapshot } from './types.ts';

interface Args {
  scenario: string | null;
  all: boolean;
  out: string | null;
  size: { w: number; h: number } | null;
  rail: boolean | null;
  shift: number | null;
  usage: 'max' | 'api' | 'none';
  now: number;
  list: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    scenario: null,
    all: false,
    out: null,
    size: null,
    rail: null,
    shift: null,
    usage: 'max',
    now: T0,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => argv[++i] ?? '';
    switch (arg) {
      case '--all': a.all = true; break;
      case '--list': a.list = true; break;
      case '--scenario': a.scenario = next(); break;
      case '--out': a.out = next(); break;
      case '--no-rail': a.rail = false; break;
      case '--rail': a.rail = true; break;
      case '--usage': a.usage = next() as Args['usage']; break;
      case '--shift': a.shift = Number(next()); break;
      case '--now': a.now = arg === '--now' ? Date.parse(next()) : a.now; break;
      case '--size': {
        const m = /^(\d+)x(\d+)$/.exec(next());
        if (!m) throw new Error('--size espera WIDTHxHEIGHT, p.ej. 1920x462');
        a.size = { w: Number(m[1]), h: Number(m[2]) };
        break;
      }
      case '--help':
      case '-h':
        usage();
        process.exit(0);
      default:
        if (arg.startsWith('-')) throw new Error(`Opción desconocida: ${arg}`);
        a.scenario = arg;
    }
  }
  return a;
}

function usage(): void {
  console.log(`Uso: npm run preview -- [escenario] [opciones]

  --list              lista los escenarios disponibles
  --all               renderiza todos los escenarios
  --scenario NOMBRE   escenario a renderizar (por defecto: tres-reclaman)
  --out RUTA          fichero PNG (o directorio con --all)
  --size WxH          resolución de salida (por defecto ${DEFAULT_CONFIG.width}x${DEFAULT_CONFIG.height})
  --rail / --no-rail  carril de consumo
  --usage max|api|none
  --shift N           fuerza el desplazamiento de píxel a N px
  --now ISO           instante del render`);
}

function build(args: Args): Config {
  const cfg = { ...loadConfig() };
  if (args.size) {
    cfg.width = args.size.w;
    cfg.height = args.size.h;
  }
  if (args.rail !== null) cfg.rail = { ...cfg.rail, enabled: args.rail };
  return cfg;
}

function snapshot(mode: Args['usage']): UsageSnapshot | null {
  if (mode === 'none') return null;
  return mode === 'api' ? USAGE_API : USAGE_MAX;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const name of Object.keys(SCENARIOS)) console.log(name);
    return;
  }
  const config = build(args);
  const shift = args.shift === null ? undefined : { x: args.shift, y: args.shift };
  const usageData = snapshot(args.usage);

  const names = args.all ? Object.keys(SCENARIOS) : [args.scenario ?? 'tres-reclaman'];
  const outDir = args.all ? (args.out ?? 'preview') : dirname(args.out ?? 'preview/out.png');
  mkdirSync(outDir, { recursive: true });

  for (const name of names) {
    const sessions = SCENARIOS[name];
    if (!sessions) throw new Error(`Escenario desconocido: ${name}. Prueba --list.`);
    const png = renderFrame({ sessions, usage: usageData, config, now: args.now, shift });
    const file = args.all ? join(outDir, `${name}.png`) : (args.out ?? `preview/${name}.png`);
    writeFileSync(file, png);
    console.log(`${file}  ${config.width}x${config.height}  ${(png.length / 1024).toFixed(0)} KB`);
  }
}

main();
