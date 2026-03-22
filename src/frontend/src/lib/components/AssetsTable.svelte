<script lang="ts">
  import { assets } from '../stores/assets';
  import { scores } from '../stores/scores';
  import AssetConfigPanel from './AssetConfigPanel.svelte';

  let expandedAddress: string | null = null;

  function toggleRow(address: string) {
    expandedAddress = expandedAddress === address ? null : address;
  }

  function formatPrice(price: number | null | undefined): string {
    if (price == null) return '--';
    if (price >= 1) return '$' + price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return '$' + price.toPrecision(4);
  }

  function formatValue(val: number | null | undefined): string {
    if (val == null) return '--';
    return '$' + val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function formatBalance(bal: number | null | undefined): string {
    if (bal == null) return '--';
    if (bal >= 1) return bal.toLocaleString(undefined, { maximumFractionDigits: 4 });
    return bal.toPrecision(4);
  }

  function formatChange(change: number | null | undefined): string {
    if (change == null) return '--';
    const sign = change >= 0 ? '+' : '';
    return sign + change.toFixed(2) + '%';
  }

  // Compute total portfolio value for weight calculation
  $: totalValue = ($assets ?? []).reduce((sum, a) => {
    const p = a.price ?? 0;
    const b = a.balance ?? 0;
    return sum + p * b;
  }, 0);

  // Build score lookup from scores store
  $: scoreMap = new Map(($scores ?? []).map(s => [s.symbol, s.score]));

  function getWeight(asset: { price: number | null; balance: number | null }): number {
    if (totalValue === 0) return 0;
    return ((asset.price ?? 0) * (asset.balance ?? 0)) / totalValue * 100;
  }

  function getScore(symbol: string): number | null {
    return scoreMap.get(symbol) ?? null;
  }

  function onSaved() {
    expandedAddress = null;
  }

  function onDismissed() {
    expandedAddress = null;
  }
</script>

<div class="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] overflow-hidden">
  <div class="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)] p-4 pb-2">
    Assets
  </div>

  <table class="w-full">
    <thead>
      <tr class="text-xs font-medium text-[var(--text-secondary)] border-b border-[var(--border)]">
        <th class="px-4 py-2 text-left">Asset</th>
        <th class="px-4 py-2 text-right">Price</th>
        <th class="px-4 py-2 text-right">Balance</th>
        <th class="px-4 py-2 text-right">Value</th>
        <th class="px-4 py-2 text-left">Weight</th>
        <th class="px-4 py-2 text-right">Score</th>
        <th class="px-4 py-2 text-right">24H</th>
        <th class="px-4 py-2 text-left">Strategy</th>
      </tr>
    </thead>
    <tbody>
      {#each $assets ?? [] as asset (asset.address)}
        {@const value = (asset.price ?? 0) * (asset.balance ?? 0)}
        {@const weight = getWeight(asset)}
        {@const score = getScore(asset.symbol)}
        {@const strategy = asset.strategyConfig?.type ?? 'threshold'}
        <tr
          class="border-b border-[var(--border)] hover:bg-[var(--bg-card-hover)] cursor-pointer transition-colors"
          on:click={() => toggleRow(asset.address)}
        >
          <td class="px-4 py-3 text-sm">
            <span class="font-semibold text-[var(--text-primary)]">{asset.symbol}</span>
            <span class="text-[var(--text-muted)] ml-1 text-xs">{asset.name ?? ''}</span>
          </td>
          <td class="px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatPrice(asset.price)}
          </td>
          <td class="px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatBalance(asset.balance)}
          </td>
          <td class="px-4 py-3 text-sm text-right text-[var(--text-primary)]">
            {formatValue(value)}
          </td>
          <td class="px-4 py-3 text-sm">
            <span class="text-[var(--text-primary)]">{weight.toFixed(1)}%</span>
            <div class="w-16 h-1 bg-[var(--border)] rounded-full mt-1 inline-block ml-1 align-middle">
              <div class="h-full bg-accent-blue rounded-full" style="width: {Math.min(weight, 100)}%"></div>
            </div>
          </td>
          <td
            class="px-4 py-3 text-sm text-right font-semibold"
            class:text-accent-green={score != null && score > 0}
            class:text-accent-red={score != null && score < 0}
            class:text-[var(--text-muted)]={score == null || score === 0}
          >
            {score != null ? score.toFixed(1) : '--'}
          </td>
          <td
            class="px-4 py-3 text-sm text-right"
            class:text-accent-green={asset.change24h != null && asset.change24h > 0}
            class:text-accent-red={asset.change24h != null && asset.change24h < 0}
            class:text-[var(--text-muted)]={asset.change24h == null}
          >
            {formatChange(asset.change24h)}
          </td>
          <td class="px-4 py-3 text-sm">
            {#if asset.status === 'pending'}
              <span class="text-xs font-bold px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-400">PENDING</span>
            {:else}
              <span class="inline-block w-2 h-2 rounded-full bg-accent-green mr-1"></span>
              <span class="text-[var(--text-primary)]">{strategy}</span>
              {#if strategy === 'grid'}
                <span class="ml-1 text-[10px] font-bold px-1.5 py-0.5 rounded bg-accent-blue/20 text-accent-blue">GRID</span>
              {/if}
            {/if}
          </td>
        </tr>
        {#if expandedAddress === asset.address}
          <tr>
            <td colspan="8" class="p-0">
              <AssetConfigPanel {asset} on:saved={onSaved} on:dismissed={onDismissed} />
            </td>
          </tr>
        {/if}
      {/each}
    </tbody>
  </table>

  {#if ($assets ?? []).length === 0}
    <div class="p-6 text-center text-sm text-[var(--text-muted)]">No assets found</div>
  {/if}
</div>
