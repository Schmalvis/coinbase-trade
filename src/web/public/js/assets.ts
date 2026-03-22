// Asset table rendering and inline config management
import { appState } from './state.js';
import { getAuthHeaders, postJSON } from './api.js';
import { renderAssetSelector, populateCandleAssetSelect } from './charts.js';
import { renderHoldings, renderTradePairButtons } from './status.js';

export async function loadAssets() {
  try {
    appState.assetList = await fetch('/api/assets').then(function(r){ return r.json(); });
    renderAssetSelector(); renderHoldings(); renderTradePairButtons(); renderAssets(); renderAssetPills(); populateCandleAssetSelect();
  } catch (e) { console.warn('loadAssets failed', e); }
}

export function renderAssetPills() { renderAssetSelector(); }

export function renderAssets() {
  const tbody = document.getElementById('asset-table-body');
  if (!tbody) return;
  while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

  // Deduplicate by symbol
  const seen: Record<string, boolean> = {};
  const dedupedAssets = appState.assetList.filter(function(a: any) {
    if (seen[a.symbol]) return false;
    seen[a.symbol] = true;
    return true;
  });

  let totalValue = 0;
  dedupedAssets.forEach(function(a: any) { totalValue += (a.balance || 0) * (a.price || 0); });

  dedupedAssets.forEach(function(a: any) {
    const row = document.createElement('tr');
    if (a.status === 'pending') row.className = 'row-pending';
    const isUsdc = a.symbol === 'USDC';
    if (!isUsdc) {
      row.className = (row.className ? row.className + ' ' : '') + 'asset-row-clickable';
      row.onclick = function() { toggleAssetAccordion(a, tbody, row); };
    }
    const value = (a.balance || 0) * (a.price || 0);
    const weightPct = totalValue > 0 ? (value / totalValue * 100) : 0;
    const ch = a.change24h;
    const changeText = ch != null ? (ch >= 0 ? '+' : '') + ch.toFixed(2) + '%' : '--';
    const changeClass = ch == null ? '' : ch >= 0 ? 'change-positive' : 'change-negative';
    const score = appState.scoresData[a.symbol] ? appState.scoresData[a.symbol].score : null;
    const scoreText = score != null ? (score > 0 ? '+' : '') + score.toFixed(1) : '--';
    const scoreColor = score != null ? (score > 0 ? 'color:var(--green)' : score < 0 ? 'color:var(--red)' : '') : '';

    // Symbol
    const td1 = document.createElement('td');
    const strong = document.createElement('strong');
    strong.textContent = a.symbol;
    td1.appendChild(strong);
    row.appendChild(td1);
    // Price
    const td2 = document.createElement('td'); td2.textContent = a.price != null ? '$' + a.price.toFixed(4) : '--'; row.appendChild(td2);
    // Balance
    const td3 = document.createElement('td'); td3.textContent = a.balance != null ? a.balance.toFixed(6) : '--'; row.appendChild(td3);
    // Value
    const td4 = document.createElement('td'); td4.textContent = '$' + value.toFixed(2); row.appendChild(td4);
    // Weight
    const td5 = document.createElement('td');
    td5.textContent = weightPct.toFixed(1) + '%';
    const weightWrap = document.createElement('div');
    weightWrap.className = 'weight-bar-wrap';
    const weightFill = document.createElement('div');
    weightFill.className = 'weight-bar-fill';
    weightFill.style.width = weightPct + '%';
    weightWrap.appendChild(weightFill);
    td5.appendChild(weightWrap);
    row.appendChild(td5);
    // Score
    const td6 = document.createElement('td'); td6.textContent = scoreText; if (scoreColor) td6.style.cssText = scoreColor; row.appendChild(td6);
    // 24h
    const td7 = document.createElement('td'); td7.textContent = changeText; if (changeClass) td7.className = changeClass; row.appendChild(td7);
    // Strategy
    const td8 = document.createElement('td');
    if (a.status === 'active') {
      td8.style.fontSize = '0.72rem';
      const sType = a.strategyConfig ? a.strategyConfig.type || '' : '';
      const dot8 = document.createElement('span'); dot8.style.color = 'var(--green)'; dot8.textContent = '\u25CF'; td8.appendChild(dot8);
      td8.appendChild(document.createTextNode(' ' + sType));
      if (sType === 'grid') {
        const gridBadge = document.createElement('span');
        gridBadge.style.cssText = 'font-size:0.6rem;padding:0.1rem 0.3rem;border-radius:3px;background:var(--blue-lo);color:var(--blue);margin-left:0.3rem;font-weight:600';
        gridBadge.textContent = 'GRID';
        td8.appendChild(gridBadge);
      }
    }
    else if (a.status === 'pending') { td8.textContent = 'new token'; td8.style.color = 'var(--yellow)'; td8.style.fontSize = '0.72rem'; }
    row.appendChild(td8);
    // Actions (for pending only)
    const td9 = document.createElement('td');
    if (a.status === 'pending') {
      const eb = document.createElement('button'); eb.textContent = 'ENABLE'; eb.style.cssText = 'font-size:0.6rem;padding:0.2rem 0.5rem;cursor:pointer;border-radius:4px;border:1px solid var(--green);background:transparent;color:var(--green);font-weight:600'; eb.onclick = function(e){ e.stopPropagation(); toggleAssetAccordion(a, tbody, row); }; td9.appendChild(eb);
      td9.appendChild(document.createTextNode(' '));
      const db = document.createElement('button'); db.textContent = 'DISMISS'; db.style.cssText = 'font-size:0.6rem;padding:0.2rem 0.5rem;cursor:pointer;border-radius:4px;border:1px solid var(--red);background:transparent;color:var(--red);font-weight:600'; db.onclick = function(e){ e.stopPropagation(); dismissAsset(a.address); }; td9.appendChild(db);
    }
    row.appendChild(td9);
    tbody.appendChild(row);

    // If expanded, re-render accordion
    if (appState.expandedAssetAddress === a.address) {
      const cfgRow = buildAccordionRow(a);
      tbody.appendChild(cfgRow);
    }
  });
}

