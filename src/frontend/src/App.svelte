<script lang="ts">
  import { onMount } from 'svelte';
  import Header from './lib/components/Header.svelte';
  import AssetsTable from './lib/components/AssetsTable.svelte';
  import NetworkSelector from './lib/components/NetworkSelector.svelte';
  import ThemeToggle from './lib/components/ThemeToggle.svelte';
  import { startPolling } from './lib/stores/polling';

  onMount(() => {
    startPolling(5000);
  });
</script>

<div class="min-h-screen">
  <!-- Top bar -->
  <header class="flex items-center justify-between px-5 py-3 border-b border-[var(--border)]">
    <div>
      <span class="text-lg font-semibold">Trade Bot</span>
      <span class="text-sm font-normal text-[var(--text-secondary)] ml-1">/ autonomous</span>
    </div>
    <div class="flex items-center gap-3">
      <NetworkSelector />
      <ThemeToggle />
    </div>
  </header>

  <!-- Status cards -->
  <Header />

  <!-- Assets table with inline config -->
  <div class="px-4">
    <AssetsTable />
  </div>

  <!-- Placeholder for remaining panels -->
  <div class="p-4 text-[var(--text-muted)] text-sm">More panels coming...</div>
</div>
