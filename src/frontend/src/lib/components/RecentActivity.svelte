<script lang="ts">
  import { trades } from '../stores/trades';
  import { setTab } from '../stores/nav';

  $: recent = ($trades ?? []).slice(0, 5);

  function fmtTime(ts: string): string {
    const d = new Date(ts);
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function sentence(t: typeof recent[number]): string {
    const verb = t.action === 'buy' ? 'Bought' : t.action === 'sell' ? 'Sold' : t.action;
    const amount = (t.amount_eth ?? 0).toFixed(6);
    const symbol = t.symbol ?? '';
    const price = (t.price_usd ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${verb} ${amount} ${symbol} at $${price}`;
  }
</script>

<div class="bg-[var(--bg-card)] rounded-[var(--radius-card)] border border-[var(--border)] shadow-[var(--shadow)] p-4">
  <div class="flex items-center justify-between mb-3">
    <h2 class="text-sm font-semibold font-display text-[var(--text-primary)]">Recent activity</h2>
    <button class="text-xs text-clay hover:text-clay-hover font-medium" on:click={() => setTab('activity')}>View all →</button>
  </div>

  {#if recent.length === 0}
    <p class="text-sm text-[var(--text-muted)] py-2">No trades yet.</p>
  {:else}
    <div class="space-y-2.5">
      {#each recent as t (t.id)}
        <div class="flex items-center justify-between gap-3 text-sm">
          <div class="min-w-0">
            <span class="font-medium" class:text-gain={t.action === 'buy'} class:text-loss={t.action === 'sell'}>
              {sentence(t)}
            </span>
            <span class="text-xs text-[var(--text-muted)] block sm:inline sm:ml-2">{fmtTime(t.timestamp)}</span>
          </div>
          <span
            class="shrink-0 text-[10px] px-1.5 py-0.5 rounded"
            class:bg-warn-soft={!!t.dry_run}
            class:text-warn={!!t.dry_run}
            class:bg-gain-soft={!t.dry_run}
            class:text-gain={!t.dry_run}
          >{t.dry_run ? 'dry' : 'live'}</span>
        </div>
      {/each}
    </div>
  {/if}
</div>
