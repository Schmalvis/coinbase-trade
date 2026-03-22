<script lang="ts">
  import { assets } from '../stores/assets';

  $: holdings = $assets.filter(
    a => a.symbol !== 'ETH' && a.symbol !== 'USDC' && a.balance > 0
  );
</script>

{#if holdings.length > 0}
  <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
    {#each holdings as asset}
      <div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4">
        <div class="text-xs font-medium uppercase text-[var(--text-secondary)]">{asset.symbol}</div>
        <div class="text-lg font-semibold mt-1">
          {asset.balance.toFixed(asset.balance < 1 ? 6 : 2)}
        </div>
        <div class="text-xs text-[var(--text-muted)]">${asset.value.toFixed(2)}</div>
      </div>
    {/each}
  </div>
{/if}
