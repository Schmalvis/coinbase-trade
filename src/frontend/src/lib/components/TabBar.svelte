<script lang="ts">
  import { activeTab, setTab } from '../stores/nav';
  import type { TabId } from '../stores/nav';

  const tabs: Array<{ id: TabId; label: string }> = [
    { id: 'overview', label: 'Overview' },
    { id: 'assets', label: 'Assets' },
    { id: 'activity', label: 'Activity' },
    { id: 'advanced', label: 'Advanced' },
  ];
</script>

<nav class="hidden md:flex items-center gap-1 border-b border-[var(--border)] px-6">
  {#each tabs as tab}
    <button
      class="relative px-3 py-3 text-sm font-medium transition-colors"
      class:text-[var(--text-primary)]={$activeTab === tab.id}
      class:text-[var(--text-secondary)]={$activeTab !== tab.id}
      on:click={() => setTab(tab.id)}
    >
      {tab.label}
      {#if $activeTab === tab.id}
        <span class="absolute left-0 right-0 -bottom-px h-0.5 bg-clay rounded-full"></span>
      {/if}
    </button>
  {/each}
</nav>
