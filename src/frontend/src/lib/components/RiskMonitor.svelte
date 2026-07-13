<script lang="ts">
  import { risk } from '../stores/risk';

  function fmtPct(v: number | null | undefined): string {
    if (v == null) return '--';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  }

  function fmtUsd(v: number | null | undefined): string {
    if (v == null) return '--';
    return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Daily P&L bar: how far from the loss limit (limit is negative)
  function dailyPnlBar(pct: number, limit: number): number {
    if (limit === 0) return 0;
    const used = Math.abs(Math.min(pct, 0)) / Math.abs(limit);
    return Math.min(used * 100, 100);
  }

  function rotationsBar(count: number, limit: number): number {
    if (limit === 0) return 0;
    return Math.min((count / limit) * 100, 100);
  }

  function positionBar(pct: number, limit: number): number {
    if (limit === 0) return 0;
    return Math.min((pct / limit) * 100, 100);
  }

  function floorBar(value: number, floor: number): number {
    if (floor === 0) return 0;
    const ratio = (value - floor) / floor;
    return Math.max(0, Math.min(100, 100 - ratio * 50));
  }

  $: r = $risk;
  $: isEmpty = !r || (!r.has_data && !r.optimizer_enabled);

  $: optimizerLabel =
    !r?.optimizer_enabled ? 'Disabled'
    : r?.optimizer_status === 'risk-off' ? 'Risk-Off'
    : r?.optimizer_status === 'active' ? 'Active'
    : r?.optimizer_status ?? 'Unknown';

  $: optimizerColor =
    optimizerLabel === 'Active' ? 'text-gain'
    : optimizerLabel === 'Risk-Off' ? 'text-warn'
    : 'text-[var(--text-muted)]';

  $: optimizerDot =
    optimizerLabel === 'Active' ? 'bg-gain'
    : optimizerLabel === 'Risk-Off' ? 'bg-warn'
    : 'bg-[var(--text-muted)]';
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-4">
  <h2 class="text-sm font-semibold font-display text-[var(--text-primary)] mb-3">Risk monitor</h2>

  {#if isEmpty}
    <div class="text-xs text-[var(--text-muted)] py-2">
      Enable the portfolio optimizer in Settings to activate risk monitoring.
    </div>
  {:else}
    <div class="grid grid-cols-2 md:grid-cols-5 gap-6">

      <!-- Daily P&L -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Daily P&amp;L</div>
        {#if r && r.has_data}
          {@const v = r.daily_pnl_pct ?? 0}
          {@const lim = r.daily_pnl_limit ?? 5}
          <div class="text-xl font-bold font-mono tabular-nums" class:text-gain={v >= 0} class:text-loss={v < 0}>{fmtPct(v)}</div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">limit: -{lim}%</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full"
              class:bg-gain={v >= 0}
              class:bg-loss={v < 0}
              style="width: {dailyPnlBar(v, lim)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Rotations Today -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Rotations Today</div>
        {#if r}
          {@const c = r.rotations_today ?? 0}
          {@const lim = r.max_daily_rotations ?? 10}
          <div class="text-xl font-bold font-mono tabular-nums text-[var(--text-primary)]">{c} / {lim}</div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">daily max</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full bg-clay"
              style="width: {rotationsBar(c, lim)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Max Position -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Max Position</div>
        {#if r}
          {@const pct = r.max_position_pct ?? 0}
          {@const lim = r.max_position_limit ?? 40}
          {@const warn = pct > lim * 0.8}
          <div class="text-xl font-bold font-mono tabular-nums" class:text-warn={warn} class:text-[var(--text-primary)]={!warn}>
            {pct.toFixed(1)}%
          </div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">limit: {lim}%</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full"
              class:bg-warn={warn}
              class:bg-clay={!warn}
              style="width: {positionBar(pct, lim)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Portfolio Floor -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Portfolio Floor</div>
        {#if r}
          {@const val = r.portfolio_usd ?? 0}
          {@const fl = r.portfolio_floor ?? 100}
          {@const nearFloor = val < fl * 1.2}
          <div class="text-xl font-bold font-mono tabular-nums" class:text-loss={nearFloor} class:text-gain={!nearFloor}>{fmtUsd(val)}</div>
          <div class="text-[10px] text-[var(--text-muted)] mt-1">floor: {fmtUsd(fl)}</div>
          <div class="w-full h-1 bg-[var(--border)] rounded-full mt-2">
            <div
              class="h-full rounded-full"
              class:bg-loss={nearFloor}
              class:bg-gain={!nearFloor}
              style="width: {floorBar(val, fl)}%"
            ></div>
          </div>
        {:else}
          <div class="text-xl font-bold text-[var(--text-muted)]">—</div>
        {/if}
      </div>

      <!-- Optimizer Status -->
      <div>
        <div class="text-xs text-[var(--text-muted)] mb-1">Optimizer</div>
        <div class="flex items-center gap-2 mt-1">
          <span class="inline-block w-2.5 h-2.5 rounded-full {optimizerDot}"></span>
          <span class="text-xl font-bold {optimizerColor}">{optimizerLabel}</span>
        </div>
      </div>

    </div>
  {/if}
</div>
