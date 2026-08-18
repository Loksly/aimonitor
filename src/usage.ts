import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { BlockPoint, UsageSnapshot, UsageWindow } from './types.ts';
import type { Config } from './config.ts';

const execAsync = promisify(exec);

/**
 * Formas reales que devuelve `ccusage --json`, verificadas contra la salida del
 * binario. Ojo: `daily`/`weekly`/`monthly` usan `totalCost` y contadores planos,
 * mientras que `blocks` usa `costUSD` y los anida en `tokenCounts`. No es el
 * mismo esquema, aunque lo parezca.
 */
interface CcusageModelBreakdown {
  modelName?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

interface CcusagePeriodRow {
  /** Fecha de inicio del periodo, `YYYY-MM-DD`. */
  period?: string;
  totalTokens?: number;
  totalCost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  modelsUsed?: string[];
  modelBreakdowns?: CcusageModelBreakdown[];
}

interface CcusagePeriodReport {
  daily?: CcusagePeriodRow[];
  weekly?: CcusagePeriodRow[];
  monthly?: CcusagePeriodRow[];
  totals?: { totalCost?: number; totalTokens?: number };
}

interface CcusageBlock {
  id?: string;
  startTime?: string;
  endTime?: string;
  isActive?: boolean;
  isGap?: boolean;
  totalTokens?: number;
  costUSD?: number;
}

interface CcusageBlocksReport {
  blocks?: CcusageBlock[];
}

const DAY_MS = 86_400_000;

/** Cuántos bloques de 5 h entran en la sparkline. ~2,5 días de contexto. */
const SPARK_BLOCKS = 12;

/** Quita el prefijo de familia para que el nombre quepa en el carril. */
function shortModel(name: string): string {
  return name.replace(/^claude-/, '');
}

/**
 * Percentil sobre valores ya filtrados. `p` = 100 devuelve el máximo absoluto,
 * que es la calibración por defecto: el 100% de la barra es la sesión más
 * cargada del histórico del propio usuario.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

/** Ratio acotado a 0..1; sin denominador no hay barra que pintar. */
function safeRatio(value: number, denom: number): number | null {
  if (!Number.isFinite(denom) || denom <= 0) return null;
  return Math.min(1, Math.max(0, value / denom));
}

export async function fetchUsage(cfg: Config): Promise<UsageSnapshot> {
  const snapshot: UsageSnapshot = {
    mode: cfg.usage.mode,
    stale: false,
    tokensToday: 0,
    byModel: [],
  };

  const bin = cfg.usage.bin;
  const run = async <T>(args: string): Promise<T> => {
    const { stdout } = await execAsync(`${bin} ${args}`, { timeout: 30_000, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout) as T;
  };

  // Pie común (tokens de hoy y reparto por modelo): sale de `daily` en ambos modos.
  let dailyRow: CcusagePeriodRow | undefined;
  let dailyReport: CcusagePeriodReport | undefined;
  try {
    dailyReport = await run<CcusagePeriodReport>('daily --json');
    dailyRow = dailyReport.daily?.at(-1);
    if (dailyRow) {
      snapshot.tokensToday = dailyRow.totalTokens ?? 0;
      snapshot.byModel = (dailyRow.modelBreakdowns ?? [])
        .filter((m) => m.modelName)
        .map((m) => ({
          model: shortModel(m.modelName!),
          tokens:
            (m.inputTokens ?? 0) +
            (m.outputTokens ?? 0) +
            (m.cacheCreationTokens ?? 0) +
            (m.cacheReadTokens ?? 0),
        }))
        .sort((a, b) => b.tokens - a.tokens);
    }
  } catch (err) {
    console.warn('Aviso: falló `ccusage daily --json`:', err instanceof Error ? err.message : err);
    snapshot.stale = true;
  }

  if (cfg.usage.mode === 'api') {
    const dailyCost = dailyRow?.totalCost ?? 0;
    let monthlyCost = 0;
    try {
      const monthly = await run<CcusagePeriodReport>('monthly --json');
      monthlyCost = monthly.monthly?.at(-1)?.totalCost ?? monthly.totals?.totalCost ?? 0;
    } catch (err) {
      console.warn('Aviso: falló `ccusage monthly --json`:', err instanceof Error ? err.message : err);
      snapshot.stale = true;
    }
    snapshot.spend = [
      { label: 'Hoy', amount: dailyCost, cap: cfg.usage.dailyCap },
      { label: 'Mes', amount: monthlyCost, cap: cfg.usage.monthlyCap },
    ];
    return snapshot;
  }

  // ── Modo max ────────────────────────────────────────────────────────────────
  // `ccusage` no publica el límite del plan, así que el 100% se calibra contra
  // el histórico propio. Si no hay histórico suficiente, se omite la barra en
  // lugar de inventarse un porcentaje: una barra falsa en rojo es peor que
  // ninguna barra en este diseño.
  const { metric, lookbackDays, percentile: p } = cfg.usage.calibration;
  const cutoff = lookbackDays > 0 ? Date.now() - lookbackDays * DAY_MS : 0;
  const windows: UsageWindow[] = [];

  try {
    const { blocks = [] } = await run<CcusageBlocksReport>('blocks --json');
    const real = blocks.filter((b) => !b.isGap);
    const active = real.find((b) => b.isActive);
    const value = (b: CcusageBlock) => (metric === 'cost' ? (b.costUSD ?? 0) : (b.totalTokens ?? 0));

    const history = real
      .filter((b) => !b.isActive && (!cutoff || Date.parse(b.startTime ?? '') >= cutoff))
      .map(value)
      .filter((v) => v > 0);

    // La sparkline sale de estos mismos bloques: la llamada ya está hecha para
    // calibrar, así que el histórico es gratis.
    snapshot.blockHistory = real
      .slice(-SPARK_BLOCKS)
      .map<BlockPoint>((b) => ({
        cost: b.costUSD ?? 0,
        startTime: Date.parse(b.startTime ?? '') || 0,
        active: b.isActive === true,
      }));

    const ratio = active ? safeRatio(value(active), percentile(history, p)) : 0;
    if (ratio !== null) {
      windows.push({
        label: 'Ventana 5 h',
        ratio,
        resetsAt: active?.endTime ? Date.parse(active.endTime) : undefined,
      });
    }
  } catch (err) {
    console.warn('Aviso: falló `ccusage blocks --json`:', err instanceof Error ? err.message : err);
    snapshot.stale = true;
  }

  try {
    const { weekly = [] } = await run<CcusagePeriodReport>('weekly --json');
    const current = weekly.at(-1);
    const value = (r: CcusagePeriodRow) => (metric === 'cost' ? (r.totalCost ?? 0) : (r.totalTokens ?? 0));

    const history = weekly
      .slice(0, -1)
      .filter((r) => !cutoff || Date.parse(r.period ?? '') >= cutoff)
      .map(value)
      .filter((v) => v > 0);

    const ratio = current ? safeRatio(value(current), percentile(history, p)) : null;
    if (ratio !== null) {
      const start = Date.parse(current!.period ?? '');
      windows.push({
        label: 'Semana',
        ratio,
        resetsAt: Number.isFinite(start) ? start + 7 * DAY_MS : undefined,
      });
    }
  } catch (err) {
    console.warn('Aviso: falló `ccusage weekly --json`:', err instanceof Error ? err.message : err);
    snapshot.stale = true;
  }

  snapshot.windows = windows;
  return snapshot;
}
