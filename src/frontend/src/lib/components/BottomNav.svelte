<script lang="ts">
  import { activeTab, setTab } from '../stores/nav';
  import type { TabId } from '../stores/nav';

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'assets', label: 'Assets' },
    { id: 'activity', label: 'Activity' },
    { id: 'advanced', label: 'Advanced' },
  ];

  const icons: Record<TabId, string> = {
    overview: 'M3 11.5 12 4l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    assets: 'M12 3c-4.4 0-8 1.35-8 3s3.6 3 8 3 8-1.35 8-3-3.6-3-8-3zM4 8.5V12c0 1.65 3.6 3 8 3s8-1.35 8-3V8.5M4 13v3.5c0 1.65 3.6 3 8 3s8-1.35 8-3V13',
    activity: 'M4 5h16M4 10h16M4 15h10M4 20h10',
    advanced: 'M4 6h6M14 6h6M4 12h10M18 12h2M4 18h2M10 18h10M6 4v4M16 10v4M8 16v4',
  };
</script>

<nav
  class="md:hidden fixed bottom-0 left-0 right-0 z-40 flex bg-[var(--bg-card)] border-t border-[var(--border)]"
  style="height: calc(56px + env(safe-area-inset-bottom)); padding-bottom: env(safe-area-inset-bottom);"
>
  {#each tabs as tab}
    <button
      class="flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors"
      class:text-clay={$activeTab === tab.id}
      class:text-[var(--text-muted)]={$activeTab !== tab.id}
      on:click={() => setTab(tab.id)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d={icons[tab.id]} />
      </svg>
      {tab.label}
    </button>
  {/each}
</nav>
