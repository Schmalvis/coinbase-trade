<script lang="ts">
  import { trades } from '../stores/trades';
  import type { TradeData } from '../types';

  function formatTime(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function actionClass(action: string): string {
    return action === 'buy'
      ? 'text-green-400'
      : action === 'sell'
      ? 'text-red-400'
      : 'text-[var(--text-secondary)]';
  }
</script>

<div class="rounded-xl border border-[var(--border)] bg-[var(--card-bg)] p-4">
  <h2 class="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">Trade History</h2>

  {#if $trades.length === 0}
    <p class="text-sm text-[var(--text-secondary)]">No trades yet.</p>
  {:else}
    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead>
          <tr class="text-[var(--text-secondary)] text-xs border-b border-[var(--border)]">
            <th class="text-left pb-2 pr-4">Time</th>
            <th class="text-left pb-2 pr-4">Action</th>
            <th class="text-left pb-2 pr-4">Asset</th>
            <th class="text-right pb-2 pr-4">Amount</th>
            <th class="text-right pb-2 pr-4">Price</th>
            <th class="text-left pb-2 pr-4 hidden sm:table-cell">Reason</th>
            <th class="text-left pb-2 hidden sm:table-cell">Strategy</th>
            <th class="text-center pb-2">Mode</th>
          </tr>
        </thead>
        <tbody>
          {#each $trades as t (t.id)}
            <tr class="border-b border-[var(--border)] last:border-0">
              <td class="py-1.5 pr-4 text-[var(--text-secondary)] whitespace-nowrap">{formatTime(t.timestamp)}</td>
              <td class="py-1.5 pr-4 font-medium uppercase {actionClass(t.action)}">{t.action}</td>
              <td class="py-1.5 pr-4 font-medium">{t.symbol ?? '—'}</td>
              <td class="py-1.5 pr-4 text-right font-mono">{(t.amount_eth ?? 0).toFixed(6)}</td>
              <td class="py-1.5 pr-4 text-right font-mono">${(t.price_usd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
              <td class="py-1.5 pr-4 text-[var(--text-secondary)] hidden sm:table-cell max-w-[180px] truncate">{t.reason ?? '—'}</td>
              <td class="py-1.5 pr-4 text-[var(--text-secondary)] hidden sm:table-cell">{t.strategy ?? '—'}</td>
              <td class="py-1.5 text-center">
                {#if t.dry_run}
                  <span class="text-xs px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">dry</span>
                {:else}
                  <span class="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">live</span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {/if}
</div>
