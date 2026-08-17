#!/usr/bin/env node
/**
 * Hook de eventos para aimonitor.
 * Se invoca en cada evento de Claude Code o Gemini CLI pasándole un JSON por stdin.
 * Traduce el evento a un fichero de estado por sesión en ~/.aimonitor/sessions/<session_id>.json
 * de forma atómica.
 *
 * Está en el camino crítico de cada tool call: nada de I/O de red, nada de
 * dependencias pesadas, y nunca falla ruidosamente. Si algo peta, salir con 0.
 */
import { mkdirSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { SESSIONS_DIR } from './config.ts';
import type { SessionRecord, SessionState, Provider } from './types.ts';

// No fallar ruidosamente para no romper la sesión del asistente de IA principal
process.on('uncaughtException', () => process.exit(0));

/** Campo de `tool_input` que mejor identifica la llamada, por herramienta. */
const TOOL_ARG_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt'] as const;

/** Resume `tool_input` a un fragmento legible en una casilla de 320 px. */
function summarizeToolInput(input: unknown): string {
  if (typeof input === 'string') return input;
  if (typeof input !== 'object' || input === null) return '';
  const obj = input as Record<string, unknown>;
  for (const key of TOOL_ARG_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

/** `permission_prompt` → `Permission prompt`, para que el detalle diga algo. */
function humanize(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function truncate(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * Estado anterior de la sesión, para conservar `since`. El panel no pregunta
 * "¿está esperando?" sino "¿cuánto lleva esperando?": si `since` se reescribiera
 * en cada evento, el contador se reiniciaría solo y el dato perdería el sentido.
 */
function previousRecord(path: string): SessionRecord | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
}

async function main() {
  // Parsear argumentos CLI (ej. --provider gemini)
  let provider: Provider = 'claude';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      const p = args[i + 1]!.toLowerCase();
      if (p === 'gemini' || p === 'claude') provider = p;
    }
  }

  // Leer stdin
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const inputStr = Buffer.concat(chunks).toString('utf8').trim();
  if (!inputStr) process.exit(0);

  let data: any;
  try {
    data = JSON.parse(inputStr);
  } catch {
    process.exit(0); // Si no es JSON válido, ignorar silenciosamente
  }

  // Claude Code emite `hook_event_name`; el resto de nombres son para Gemini CLI
  // y scripts propios, que no comparten esquema.
  const event: string = data.hook_event_name || data.event || data.type || '';
  const sessionId: string = data.session_id || data.sessionId || 'global';
  const cwd: string = data.cwd || process.cwd();
  const project = basename(cwd);

  const finalPath = join(SESSIONS_DIR, `${sessionId}.json`);

  // SessionEnd borra el registro y sale: no hay nada que pintar.
  if (event === 'SessionEnd') {
    try {
      rmSync(finalPath, { force: true });
    } catch {}
    process.exit(0);
  }

  // Mapear evento a estado y derivar el detalle técnico de los campos que
  // realmente acompañan a cada evento.
  let state: SessionState = 'activa';
  let detail = '';

  switch (event) {
    case 'SessionStart':
      state = 'inactiva';
      detail = humanize(String(data.session_start_type ?? data.source ?? ''));
      break;

    case 'UserPromptSubmit':
      state = 'activa';
      detail = String(data.prompt ?? '');
      break;

    case 'PreToolUse':
    case 'PostToolUse': {
      state = 'activa';
      const tool = String(data.tool_name ?? data.tool?.name ?? data.tool ?? '');
      const arg = summarizeToolInput(data.tool_input ?? data.tool?.arguments);
      detail = arg ? `${tool}: ${arg}` : tool;
      break;
    }

    case 'Notification': {
      // Los matchers documentados son permission_prompt | idle_prompt |
      // auth_success | elicitation_* | agent_*.
      const kind = String(data.notification_type ?? data.notificationType ?? data.message ?? '').toLowerCase();
      if (kind.includes('permission') || kind.includes('elicitation') || kind.includes('permiso')) {
        state = 'permiso';
      } else if (kind.includes('idle') || kind.includes('wait') || kind.includes('espera')) {
        state = 'espera';
      } else {
        state = 'activa';
      }
      detail = humanize(String(data.notification_type ?? data.notificationType ?? data.message ?? ''));
      break;
    }

    case 'Stop':
    case 'SubagentStop':
      state = 'listo';
      detail = String(data.last_assistant_message ?? '');
      break;

    default:
      state = 'activa';
      detail = String(data.detail ?? data.message ?? data.command ?? '');
      break;
  }

  detail = truncate(detail);

  // Conservar `since` mientras el estado no cambie.
  const now = Date.now();
  const prev = previousRecord(finalPath);
  const since = prev && prev.state === state && typeof prev.since === 'number' ? prev.since : now;

  const record: SessionRecord = {
    session_id: sessionId,
    provider,
    state,
    detail,
    project,
    cwd,
    since,
    updated: now,
    event: event || 'Unknown',
  };

  mkdirSync(SESSIONS_DIR, { recursive: true });

  // Escritura atómica: el rename dentro del mismo sistema de ficheros es
  // atómico, así que el daemon nunca lee un JSON a medio escribir. El temporal
  // va al propio SESSIONS_DIR y no a /tmp porque suelen ser volúmenes distintos
  // y entonces rename(2) degeneraría en copiar.
  const tempPath = join(SESSIONS_DIR, `.${sessionId}.${process.pid}.tmp`);
  try {
    writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tempPath, finalPath);
  } catch {
    try {
      rmSync(tempPath, { force: true });
    } catch {}
  }
}

main().catch(() => process.exit(0));
