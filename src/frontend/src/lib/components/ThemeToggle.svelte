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
  class="px-3 py-1 rounded-lg border border-[var(--border)] text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
>
  {isDark ? 'Light' : 'Dark'}
</button>
