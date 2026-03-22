// Main entry point — imports all modules, sets up init and polling
import { appState } from './state.js';
import { initTheme, toggleTheme } from './theme.js';
import { loadStatus, loadWallet, loadTrades, loadRotations, loadWatchlist, control, openTrade, openFaucet, renderTradePairButtons, setTradeSide, closeModal, closeOnBackdrop, getTradeQuote, confirmTrade, validateEnsoForm, requestFaucetAsset, toggleWalletAddress, addWatchlistItem, switchTradeTab } from './status.js';
import { loadAssets } from './assets.js';
import { loadCandleChart, loadCharts, switchTimeframe, switchChartAsset, initCandleAssetSelectListener } from './charts.js';
import { loadScores } from './scores.js';
import { loadRisk } from './risk.js';
import { loadPerformance } from './performance.js';
import { openSettings, saveSettings, closeSettingsModal, closeSettingsOnBackdrop, selectStrategy, switchTab } from './settings.js';

// Expose functions on window for inline onclick handlers in HTML
const w = window as any;
w.toggleTheme = toggleTheme;
w.openSettings = openSettings;
w.saveSettings = saveSettings;
w.closeSettingsModal = closeSettingsModal;
w.closeSettingsOnBackdrop = closeSettingsOnBackdrop;
w.selectStrategy = selectStrategy;
w.switchTab = switchTab;
w.control = control;
w.openTrade = openTrade;
w.openFaucet = openFaucet;
w.closeModal = closeModal;
w.closeOnBackdrop = closeOnBackdrop;
w.switchTimeframe = switchTimeframe;
w.switchChartAsset = switchChartAsset;
w.getTradeQuote = getTradeQuote;
w.confirmTrade = confirmTrade;
w.validateEnsoForm = validateEnsoForm;
w.requestFaucetAsset = requestFaucetAsset;
w.toggleWalletAddress = toggleWalletAddress;
w.addWatchlistItem = addWatchlistItem;
w.switchTradeTab = switchTradeTab;
w.setTradeSide = setTradeSide;

async function refresh() {
  await Promise.all([loadStatus(), loadCharts(), loadTrades(), loadWallet(), loadAssets(), loadScores(), loadRotations(), loadRisk(), loadWatchlist(), loadPerformance()]);
  const faucetBtn = document.getElementById('faucetBtn');
  if (faucetBtn) faucetBtn.style.display = (appState.activeNetwork && appState.activeNetwork.indexOf('mainnet') !== -1) ? 'none' : 'inline-block';
}
w.refresh = refresh;

// Escape key handler for modals
document.addEventListener('keydown', function(e) {
  if (e.key !== 'Escape') return;
  ['settingsModal','tradeModal','faucetModal'].forEach(function(id) {
    const el = document.getElementById(id);
    if (el && el.style.display !== 'none') {
      if (id === 'settingsModal') closeSettingsModal();
      else closeModal(id);
    }
  });
});

// Init
initTheme();
initCandleAssetSelectListener();
loadAssets();
refresh();
setInterval(refresh, 10000);
setInterval(function(){ loadCandleChart(); }, 60000);
setTimeout(function(){ loadCandleChart(); }, 500);
