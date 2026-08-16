#!/usr/bin/env node
/**
 * Script de simulación interactiva para aimonitor.
 * Despliega un menú en terminal para enviar eventos simulados al hook de forma interactiva
 * e inspeccionar cómo cambia la pantalla pequeña en tiempo real.
 */
import { spawn, execSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SESSIONS_DIR = join(homedir(), '.aimonitor', 'sessions');

// Limpiar pantalla al iniciar
console.clear();

const rl = createInterface({
  input: process.stdin,
  output: process.stdout
});

function sendEvent(provider, event, detail = '', sessionId = 'sim-session-1') {
  const payload = {
    event,
    session_id: sessionId,
    cwd: join(homedir(), 'dev', 'proyecto-demo'),
    detail: detail || `${event} simulado`
  };

  const hook = spawn('node', ['dist/src/hook.js', '--provider', provider]);
  hook.stdin.write(JSON.stringify(payload));
  hook.stdin.end();

  hook.on('close', () => {
    console.log(`\n[Evento Enviado] ${provider.toUpperCase()} -> ${event} (${payload.detail})`);
    showMenu();
  });
}

function cleanAllSessions() {
  if (existsSync(SESSIONS_DIR)) {
    try {
      const files = readdirSync(SESSIONS_DIR);
      for (const file of files) {
        rmSync(join(SESSIONS_DIR, file), { force: true });
      }
      console.log('\n[Limpieza] Todas las sesiones de simulación han sido borradas.');
    } catch (err) {
      console.error('\n[Error] No se pudieron limpiar las sesiones:', err.message);
    }
  } else {
    console.log('\n[Limpieza] No hay sesiones activas que borrar.');
  }
  showMenu();
}

function showMenu() {
  console.log(`
===================================================
   📦 SIMULADOR DE EVENTOS INTERACTIVO: aimonitor
===================================================
Simula eventos de IA enviándolos directamente al hook.

PROVEEDOR: CLAUDE
  [1] Claude Code - Empieza a trabajar (activa)
  [2] Claude Code - Pide confirmación (permiso 🛑)
  [3] Claude Code - Espera input de usuario (espera ⏳)
  [4] Claude Code - Termina con éxito (listo ✨)
  [5] Claude Code - Cierra sesión (borrar)

PROVEEDOR: GEMINI
  [6] Gemini CLI  - Empieza a trabajar (activa)
  [7] Gemini CLI  - Pide confirmación (permiso 🛑)
  [8] Gemini CLI  - Termina con éxito (listo ✨)

MANTENIMIENTO
  [c] Limpiar todas las sesiones activas (vaciar pantalla)
  [0] Salir del simulador
===================================================`);

  rl.question('Elige una opción: ', (answer) => {
    const choice = answer.trim().toLowerCase();
    switch (choice) {
      case '1':
        sendEvent('claude', 'PreToolUse', 'Bash: npm run test', 'claude-sim-1');
        break;
      case '2':
        sendEvent('claude', 'Notification', 'permission_prompt: ejecutar rm -rf node_modules?', 'claude-sim-1');
        break;
      case '3':
        sendEvent('claude', 'Notification', 'idle_prompt: esperando entrada del operador', 'claude-sim-1');
        break;
      case '4':
        sendEvent('claude', 'Stop', 'Terminado con éxito en 24s', 'claude-sim-1');
        break;
      case '5':
        sendEvent('claude', 'SessionEnd', '', 'claude-sim-1');
        break;
      case '6':
        sendEvent('gemini', 'UserPromptSubmit', 'Read package.json', 'gemini-sim-1');
        break;
      case '7':
        sendEvent('gemini', 'Notification', 'permiso para llamar a la API de Geocoding', 'gemini-sim-1');
        break;
      case '8':
        sendEvent('gemini', 'SubagentStop', 'Análisis de dependencias terminado', 'gemini-sim-1');
        break;
      case 'c':
        cleanAllSessions();
        break;
      case '0':
        console.log('\n¡Gracias por probar aimonitor! Hasta luego.');
        rl.close();
        process.exit(0);
        break;
      default:
        console.log('\n[Error] Opción no válida.');
        showMenu();
        break;
    }
  });
}

// Verificar si el proyecto está compilado antes de iniciar
if (!existsSync('dist/src/hook.js')) {
  console.log('Compilando TypeScript primero para asegurar que dist/ esté actualizado...');
  try {
    execSync('npm run build', { stdio: 'inherit' });
  } catch {
    console.error('Error compilando el proyecto. Abortando simulación.');
    process.exit(1);
  }
}

showMenu();
