// Polymarket empirical quantile forecaster (Node 22, stdlib only, no network, deterministic)
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
// Standard normal quantiles for fallback/blending
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

function quantile(arr: number[], q: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = q * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function quantileFromSorted(sorted: number[], tau: number): number {
  if (sorted.length === 0) return 0;
  const pos = tau * (sorted.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (base + 1 < sorted.length) {
    return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
  }
  return sorted[base];
}

function median(arr: number[]): number {
  return quantile(arr, 0.5);
}

function mad(arr: number[]): number {
  if (arr.length === 0) return 0;
  const med = median(arr);
  const absDevs = arr.map(x => Math.abs(x - med));
  return median(absDevs);
}

function forecastMarket(m: CaseMarket, horizon: number, pooledChanges: number[][]): number[][] {
  const prices = m.prices;
  if (prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = prices[prices.length - 1] as number;

  // Recent window: last 240 min (or all if shorter)
  const windowLen = Math.min(240, prices.length);
  const recentPrices = prices.slice(prices.length - windowLen);

  // 1-min changes MAD for fallback sigma
  const diffs1: number[] = [];
  for (let i = 1; i < recentPrices.length; i++) {
    diffs1.push((recentPrices[i] as number) - (recentPrices[i - 1] as number));
  }
  const sigma1 = Math.max(0.0005, 1.4826 * mad(diffs1));

  const rows: number[][] = [];
  const isShort = prices.length < 120;

  for (let h = 1; h <= horizon; h++) {
    // Correct indexing: prices[i] - prices[i - h]
    const empChangesCorrect: number[] = [];
    for (let i = h; i < recentPrices.length; i++) {
      empChangesCorrect.push((recentPrices[i] as number) - (recentPrices[i - h] as number));
    }

    const n_h = empChangesCorrect.length;
    const w = n_h / (n_h + 50);

    const sortedChanges = [...empChangesCorrect].sort((a, b) => a - b);

    const rowQuantiles: number[] = [];

    for (let j = 0; j < QUANTILES.length; j++) {
      const tau = QUANTILES[j] as number;
      const z = Z[j] as number;

      // Empirical quantile of h-changes
      let q_emp = 0;
      if (n_h > 0) {
        q_emp = quantileFromSorted(sortedChanges, tau);
      } else {
        q_emp = z * sigma1 * Math.sqrt(h);
      }

      // Fallback / pooling for short series
      let q_base = q_emp;
      if (isShort && pooledChanges[h - 1] && pooledChanges[h - 1].length > 10) {
        const q_pool = quantile(pooledChanges[h - 1] as number[], tau);
        q_base = w * q_emp + (1 - w) * q_pool;
      } else {
        q_base = w * q_emp + (1 - w) * (z * sigma1 * Math.sqrt(h));
      }

      const empVal = x + q_base;
      const baseVal = x + z * 0.0025 * Math.sqrt(h);
      const val = 0.5 * empVal + 0.5 * baseVal;
      rowQuantiles.push(val);
    }

    // Enforce non-decreasing and bounds [0, 1] and rounding
    rowQuantiles.sort((a, b) => a - b);
    for (let j = 1; j < rowQuantiles.length; j++) {
      if ((rowQuantiles[j] as number) < (rowQuantiles[j - 1] as number)) {
        rowQuantiles[j] = rowQuantiles[j - 1] as number;
      }
    }

    rows.push(rowQuantiles.map(v => price6(v)));
  }

  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();

for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const raw = readFileSync(join(INPUT_DIR, file), 'utf8');
  const c = JSON.parse(raw) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) {
    throw new Error(`${file} asks for unexpected quantiles`);
  }

  // Pre-compute pooled h-changes for this case (for short series fallback)
  const horizon = c.horizon_minutes;
  const hasShort = c.markets.some(m => m.prices.length < 120);
  const pooledChanges: number[][] = Array.from({ length: horizon }, () => []);
  if (hasShort) {
    for (const m of c.markets) {
      const prices = m.prices;
      const windowLen = Math.min(1440, prices.length);
      const recent = prices.slice(prices.length - windowLen);
      for (let h = 1; h <= horizon; h++) {
        for (let i = h; i < recent.length; i++) {
          pooledChanges[h - 1].push((recent[i] as number) - (recent[i - h] as number));
        }
      }
    }
  }

  const forecasts = c.markets.map((m) => ({
    id: m.id,
    q: forecastMarket(m, horizon, pooledChanges),
  }));

  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
