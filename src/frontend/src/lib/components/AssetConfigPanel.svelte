<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { AssetData } from '../types';
  import { saveAssetConfig, enableAsset, dismissAsset } from '../api';
  import { loadAssets } from '../stores/assets';

  export let asset: AssetData;

  const dispatch = createEventDispatcher();

  let selectedStrategy = asset.strategyConfig?.type || 'threshold';
  let dropPct = String(asset.strategyConfig?.dropPct ?? 5);
  let risePct = String(asset.strategyConfig?.risePct ?? 5);
  let smaShort = String(asset.strategyConfig?.smaShort ?? 5);
  let smaLong = String(asset.strategyConfig?.smaLong ?? 20);
  let useEma = true;  // default to true — API doesn't return these flags
  let volumeFilter = true;
  let rsiFilter = true;
  let gridLevels = String(asset.strategyConfig?.gridLevels ?? 10);
  let gridUpper = asset.strategyConfig?.gridUpperBound != null ? String(asset.strategyConfig.gridUpperBound) : '';
  let gridLower = asset.strategyConfig?.gridLowerBound != null ? String(asset.strategyConfig.gridLowerBound) : '';

  let saving = false;

  const strategies = ['threshold', 'sma', 'grid'] as const;

  async function handleSave() {
    saving = true;
    try {
      const config = {
        strategyType: selectedStrategy,
        dropPct: parseFloat(dropPct),
        risePct: parseFloat(risePct),
        smaShort: parseInt(smaShort),
        smaLong: parseInt(smaLong),
        sma_use_ema: useEma ? 1 : 0,
        sma_volume_filter: volumeFilter ? 1 : 0,
        sma_rsi_filter: rsiFilter ? 1 : 0,
        grid_levels: parseInt(gridLevels),
        grid_upper_bound: gridUpper ? parseFloat(gridUpper) : null,
        grid_lower_bound: gridLower ? parseFloat(gridLower) : null,
      };
      const res = await saveAssetConfig(asset.address, config);
      if (res.ok) {
        await loadAssets();
        dispatch('saved');
      } else {
        alert('Error: ' + (res.error || 'Unknown error'));
      }
    } finally {
      saving = false;
    }
  }

  async function handleEnable() {
    saving = true;
    try {
      const config = {
        strategyType: selectedStrategy,
        dropPct: parseFloat(dropPct),
        risePct: parseFloat(risePct),
        smaShort: parseInt(smaShort),
        smaLong: parseInt(smaLong),
        sma_use_ema: useEma ? 1 : 0,
        sma_volume_filter: volumeFilter ? 1 : 0,
        sma_rsi_filter: rsiFilter ? 1 : 0,
        grid_levels: parseInt(gridLevels),
        grid_upper_bound: gridUpper ? parseFloat(gridUpper) : null,
        grid_lower_bound: gridLower ? parseFloat(gridLower) : null,
      };
      const res = await enableAsset(asset.address, config);
      if (res.ok) {
        await loadAssets();
        dispatch('saved');
      } else {
        alert('Error: ' + (res.error || 'Unknown error'));
      }
    } finally {
      saving = false;
    }
  }

  async function handleDismiss() {
    saving = true;
    try {
      await dismissAsset(asset.address);
      await loadAssets();
      dispatch('dismissed');
    } finally {
      saving = false;
    }
  }

  async function handleDisable() {
    saving = true;
    try {
      const res = await saveAssetConfig(asset.address, { strategyType: 'none' });
      if (res.ok) {
        await loadAssets();
        dispatch('saved');
      } else {
        alert('Error: ' + (res.error || 'Unknown error'));
      }
    } finally {
      saving = false;
    }
  }
</script>

