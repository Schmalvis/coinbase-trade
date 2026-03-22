// Risk monitor panel
export async function loadRisk() {
  try {
    const r = await fetch('/api/risk').then(function(r){ return r.json(); });
    const riskPlaceholder = document.getElementById('riskPlaceholder');
    const riskContent = document.getElementById('riskContent');
    if (riskPlaceholder) riskPlaceholder.style.display = 'none';
    if (riskContent) riskContent.style.display = 'flex';

    // Daily P&L
    const pnl = r.daily_pnl != null ? r.daily_pnl : 0;
    const pnlLimit = r.daily_pnl_limit != null ? r.daily_pnl_limit : 100;
    const pnlPct = pnlLimit > 0 ? Math.min(100, Math.abs(pnl) / pnlLimit * 100) : 0;
    const riskPnl = document.getElementById('riskPnl');
    if (riskPnl) {
      riskPnl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2);
      riskPnl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    }
    const riskPnlBar = document.getElementById('riskPnlBar') as HTMLElement | null;
    if (riskPnlBar) {
      riskPnlBar.style.width = pnlPct + '%';
      riskPnlBar.style.background = pnl >= 0 ? 'var(--green)' : 'var(--red)';
    }

    // Rotations today
    const rotToday = r.rotations_today != null ? r.rotations_today : 0;
    const rotMax = r.max_daily_rotations != null ? r.max_daily_rotations : 10;
    const riskRotations = document.getElementById('riskRotations');
    if (riskRotations) riskRotations.textContent = rotToday + ' / ' + rotMax;
    const riskRotBar = document.getElementById('riskRotBar') as HTMLElement | null;
    if (riskRotBar) riskRotBar.style.width = (rotMax > 0 ? rotToday / rotMax * 100 : 0) + '%';

    // Max position
    const maxPos = r.max_position_pct != null ? r.max_position_pct : 0;
    const maxPosLimit = r.max_position_limit != null ? r.max_position_limit : 40;
    const riskMaxPos = document.getElementById('riskMaxPos');
    if (riskMaxPos) riskMaxPos.textContent = maxPos.toFixed(1) + '% / ' + maxPosLimit.toFixed(0) + '%';
    const riskPosBar = document.getElementById('riskPosBar') as HTMLElement | null;
    if (riskPosBar) riskPosBar.style.width = (maxPosLimit > 0 ? Math.min(100, maxPos / maxPosLimit * 100) : 0) + '%';

    // Portfolio floor
    const floor = r.portfolio_floor != null ? r.portfolio_floor : 100;
    const current = r.portfolio_usd != null ? r.portfolio_usd : 0;
    const riskFloor = document.getElementById('riskFloor');
    if (riskFloor) riskFloor.textContent = '$' + current.toFixed(0) + ' / $' + floor.toFixed(0);
    const floorPct = floor > 0 ? Math.min(100, current / floor * 100) : 100;
    const riskFloorBar = document.getElementById('riskFloorBar') as HTMLElement | null;
    if (riskFloorBar) {
      riskFloorBar.style.width = floorPct + '%';
      riskFloorBar.style.background = floorPct < 110 ? 'var(--red)' : 'var(--green)';
    }

    // Optimizer status
    const optStatus = r.optimizer_status != null ? r.optimizer_status : 'disabled';
    const optEl = document.getElementById('riskOptStatus');
    if (optEl) {
      optEl.textContent = optStatus.charAt(0).toUpperCase() + optStatus.slice(1);
      optEl.style.color = optStatus === 'active' ? 'var(--green)' : optStatus === 'risk-off' ? 'var(--red)' : 'var(--text-secondary)';
    }
  } catch (e) { console.warn('loadRisk:', e); }
}
