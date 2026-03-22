<script lang="ts">
  import { onMount } from 'svelte';
  import Header from './lib/components/Header.svelte';
  import AssetsTable from './lib/components/AssetsTable.svelte';
  import NetworkSelector from './lib/components/NetworkSelector.svelte';
  import ThemeToggle from './lib/components/ThemeToggle.svelte';
  import { startPolling } from './lib/stores/polling';
  import CandleChart from './lib/components/CandleChart.svelte';
  import ScoresPanel from './lib/components/ScoresPanel.svelte';
  import RiskMonitor from './lib/components/RiskMonitor.svelte';
  import PerformancePanel from './lib/components/PerformancePanel.svelte';

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

  <!-- Chart and scores row -->
  <div class="px-4 mt-4 flex gap-4 flex-col lg:flex-row">
    <div class="flex-[2]"><CandleChart /></div>
    <div class="flex-1"><ScoresPanel /></div>
  </div>

  <!-- Performance and risk panels -->
  <div class="px-4 mt-4"><PerformancePanel /></div>
  <div class="px-4 mt-4"><RiskMonitor /></div>
</div>
