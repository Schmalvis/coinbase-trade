<script lang="ts">
  import { onMount } from 'svelte';
  import { startPolling } from './lib/stores/polling';
  import { status } from './lib/stores/status';
  import { activeTab } from './lib/stores/nav';
  import { logout } from './lib/api';

  import TabBar from './lib/components/TabBar.svelte';
  import BottomNav from './lib/components/BottomNav.svelte';
  import HeroCard from './lib/components/HeroCard.svelte';
  import PnlTiles from './lib/components/PnlTiles.svelte';
  import PerformancePanel from './lib/components/PerformancePanel.svelte';
  import HoldingsList from './lib/components/HoldingsList.svelte';
  import RecentActivity from './lib/components/RecentActivity.svelte';
  import RiskBanner from './lib/components/RiskBanner.svelte';

  import AssetsTable from './lib/components/AssetsTable.svelte';
  import CandleChart from './lib/components/CandleChart.svelte';

  import ScoresPanel from './lib/components/ScoresPanel.svelte';
  import RiskMonitor from './lib/components/RiskMonitor.svelte';
  import RotationLog from './lib/components/RotationLog.svelte';

  import TradeHistory from './lib/components/TradeHistory.svelte';

  import NetworkSelector from './lib/components/NetworkSelector.svelte';
  import ThemeToggle from './lib/components/ThemeToggle.svelte';
  import SettingsModal from './lib/components/SettingsModal.svelte';
  import TradeModal from './lib/components/TradeModal.svelte';

  let settingsOpen = false;
  let tradeOpen = false;
  let overflowOpen = false;

  onMount(() => {
    startPolling(5000);
  });

  async function handleLogout() {
    try { await logout(); } catch {}
    window.location.href = '/auth/login';
  }

  $: isRunning = $status?.status === 'running';
</script>

<div class="min-h-screen pb-16 md:pb-0">
  <!-- Header -->
  <header class="sticky top-0 z-30 bg-[var(--bg-primary)]/90 backdrop-blur border-b border-[var(--border)]">
    <div class="max-w-6xl mx-auto px-4 sm:px-6 flex items-center justify-between py-3 gap-2">
      <div class="flex items-center gap-2">
        <span
          class="w-2 h-2 rounded-full"
          class:bg-gain={isRunning}
          class:bg-warn={!isRunning}
        ></span>
        <span class="font-display text-lg text-[var(--text-primary)]">Trade Bot</span>
      </div>

      <!-- Desktop controls -->
      <div class="hidden sm:flex items-center gap-2">
        <NetworkSelector />
        <ThemeToggle />
        <button
          class="px-3 py-1.5 rounded-[var(--radius-btn)] text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
          on:click={() => { settingsOpen = true; }}
        >Settings</button>
        <button
          class="px-3 py-1.5 rounded-[var(--radius-btn)] text-sm border border-[var(--border-hi)] text-[var(--text-secondary)] hover:text-loss transition-colors"
          on:click={handleLogout}
        >Logout</button>
      </div>

      <!-- Mobile overflow menu -->
      <div class="relative sm:hidden">
        <button
          class="px-2.5 py-1.5 rounded-[var(--radius-btn)] border border-[var(--border-hi)] text-[var(--text-secondary)]"
          on:click={() => overflowOpen = !overflowOpen}
          aria-label="More options"
        >⋯</button>
        {#if overflowOpen}
          <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
          <div class="fixed inset-0 z-40" on:click={() => overflowOpen = false}></div>
          <div class="absolute right-0 top-full mt-2 z-50 w-48 bg-[var(--bg-card)] border border-[var(--border)] rounded-[var(--radius-card)] shadow-[var(--shadow)] p-2 flex flex-col gap-2">
            <div class="px-1"><NetworkSelector /></div>
            <div class="px-1"><ThemeToggle /></div>
            <button
              class="text-left px-2 py-1.5 rounded-[var(--radius-btn)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors"
              on:click={() => { settingsOpen = true; overflowOpen = false; }}
            >Settings</button>
            <button
              class="text-left px-2 py-1.5 rounded-[var(--radius-btn)] text-sm text-[var(--text-secondary)] hover:text-loss hover:bg-[var(--bg-card-hover)] transition-colors"
              on:click={handleLogout}
            >Logout</button>
          </div>
        {/if}
      </div>
    </div>

    <TabBar />
  </header>

  <main class="max-w-6xl mx-auto px-4 sm:px-6 py-4">
    <!-- Overview -->
    <div class:hidden={$activeTab !== 'overview'}>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="order-1 lg:col-span-2">
          <HeroCard on:trade={() => tradeOpen = true} />
        </div>
        <div class="order-4 lg:order-2 lg:col-span-1">
          <PnlTiles />
        </div>
        <div class="order-2 lg:order-3 lg:col-span-3 empty:hidden">
          <RiskBanner />
        </div>
        <div class="order-3 lg:order-4 lg:col-span-2">
          <PerformancePanel />
        </div>
        <div class="order-5 lg:col-span-1">
          <HoldingsList />
        </div>
        <div class="order-6 lg:col-span-3">
          <RecentActivity />
        </div>
      </div>
    </div>

    <!-- Assets -->
    <div class:hidden={$activeTab !== 'assets'}>
      <div class="space-y-4">
        <AssetsTable />
        <CandleChart />
      </div>
    </div>

    <!-- Activity -->
    <div class:hidden={$activeTab !== 'activity'}>
      <TradeHistory />
    </div>

    <!-- Advanced -->
    <div class:hidden={$activeTab !== 'advanced'}>
      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div class="lg:col-span-1"><ScoresPanel /></div>
        <div class="lg:col-span-2"><RiskMonitor /></div>
        <div class="lg:col-span-3"><RotationLog /></div>
      </div>
    </div>
  </main>

  <BottomNav />
</div>

{#if settingsOpen}
  <SettingsModal open={settingsOpen} on:close={() => settingsOpen = false} />
{/if}
{#if tradeOpen}
  <TradeModal open={tradeOpen} on:close={() => tradeOpen = false} />
{/if}
