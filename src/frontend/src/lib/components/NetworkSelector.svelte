<script lang="ts">
  import { onMount } from 'svelte';
  import { fetchNetworks, switchNetwork } from '../api';
  import { loadStatus } from '../stores/status';

  let networks: string[] = [];
  let active = '';

  onMount(async () => {
    try {
      const data = await fetchNetworks();
      networks = data.available ?? data.networks ?? [];
      active = data.active ?? '';
    } catch (e) {
      console.warn('fetchNetworks failed', e);
    }
  });

  async function select(network: string) {
    if (network === active) return;
    try {
      await switchNetwork(network);
      active = network;
      await loadStatus();
    } catch (e) {
      console.warn('switchNetwork failed', e);
    }
  }
</script>

<div class="flex items-center gap-1">
  {#each networks as network}
    <button
      on:click={() => select(network)}
      class="px-3 py-1 rounded-lg border text-sm font-medium transition-colors
        {network === active
          ? 'border-accent-green text-accent-green'
          : 'border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}"
    >
      {network}
    </button>
  {/each}
</div>