function toggleAssetAccordion(asset: any, tbody: HTMLElement, clickedRow: HTMLElement) {
  if (appState.expandedAssetAddress === asset.address) {
    appState.expandedAssetAddress = null;
    const existing = document.getElementById('asset-accordion-' + asset.address);
    if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
    return;
  }
  if (appState.expandedAssetAddress) {
    const prev = document.getElementById('asset-accordion-' + appState.expandedAssetAddress);
    if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
  }
  appState.expandedAssetAddress = asset.address;
  const cfgRow = buildAccordionRow(asset);
  if (clickedRow.nextSibling) {
    tbody.insertBefore(cfgRow, clickedRow.nextSibling);
  } else {
    tbody.appendChild(cfgRow);
  }
}

function buildAccordionRow(asset: any): HTMLElement {
  const cfgRow = document.createElement('tr');
  cfgRow.className = 'asset-config-row';
  cfgRow.id = 'asset-accordion-' + asset.address;
  const cfgTd = document.createElement('td');
  cfgTd.colSpan = 9;
  const panel = document.createElement('div');
  panel.className = 'asset-config-panel';
  panel.id = 'inline-cfg-' + asset.address;
  buildInlineConfigForm(panel, asset);
  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'asset-config-actions';
  if (asset.status === 'pending') {
    const eb = document.createElement('button'); eb.textContent = 'ENABLE'; eb.style.cssText = 'border:1px solid var(--green);background:transparent;color:var(--green);font-weight:600;cursor:pointer;border-radius:6px;padding:0.3rem 0.8rem'; eb.onclick = function(e){ e.stopPropagation(); enableAsset(asset.address); }; actions.appendChild(eb);
    const db = document.createElement('button'); db.textContent = 'DISMISS'; db.style.cssText = 'border:1px solid var(--red);background:transparent;color:var(--red);font-weight:600;cursor:pointer;border-radius:6px;padding:0.3rem 0.8rem'; db.onclick = function(e){ e.stopPropagation(); dismissAsset(asset.address); }; actions.appendChild(db);
  } else {
    const sb = document.createElement('button'); sb.textContent = 'SAVE'; sb.style.cssText = 'border:1px solid var(--green);background:transparent;color:var(--green);font-weight:600;cursor:pointer;border-radius:6px;padding:0.3rem 0.8rem'; sb.onclick = function(e){ e.stopPropagation(); saveAssetConfig(asset.address); }; actions.appendChild(sb);
    const disb = document.createElement('button'); disb.textContent = 'DISABLE STRATEGY'; disb.style.cssText = 'border:1px solid var(--red);background:transparent;color:var(--red);font-weight:600;cursor:pointer;border-radius:6px;padding:0.3rem 0.8rem'; disb.onclick = function(e){ e.stopPropagation(); dismissAsset(asset.address); }; actions.appendChild(disb);
  }
  panel.appendChild(actions);
  cfgTd.appendChild(panel);
  cfgRow.appendChild(cfgTd);
  return cfgRow;
}

