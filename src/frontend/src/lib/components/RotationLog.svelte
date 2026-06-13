<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchCalibration } from '../api';

  type CalibRow = {
    id: number;
    timestamp: string;
    sell_symbol: string;
    buy_symbol: string;
    status: string;
    dry_run: number;
    score_delta: number | null;
    estimated_gain_pct: number;
    actual_gain_pct: number | null;
    estimated_fee_pct: number;
    implied_fee_pct: number | null;
    sell_amount: number;
    buy_amount: number | null;
  };

  let rows: CalibRow[] = [];

  onMount(async () => {
    try { rows = await fetchCalibration(); } catch {}
  });

  function fmt(v: number | null, decimals = 2): string {
    return v == null ? '—' : v.toFixed(decimals);
  }

  function fmtTime(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function gainClass(v: number | null): string {
    if (v == null) return 'text-[var(--text-secondary)]';
    return v >= 0 ? 'text-green-400' : 'text-red-400';
  }

  function statusBadge(s: string): string {
    if (s === 'executed') return 'bg-green-500/20 text-green-400';
    if (s === 'vetoed') return 'bg-yellow-500/20 text-yellow-400';
    if (s === 'failed') return 'bg-red-500/20 text-red-400';
    if (s === 'leg1_done') return 'bg-orange-500/20 text-orange-400';
    return 'bg-gray-500/20 text-gray-400';
  }

  $: executed = rows.filter(r => r.status === 'executed' && r.actual_gain_pct != null);
  $: avgEstimated = executed.length > 0
    ? executed.reduce((s, r) => s + r.estimated_gain_pct, 0) / executed.length
    : null;
  $: avgActual = executed.length > 0
    ? executed.reduce((s, r) => s + (r.actual_gain_pct ?? 0), 0) / executed.length
    : null;
  $: avgImpliedFee = executed.filter(r => r.implied_fee_pct != null).length > 0
    ? executed.filter(r => r.implied_fee_pct != null).reduce((s, r) => s + (r.implied_fee_pct ?? 0), 0) /
      executed.filter(r => r.implied_fee_pct != null).length
    : null;
</script>

<div class="rounded-xl border border-[var(--border)] bg-[var(--card-bg)] p-4">
  <h2 class="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Rotation Calibration</h2>

  {#if rows.length === 0}
    <p class="text-sm text-[var(--text-secondary)]">No rotation data yet.</p>
  {:else}
    <!-- Summary stats for executed rotations -->
    {#if executed.length > 0}
      <div class="flex gap-6 mb-4 text-sm">
        <div>
          <span class="text-[var(--text-secondary)]">Executions: </span>
          <span class="font-medium">{executed.length}</span>
        </div>
        <div>
          <span class="text-[var(--text-secondary)]">Avg estimated: </span>
          <span class="font-mono {gainClass(avgEstimated)}">{fmt(avgEstimated)}%</span>
        </div>
        <div>
          <span class="text-[var(--text-secondary)]">Avg actual: </span>
          <span class="font-mono {gainClass(avgActual)}">{fmt(avgActual)}%</span>
        </div>
        <div>
          <span class="text-[var(--text-secondary)]">Avg fee: </span>
          <span class="font-mono text-[var(--text-secondary)]">{fmt(avgImpliedFee)}%</span>
        </div>
      </div>
    {/if}

    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-[var(--text-secondary)] text-xs border-b border-[var(--border)]">
            <th class="text-left pb-2 pr-3">Time</th>
            <th class="text-left pb-2 pr-3">Pair</th>
            <th class="text-center pb-2 pr-3">Status</th>
            <th class="text-right pb-2 pr-3">Score Δ</th>
            <th class="text-right pb-2 pr-3">Est. Gain</th>
            <th class="text-right pb-2 pr-3">Actual Gain</th>
            <th class="text-right pb-2 pr-3 hidden sm:table-cell">Fee (implied)</th>
            <th class="text-right pb-2 hidden sm:table-cell">Size $</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.id)}
            <tr class="border-b border-[var(--border)] last:border-0">
              <td class="py-1.5 pr-3 text-[var(--text-secondary)] whitespace-nowrap text-xs">{fmtTime(r.timestamp)}</td>
              <td class="py-1.5 pr-3 font-medium whitespace-nowrap">{r.sell_symbol}→{r.buy_symbol}</td>
              <td class="py-1.5 pr-3 text-center">
                <span class="text-xs px-1.5 py-0.5 rounded {statusBadge(r.status)}">{r.status}</span>
              </td>
              <td class="py-1.5 pr-3 text-right font-mono text-[var(--text-secondary)]">{fmt(r.score_delta, 1)}</td>
              <td class="py-1.5 pr-3 text-right font-mono {gainClass(r.estimated_gain_pct)}">{fmt(r.estimated_gain_pct)}%</td>
              <td class="py-1.5 pr-3 text-right font-mono {gainClass(r.actual_gain_pct)}">{fmt(r.actual_gain_pct)}%</td>
              <td class="py-1.5 pr-3 text-right font-mono text-[var(--text-secondary)] hidden sm:table-cell">{fmt(r.implied_fee_pct)}%</td>
              <td class="py-1.5 text-right font-mono text-[var(--text-secondary)] hidden sm:table-cell">${fmt(r.sell_amount, 2)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
