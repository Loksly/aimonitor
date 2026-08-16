#!/usr/bin/env node
/**
 * Daemon principal para aimonitor.
 * Vigila el directorio ~/.aimonitor/sessions/, actualiza estados de git,
 * consulta periódicamente el consumo con ccusage y renderiza frames hacia trcc.
 */
import { watch, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { exec, execSync } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { loadConfig, SESSIONS_DIR, type Config } from './config.ts';
import { fetchUsage } from './usage.ts';
import { renderFrame } from './render.ts';
import type { SessionRecord, UsageSnapshot } from './types.ts';

const execAsync = promisify(exec);

// Variables de estado
let config = loadConfig();
let currentUsage: UsageSnapshot | null = null;
let lastUsageFetch = 0;
let isRendering = false;
let pendingRender = false;

// Comprobar argumentos CLI
const args = process.argv.slice(2);
const previewIndex = args.indexOf('--preview');
const previewPath = previewIndex !== -1 ? args[previewIndex + 1] : null;

/** Ejecuta git status --porcelain en el cwd de la sesión para rellenar la propiedad dirty */
async function getGitDirtyCount(cwd: string): Promise<number | undefined> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 2000 });
    const lines = stdout.trim().split('\n').filter(line => line.trim().length > 0);
    return lines.length;
  } catch {
    return undefined; // No es un repositorio de git o ha fallado
  }
}

/** Lee todas las sesiones activas en ~/.claude-lcd/sessions/ */
async function loadSessions(): Promise<SessionRecord[]> {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    return [];
  }

  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  const list: SessionRecord[] = [];

  for (const file of files) {
    const filepath = join(SESSIONS_DIR, file);
    try {
      const content = readFileSync(filepath, 'utf8');
      const rec = JSON.parse(content) as SessionRecord;
      
      // Intentar actualizar el contador de git de forma asíncrona pero sin bloquear la carga inicial
      if (rec.cwd && existsSync(rec.cwd)) {
        rec.dirty = await getGitDirtyCount(rec.cwd);
      }
      list.push(rec);
    } catch {
      // Ignorar archivos corruptos o ilegibles
    }
  }

  return list;
}

/** Renderiza y envía el frame */
async function renderAndSend() {
  if (isRendering) {
    pendingRender = true;
    return;
  }
  isRendering = true;

  try {
    // Recargar config por si ha cambiado config.json
    config = loadConfig();

    // Consultar consumo si ha expirado el refresco
    const now = Date.now();
    if (!currentUsage || now - lastUsageFetch > config.usage.refreshMs) {
      currentUsage = await fetchUsage(config);
      lastUsageFetch = now;
    }

    // Leer sesiones actuales y resolver git
    const sessions = await loadSessions();

    // Renderizar frame
    const pngBuffer = renderFrame({
      sessions,
      usage: currentUsage,
      config,
      now,
    });

    if (previewPath) {
      // Si estamos en modo de un solo preview, escribir el archivo y salir
      writeFileSync(previewPath, pngBuffer);
      console.log(`[Preview] Frame renderizado con éxito en ${previewPath}`);
      process.exit(0);
    } else {
      // Guardar temporal y enviar al hardware mediante trcc
      const framePath = join(tmpdir(), 'aimonitor-frame.png');
      writeFileSync(framePath, pngBuffer);

      try {
        const cmd = `${config.trcc.bin} send "${framePath}" ${config.trcc.extraArgs.join(' ')}`;
        execSync(cmd, { stdio: 'ignore', timeout: 5000 });
      } catch (err) {
        console.warn('Advertencia: No se pudo enviar el frame al panel físico mediante trcc. ¿Está conectado?');
      }
    }
  } catch (err) {
    console.error('Error crítico en el renderizado del daemon:', err);
  } finally {
    isRendering = false;
    if (pendingRender) {
      pendingRender = false;
      // Esperar un instante antes de procesar el render pendiente
      setTimeout(renderAndSend, 100);
    }
  }
}

// Debounce para agrupar múltiples eventos de fs en ráfagas
let debounceTimeout: NodeJS.Timeout | null = null;
function triggerRender() {
  if (debounceTimeout) clearTimeout(debounceTimeout);
  debounceTimeout = setTimeout(renderAndSend, 150);
}

async function start() {
  console.log('Iniciando daemon de aimonitor...');
  
  // Asegurar directorios
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true });
  }

  // Primer render inmediato
  await renderAndSend();

  if (previewPath) {
    // En modo preview, ya habremos salido en renderAndSend
    return;
  }

  // Escuchar cambios en la carpeta de sesiones
  console.log(`Vigilando cambios en: ${SESSIONS_DIR}`);
  const watcher = watch(SESSIONS_DIR, (eventType, filename) => {
    if (filename && filename.endsWith('.json')) {
      triggerRender();
    }
  });

  // Intervalo periódico cada minuto (para reloj, pixel shift, zombis y ccusage)
  const timer = setInterval(() => {
    triggerRender();
  }, 60000);

  // Manejo de salida limpia para apagar pantalla si procede
  const shutdown = () => {
    console.log('Deteniendo daemon y limpiando recursos...');
    watcher.close();
    clearInterval(timer);
    
    // Apagar panel en reposo si blankWhenIdle está habilitado
    if (config.blankWhenIdle) {
      try {
        const canvas = renderFrame({ sessions: [], config, now: Date.now() });
        const framePath = join(tmpdir(), 'aimonitor-frame.png');
        writeFileSync(framePath, canvas);
        const cmd = `${config.trcc.bin} send "${framePath}" ${config.trcc.extraArgs.join(' ')}`;
        execSync(cmd, { stdio: 'ignore', timeout: 2000 });
      } catch {}
    }
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch(err => {
  console.error('Error iniciando el daemon:', err);
  process.exit(1);
});