function buildInlineConfigForm(container: HTMLElement, asset: any) {
  const cfg = asset.strategyConfig || {};
  const addr = asset.address;
  // Strategy pills
  const pills = document.createElement('div'); pills.className = 'pill-group'; pills.style.marginBottom = '0.5rem';
  pills.id = 'inline-pills-' + addr;
  ['threshold', 'sma', 'grid'].forEach(function(type) {
    const pill = document.createElement('button');
    pill.className = 'pill' + (cfg.type === type ? ' active' : '');
    pill.textContent = type.toUpperCase(); pill.dataset.strategy = type;
    pill.id = 'cfg-' + addr + '-pill-' + type;
    pill.onclick = function(e) {
      e.preventDefault(); e.stopPropagation();
      pills.querySelectorAll('.pill').forEach(function(p: any){ p.classList.remove('active'); });
      pill.classList.add('active');
      const tf = document.getElementById('threshold-fields-' + addr);
      if (tf) tf.style.display = type === 'threshold' ? 'flex' : 'none';
      const sf = document.getElementById('sma-fields-' + addr);
      if (sf) sf.style.display = type === 'sma' ? 'flex' : 'none';
      const gf = document.getElementById('inline-grid-fields-' + addr);
      if (gf) gf.style.display = type === 'grid' ? '' : 'none';
      const smaT = document.getElementById('sma-toggles-' + addr);
      if (smaT) smaT.style.display = type === 'sma' ? 'flex' : 'none';
    };
    pills.appendChild(pill);
  });
  container.appendChild(pills);

  // Threshold fields
  const thresholdFields = document.createElement('div');
  thresholdFields.id = 'threshold-fields-' + addr;
  thresholdFields.style.cssText = 'display:' + (cfg.type === 'threshold' ? 'flex' : 'none') + ';flex-wrap:wrap;gap:0.5rem';
  [{ id: 'drop', label: 'Buy on drop %', val: cfg.dropPct != null ? cfg.dropPct : 3, step: '0.1', min: '0.1' },
   { id: 'rise', label: 'Sell on rise %', val: cfg.risePct != null ? cfg.risePct : 4, step: '0.1', min: '0.1' }
  ].forEach(function(f) {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:0.3rem';
    const lbl = document.createElement('label'); lbl.textContent = f.label; lbl.style.cssText = 'font-size:0.65rem;color:var(--text-secondary);white-space:nowrap';
    const inp = document.createElement('input'); inp.type = 'number'; inp.id = 'cfg-' + addr + '-' + f.id;
    inp.value = String(f.val); inp.step = f.step; inp.min = f.min;
    inp.style.cssText = 'width:60px;background:var(--bg-primary);border:1px solid var(--border-hi);color:var(--text-primary);border-radius:6px;padding:0.2rem 0.4rem;font-size:0.75rem';
    inp.onclick = function(e){ e.stopPropagation(); };
    row.appendChild(lbl); row.appendChild(inp); thresholdFields.appendChild(row);
  });
  container.appendChild(thresholdFields);

  // SMA fields
  const smaFields = document.createElement('div');
  smaFields.id = 'sma-fields-' + addr;
  smaFields.style.cssText = 'display:' + (cfg.type === 'sma' ? 'flex' : 'none') + ';flex-wrap:wrap;gap:0.5rem';
  [{ id: 'smaShort', label: 'SMA short window', val: cfg.smaShort != null ? cfg.smaShort : 5, step: '1', min: '2' },
   { id: 'smaLong', label: 'SMA long window', val: cfg.smaLong != null ? cfg.smaLong : 20, step: '1', min: '3' }
  ].forEach(function(f) {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:0.3rem';
    const lbl = document.createElement('label'); lbl.textContent = f.label; lbl.style.cssText = 'font-size:0.65rem;color:var(--text-secondary);white-space:nowrap';
    const inp = document.createElement('input'); inp.type = 'number'; inp.id = 'cfg-' + addr + '-' + f.id;
    inp.value = String(f.val); inp.step = f.step; inp.min = f.min;
    inp.style.cssText = 'width:60px;background:var(--bg-primary);border:1px solid var(--border-hi);color:var(--text-primary);border-radius:6px;padding:0.2rem 0.4rem;font-size:0.75rem';
    inp.onclick = function(e){ e.stopPropagation(); };
    row.appendChild(lbl); row.appendChild(inp); smaFields.appendChild(row);
  });
  container.appendChild(smaFields);

  // SMA enhancement toggles
  const smaToggles = document.createElement('div');
  smaToggles.id = 'sma-toggles-' + addr;
  smaToggles.style.cssText = 'margin:0.5rem 0;display:' + (cfg.type === 'sma' ? 'flex' : 'none') + ';gap:1rem;flex-wrap:wrap;font-size:0.72rem;color:var(--text-secondary)';
  function mkToggle(labelText: string, inputId: string, checked: boolean): HTMLElement {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex;align-items:center;gap:0.3rem;cursor:pointer';
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.id = inputId; cb.checked = checked;
    cb.style.cssText = 'accent-color:var(--green)';
    cb.onclick = function(e){ e.stopPropagation(); };
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(labelText));
    return lbl;
  }
  smaToggles.appendChild(mkToggle('Use EMA', 'ema-' + addr, asset.sma_use_ema !== 0));
  smaToggles.appendChild(mkToggle('Volume filter', 'vol-' + addr, asset.sma_volume_filter !== 0));
  smaToggles.appendChild(mkToggle('RSI filter', 'rsi-' + addr, asset.sma_rsi_filter !== 0));
  container.appendChild(smaToggles);

  // Grid-specific fields
  const gridFields = document.createElement('div');
  gridFields.id = 'inline-grid-fields-' + addr;
  gridFields.style.cssText = 'display:' + (cfg.type === 'grid' ? 'flex' : 'none') + ';flex-wrap:wrap;gap:0.5rem;margin-top:0.4rem';
  const gridFieldDefs = [
    { id: 'grid-levels-' + addr, label: 'Grid Levels', val: asset.grid_levels != null ? asset.grid_levels : 10, step: '1', min: '3', max: '50', placeholder: '' },
    { id: 'grid-upper-' + addr, label: 'Upper Bound', val: asset.grid_upper_bound != null ? asset.grid_upper_bound : '', step: '0.01', min: '', max: '', placeholder: 'auto' },
    { id: 'grid-lower-' + addr, label: 'Lower Bound', val: asset.grid_lower_bound != null ? asset.grid_lower_bound : '', step: '0.01', min: '', max: '', placeholder: 'auto' }
  ];
  gridFieldDefs.forEach(function(f) {
    const row = document.createElement('div'); row.style.cssText = 'display:flex;align-items:center;gap:0.3rem';
    const lbl = document.createElement('label'); lbl.textContent = f.label; lbl.style.cssText = 'font-size:0.65rem;color:var(--text-secondary);white-space:nowrap';
    const inp = document.createElement('input'); inp.type = 'number'; inp.id = f.id;
    if (f.val !== '') inp.value = String(f.val);
    if (f.step) inp.step = f.step;
    if (f.min) inp.min = f.min;
    if (f.max) inp.max = f.max;
    if (f.placeholder) inp.placeholder = f.placeholder;
    inp.style.cssText = 'width:80px;background:var(--bg-primary);border:1px solid var(--border-hi);color:var(--text-primary);border-radius:6px;padding:0.2rem 0.4rem;font-size:0.75rem';
    inp.onclick = function(e){ e.stopPropagation(); };
    row.appendChild(lbl); row.appendChild(inp); gridFields.appendChild(row);
  });
  container.appendChild(gridFields);
}

