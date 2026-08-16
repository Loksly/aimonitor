import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { UsageSnapshot } from './types.ts';
import type { Config } from './config.ts';

const execAsync = promisify(exec);

interface CcusageTokenData {
  input?: number;
  output?: number;
  cache_creation?: number;
  cache_read?: number;
}

interface CcusageRow {
  model?: string;
  costUSD?: number;
  tokens?: CcusageTokenData;
}

interface CcusageReport {
  daily?: CcusageRow[];
  monthly?: CcusageRow[];
  totals?: {
    costUSD?: number;
    tokens?: CcusageTokenData;
  };
}

async function runCmd(cmd: string): Promise<CcusageReport | CcusageRow[]> {
  const { stdout } = await execAsync(cmd);
  return JSON.parse(stdout);
}

export async function fetchUsage(cfg: Config): Promise<UsageSnapshot> {
  const snapshot: UsageSnapshot = {
    mode: cfg.usage.mode,
    stale: false,
    tokensToday: 0,
    byModel: [],
  };

  try {
    if (cfg.usage.mode === 'api') {
      let dailyCost = 0;
      let dailyTokens = 0;
      const modelMap = new Map<string, number>();

      try {
        const dailyData = await runCmd('ccusage daily --json');
        if (dailyData && !Array.isArray(dailyData) && dailyData.totals) {
          dailyCost = dailyData.totals.costUSD ?? 0;
          const t = dailyData.totals.tokens ?? {};
          dailyTokens = (t.input ?? 0) + (t.output ?? 0) + (t.cache_creation ?? 0) + (t.cache_read ?? 0);
        }
        
        // Mapear por modelo si viene un array de registros o una lista "daily"
        const rows = Array.isArray(dailyData) 
          ? dailyData 
          : (dailyData && !Array.isArray(dailyData) ? dailyData.daily : undefined);

        if (Array.isArray(rows)) {
          for (const row of rows) {
            const cost = row.costUSD ?? 0;
            const t = row.tokens ?? {};
            const sum = (t.input ?? 0) + (t.output ?? 0) + (t.cache_creation ?? 0) + (t.cache_read ?? 0);
            
            if (dailyCost === 0) dailyCost += cost; // Si no hay total, acumulamos
            if (dailyTokens === 0) dailyTokens += sum;

            if (row.model) {
              const modelName = row.model.replace('claude-3-5-', ''); // Acortamos nombre para pantalla
              modelMap.set(modelName, (modelMap.get(modelName) ?? 0) + sum);
            }
          }
        }
      } catch (err) {
        console.warn('Advertencia leyendo ccusage daily:', err instanceof Error ? err.message : err);
        snapshot.stale = true;
      }

      let monthlyCost = 0;
      try {
        const monthlyData = await runCmd('ccusage monthly --json');
        if (monthlyData && !Array.isArray(monthlyData) && monthlyData.totals) {
          monthlyCost = monthlyData.totals.costUSD ?? 0;
        } else if (Array.isArray(monthlyData)) {
          for (const row of monthlyData) {
            monthlyCost += row.costUSD ?? 0;
          }
        } else if (monthlyData && !Array.isArray(monthlyData) && Array.isArray(monthlyData.monthly)) {
          for (const row of monthlyData.monthly) {
            monthlyCost += row.costUSD ?? 0;
          }
        }
      } catch (err) {
        console.warn('Advertencia leyendo ccusage monthly:', err instanceof Error ? err.message : err);
        snapshot.stale = true;
      }

      snapshot.spend = [
        { label: 'Hoy', amount: dailyCost, cap: cfg.usage.dailyCap },
        { label: 'Mes', amount: monthlyCost, cap: cfg.usage.monthlyCap },
      ];
      snapshot.tokensToday = dailyTokens;
      snapshot.byModel = Array.from(modelMap.entries()).map(([model, tokens]) => ({ model, tokens }));

    } else {
      // Modo max: simula las ventanas de límite ya que max se rige por ventanas de tiempo
      snapshot.windows = [
        { label: 'Ventana 5 h', ratio: 0.15, resetsAt: Date.now() + 2.5 * 3600_000 },
        { label: 'Semana', ratio: 0.35, resetsAt: Date.now() + 24 * 3600_000 * 3 },
      ];
      snapshot.tokensToday = 0;
    }
  } catch (err) {
    console.error('Error crítico consultando ccusage:', err);
    snapshot.stale = true;
  }

  return snapshot;
}
