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
  import SettingsModal from './lib/components/SettingsModal.svelte';
  import ActionButtons from './lib/components/ActionButtons.svelte';
  import TradeModal from './lib/components/TradeModal.svelte';
  import HoldingsGrid from './lib/components/HoldingsGrid.svelte';
  import { logout } from './lib/api';

  let settingsOpen = false;
  let tradeOpen = false;

  onMount(() => {
    startPolling(5000);
  });

  async function handleLogout() {
    try { await logout(); } catch {}
    window.location.href = '/auth/login';
  }
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
      <button
        class="px-3 py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
        on:click={() => { settingsOpen = true; }}
      >Settings</button>
      <button
        class="px-3 py-1.5 rounded-lg text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-red-400 transition-colors"
        on:click={handleLogout}
      >Logout</button>
    </div>
  </header>

  <!-- Status cards -->
  <Header />

  <!-- Holdings grid (non-ETH/USDC assets) -->
  <div class="px-4 mt-2"><HoldingsGrid /></div>

  <!-- Assets table with inline config -->
  <div class="px-4">
    <AssetsTable />
  </div>

  <!-- Action buttons -->
  <div class="px-4 mt-3">
    <ActionButtons on:trade={() => tradeOpen = true} />
  </div>

  <!-- Chart and scores row -->
  <div class="px-4 mt-4 flex gap-4 flex-col lg:flex-row">
    <div class="flex-[2]"><CandleChart /></div>
    <div class="flex-1"><ScoresPanel /></div>
  </div>

  <!-- Performance and risk panels -->
  <div class="px-4 mt-4"><PerformancePanel /></div>
  <div class="px-4 mt-4 pb-8"><RiskMonitor /></div>
</div>

{#if settingsOpen}
  <SettingsModal open={settingsOpen} on:close={() => settingsOpen = false} />
{/if}
{#if tradeOpen}
  <TradeModal open={tradeOpen} on:close={() => tradeOpen = false} />
{/if}