<div class="p-4 bg-[var(--bg-primary)] border-t border-[var(--border)]">
  <!-- Strategy pills -->
  <div class="flex items-center gap-2 mb-4">
    <span class="text-xs font-medium text-[var(--text-secondary)] mr-2">Strategy</span>
    {#each strategies as s}
      <button
        class="px-3 py-1 text-xs font-semibold rounded-lg border transition-colors uppercase"
        class:bg-accent-blue={selectedStrategy === s}
        class:text-white={selectedStrategy === s}
        class:border-accent-blue={selectedStrategy === s}
        class:border-[var(--border)]={selectedStrategy !== s}
        class:text-[var(--text-secondary)]={selectedStrategy !== s}
        class:hover:border-accent-blue={selectedStrategy !== s}
        on:click={() => (selectedStrategy = s)}
      >
        {s}
      </button>
    {/each}
  </div>

  <!-- Conditional fields -->
  <div class="flex flex-wrap items-end gap-4 mb-4">
    {#if selectedStrategy === 'threshold'}
      <label class="text-xs text-[var(--text-secondary)]">
        Buy on drop %
        <input type="number" step="0.1" bind:value={dropPct}
          class="block w-20 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
      <label class="text-xs text-[var(--text-secondary)]">
        Sell on rise %
        <input type="number" step="0.1" bind:value={risePct}
          class="block w-20 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
    {:else if selectedStrategy === 'sma'}
      <label class="text-xs text-[var(--text-secondary)]">
        Short window
        <input type="number" step="1" bind:value={smaShort}
          class="block w-20 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
      <label class="text-xs text-[var(--text-secondary)]">
        Long window
        <input type="number" step="1" bind:value={smaLong}
          class="block w-20 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
      <div class="flex items-center gap-3 ml-2">
        <label class="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" bind:checked={useEma} class="accent-accent-green" />
          Use EMA
        </label>
        <label class="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" bind:checked={volumeFilter} class="accent-accent-green" />
          Volume filter
        </label>
        <label class="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" bind:checked={rsiFilter} class="accent-accent-green" />
          RSI filter
        </label>
      </div>
    {:else if selectedStrategy === 'grid'}
      <label class="text-xs text-[var(--text-secondary)]">
        Grid Levels
        <input type="number" step="1" bind:value={gridLevels}
          class="block w-20 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
      <label class="text-xs text-[var(--text-secondary)]">
        Upper Bound
        <input type="number" step="0.01" bind:value={gridUpper} placeholder="auto"
          class="block w-24 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
      <label class="text-xs text-[var(--text-secondary)]">
        Lower Bound
        <input type="number" step="0.01" bind:value={gridLower} placeholder="auto"
          class="block w-24 mt-1 bg-[var(--bg-primary)] border border-[var(--border-hi)] text-[var(--text-primary)] rounded-lg px-2 py-1 text-sm" />
      </label>
    {/if}
  </div>

  <!-- Action buttons -->
  <div class="flex items-center gap-3">
    {#if asset.status === 'pending'}
      <button
        class="border border-accent-green text-accent-green hover:bg-accent-green/10 font-semibold rounded-lg px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
        on:click={handleEnable}
        disabled={saving}
      >
        {saving ? 'Saving...' : 'ENABLE'}
      </button>
      <button
        class="border border-accent-red text-accent-red hover:bg-accent-red/10 font-semibold rounded-lg px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
        on:click={handleDismiss}
        disabled={saving}
      >
        DISMISS
      </button>
    {:else}
      <button
        class="border border-accent-green text-accent-green hover:bg-accent-green/10 font-semibold rounded-lg px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
        on:click={handleSave}
        disabled={saving}
      >
        {saving ? 'Saving...' : 'SAVE'}
      </button>
      <button
        class="border border-accent-red text-accent-red hover:bg-accent-red/10 font-semibold rounded-lg px-4 py-1.5 text-sm transition-colors disabled:opacity-50"
        on:click={handleDisable}
        disabled={saving}
      >
        DISABLE STRATEGY
      </button>
    {/if}
  </div>
</div>