function readConfigForm(address: string): any {
  let strategyType = 'threshold';
  const active = document.querySelector('#inline-pills-' + address + ' .pill.active') as HTMLElement | null;
  if (active && active.dataset && active.dataset.strategy) strategyType = active.dataset.strategy;
  const body: any = {
    strategyType: strategyType,
    dropPct: parseFloat((document.getElementById('cfg-' + address + '-drop') as HTMLInputElement).value),
    risePct: parseFloat((document.getElementById('cfg-' + address + '-rise') as HTMLInputElement).value),
    smaShort: parseInt((document.getElementById('cfg-' + address + '-smaShort') as HTMLInputElement).value),
    smaLong: parseInt((document.getElementById('cfg-' + address + '-smaLong') as HTMLInputElement).value)
  };
  const emaEl = document.getElementById('ema-' + address) as HTMLInputElement | null;
  const volEl = document.getElementById('vol-' + address) as HTMLInputElement | null;
  const rsiEl = document.getElementById('rsi-' + address) as HTMLInputElement | null;
  body.sma_use_ema = emaEl ? (emaEl.checked ? 1 : 0) : 1;
  body.sma_volume_filter = volEl ? (volEl.checked ? 1 : 0) : 1;
  body.sma_rsi_filter = rsiEl ? (rsiEl.checked ? 1 : 0) : 1;
  if (strategyType === 'grid') {
    body.grid_levels = parseInt((document.getElementById('grid-levels-' + address) as HTMLInputElement).value) || 10;
    const upperVal = (document.getElementById('grid-upper-' + address) as HTMLInputElement).value;
    const lowerVal = (document.getElementById('grid-lower-' + address) as HTMLInputElement).value;
    body.grid_upper_bound = upperVal !== '' ? parseFloat(upperVal) : null;
    body.grid_lower_bound = lowerVal !== '' ? parseFloat(lowerVal) : null;
    body.grid_manual_override = (body.grid_upper_bound !== null && body.grid_lower_bound !== null) ? 1 : 0;
  }
  return body;
}

export async function enableAsset(address: string) {
  const params = readConfigForm(address);
  const res = await postJSON('/api/assets/' + address + '/enable', params);
  if (res.ok) { appState.expandedAssetAddress = null; await loadAssets(); } else alert('Error: ' + res.error);
}

export async function dismissAsset(address: string) {
  const res = await postJSON('/api/assets/' + address + '/dismiss', {});
  if (res.ok) { appState.expandedAssetAddress = null; await loadAssets(); } else alert('Error: ' + res.error);
}

export async function saveAssetConfig(address: string) {
  const params = readConfigForm(address);
  const res = await fetch('/api/assets/' + address + '/config', { method: 'PUT', headers: getAuthHeaders(), body: JSON.stringify(params) }).then(function(r){ return r.json(); });
  if (res.ok) { appState.expandedAssetAddress = null; await loadAssets(); } else alert('Error: ' + res.error);
}
