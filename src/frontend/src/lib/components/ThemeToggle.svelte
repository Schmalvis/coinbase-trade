<script lang="ts">
  import { onMount } from 'svelte';
  import { saveTheme, fetchTheme } from '../api';

  let isDark = true;

  function applyTheme(dark: boolean) {
    if (dark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    window.dispatchEvent(new CustomEvent('themechange', { detail: { dark } }));
  }

  onMount(async () => {
    const stored = localStorage.getItem('theme');
    if (stored) {
      isDark = stored === 'dark';
    } else {
      try {
        const data = await fetchTheme();
        isDark = data.theme === 'dark';
      } catch (e) {
        isDark = true;
      }
    }
    applyTheme(isDark);
  });

  async function toggle() {
    isDark = !isDark;
    applyTheme(isDark);
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    try {
      await saveTheme(isDark ? 'dark' : 'light');
    } catch (e) {
      console.warn('saveTheme failed', e);
    }
  }
</script>

<button
  on:click={toggle}
  class="p-1.5 rounded-[var(--radius-btn)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card-hover)] transition-colors"
  aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
  title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
>
  {#if isDark}
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  {:else}
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  {/if}
</button>
