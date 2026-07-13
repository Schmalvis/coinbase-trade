import { writable } from 'svelte/store';

export type TabId = 'overview' | 'assets' | 'activity' | 'advanced';

const TABS: TabId[] = ['overview', 'assets', 'activity', 'advanced'];

function tabFromHash(): TabId {
  const hash = (typeof location !== 'undefined' ? location.hash : '').replace(/^#\/?/, '');
  return (TABS as string[]).includes(hash) ? (hash as TabId) : 'overview';
}

export const activeTab = writable<TabId>(tabFromHash());

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    activeTab.set(tabFromHash());
  });
}

export function setTab(tab: TabId) {
  activeTab.set(tab);
  if (typeof history !== 'undefined') {
    history.pushState(null, '', `#/${tab}`);
  }
}
