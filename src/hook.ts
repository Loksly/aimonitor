#!/usr/bin/env node
/**
 * Hook de eventos para aimonitor.
 * Se invoca en cada evento de Claude Code o Gemini CLI pasándole un JSON por stdin.
 * Traduce el evento a un fichero de estado por sesión en ~/.aimonitor/sessions/<session_id>.json
 * de forma asíncrona y atómica.
 */
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { STATE_DIR, SESSIONS_DIR } from './config.ts';
import type { SessionRecord, SessionState, Provider } from './types.ts';

// No fallar ruidosamente para no romper la sesión del asistente de IA principal
process.on('uncaughtException', () => {
  process.exit(0);
});

async function main() {
  // Parsear argumentos CLI (ej. --provider gemini)
  let provider: Provider = 'claude';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      const p = args[i + 1]!.toLowerCase();
      if (p === 'gemini' || p === 'claude') {
        provider = p;
      }
    }
  }

  // Leer stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const inputStr = Buffer.concat(chunks).toString('utf8').trim();
  if (!inputStr) {
    process.exit(0);
  }

  let data: any;
  try {
    data = JSON.parse(inputStr);
  } catch {
    // Si no es JSON válido, ignorar silenciosamente
    process.exit(0);
  }

  // Extraer campos (soportando variantes comunes de nombres de propiedades)
  const event = data.event || data.type || 'Notification';
  const sessionId = data.session_id || data.sessionId || 'global';
  const cwd = data.cwd || process.cwd();
  const project = basename(cwd);
  
  // Extraer el detalle técnico
  let detail = '';
  if (data.detail) {
    detail = data.detail;
  } else if (data.tool) {
    detail = `${data.tool.name || data.tool}`;
    if (data.tool.arguments) {
      const argsStr = JSON.stringify(data.tool.arguments);
      detail += `: ${argsStr.substring(0, 40)}`;
    }
  } else if (data.message) {
    detail = data.message;
  } else if (data.command) {
    detail = data.command;
  }

  // Truncar detalle para la pantalla pequeña
  if (detail.length > 80) {
    detail = detail.substring(0, 77) + '...';
  }

  // Mapear evento a estado
  let state: SessionState = 'inactiva';

  if (event === 'SessionStart') {
    state = 'inactiva';
  } else if (['UserPromptSubmit', 'PreToolUse', 'PostToolUse'].includes(event)) {
    state = 'activa';
  } else if (event === 'Notification') {
    const textToMatch = (detail + ' ' + (data.notificationType || '')).toLowerCase();
    if (textToMatch.includes('permission_prompt') || textToMatch.includes('permiso') || textToMatch.includes('permission')) {
      state = 'permiso';
    } else if (textToMatch.includes('idle_prompt') || textToMatch.includes('espera') || textToMatch.includes('wait')) {
      state = 'espera';
    } else {
      state = 'activa';
    }
  } else if (['Stop', 'SubagentStop'].includes(event)) {
    state = 'listo';
  } else if (event === 'SessionEnd') {
    // Borrar el archivo y salir
    try {
      const filepath = join(SESSIONS_DIR, `${sessionId}.json`);
      rmSync(filepath, { force: true });
    } catch {}
    process.exit(0);
  } else {
    // Estado por defecto según el texto si no coincide
    state = 'activa';
  }

  // Crear registro
  const now = Date.now();
  const record: SessionRecord = {
    session_id: sessionId,
    provider,
    state,
    detail,
    project,
    cwd,
    since: now, // asumimos que entra ahora en este estado
    updated: now,
    event,
  };

  // Asegurar que el directorio de estado exista
  mkdirSync(SESSIONS_DIR, { recursive: true });

  // Escritura atómica (tmp + os.renameSync) para evitar lecturas parciales en el daemon
  const tempPath = join(tmpdir(), `aimonitor-${sessionId}-${now}.json`);
  const finalPath = join(SESSIONS_DIR, `${sessionId}.json`);

  writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
  renameSync(tempPath, finalPath);
}

main().catch(() => process.exit(0));
