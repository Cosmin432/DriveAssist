export function initHUD() {
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div id="hud-alert" class="hud-alert" aria-live="assertive" hidden></div>
    <div id="hud-top-left"       class="hud-box">BRAKE: NONE</div>
    <div id="hud-top-center"     class="hud-box">SPEED: MAINTAIN</div>
    <div id="hud-top-right"      class="hud-box">LANE: KEEP</div>
    <div id="hud-bottom-left"    class="hud-box risk-low">RISK: LOW</div>
    <div id="hud-lane-info"      class="hud-box">LANE 1/2</div>
    <div id="hud-lane-indicator" class="hud-box keep">
      <span class="lane-label">LANE DECISION</span>
      <span class="lane-arrow">&#8679;</span>
      <span class="lane-target">KEEP LANE</span>
    </div>
  `;
  document.body.appendChild(hud);
}

export function updateHUD(data) {
  const d = data.decisions ?? {};
  const l = data.lane_info ?? null;

  const set = (id, text, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    if (cls) el.className = `hud-box ${cls}`;
  };

  set('hud-top-left',    `BRAKE: ${(d.brake  || 'none').toUpperCase()}`,    `hud-box brake-${d.brake || 'none'}`);
  set('hud-top-center',  `SPEED: ${(d.speed  || 'maintain').toUpperCase()}`);
  set('hud-top-right',   `LANE: ${(d.lane   || 'keep').toUpperCase()}`);
  set('hud-bottom-left', `RISK: ${(d.risk   || 'low').toUpperCase()}`,      `hud-box risk-${d.risk || 'low'}`);

  // Lane info box (current lane / total + UFLD metrics when present)
  const laneEl = document.getElementById('hud-lane-info');
  if (laneEl) {
    if (l) {
      const current  = l.current_lane ?? '?';
      const total    = l.num_lanes    ?? '?';
      const mainRoad = l.is_main_road ? ' • MAIN' : '';
      let extra = '';
      if (typeof l.lane_center_offset_px === 'number') {
        extra += ` • off ${l.lane_center_offset_px.toFixed(0)}px`;
      }
      if (typeof l.lane_confidence === 'number') {
        extra += ` • conf ${l.lane_confidence.toFixed(2)}`;
      }
      laneEl.textContent = `LANE ${current}/${total}${mainRoad}${extra}`;
      laneEl.style.display = 'block';
    } else {
      laneEl.style.display = 'none';
    }
  }

  updateLaneIndicator(d.lane || 'keep', l);
  updateDriveAlert(data);
}

let _alertHideTimer = null;

/**
 * Popup brake / viteză doar dacă backend raportează una din cauze:
 * semafor roșu, STOP, vehicul în față (alert_triggers).
 */
function updateDriveAlert(data) {
  const el = document.getElementById('hud-alert');
  if (!el) return;

  const d = data.decisions ?? {};
  const t = data.alert_triggers ?? {};
  const eligible =
    t.vehicle_ahead === true ||
    t.stop_sign === true ||
    t.red_traffic_light === true;

  const strong = d.brake === 'strong';
  const light = d.brake === 'light';
  const dec = d.speed === 'decrease';
  const showBrakeSpeed = eligible && (strong || light || dec);

  if (showBrakeSpeed) {
    clearTimeout(_alertHideTimer);
    el.hidden = false;
    if (t.red_traffic_light || t.stop_sign) {
      el.className = 'hud-alert show alert-strong';
      el.textContent = t.stop_sign ? '⚠ STOP — oprește' : '⚠ Semafor roșu — frână';
    } else {
      el.className = 'hud-alert show alert-warn';
      el.textContent = '⚠ Vehicul în față — redu viteza';
    }
    return;
  }

  if (!el.classList.contains('show')) {
    el.hidden = true;
    return;
  }
  clearTimeout(_alertHideTimer);
  _alertHideTimer = setTimeout(() => {
    el.classList.remove('show', 'alert-strong', 'alert-warn');
    el.textContent = '';
    el.hidden = true;
  }, 600);
}

function updateLaneIndicator(lane, laneInfo) {
  const el = document.getElementById('hud-lane-indicator');
  if (!el) return;

  const arrowEl  = el.querySelector('.lane-arrow');
  const targetEl = el.querySelector('.lane-target');

  const current = laneInfo?.current_lane ?? null;
  const total   = laneInfo?.num_lanes    ?? null;

  if (lane === 'change_left') {
    el.className = 'hud-box change-left';
    arrowEl.innerHTML    = '&#8678;';
    const targetLane     = current ? current - 1 : null;
    targetEl.textContent = targetLane ? `MOVE TO LANE ${targetLane}` : 'CHANGE LEFT';

  } else if (lane === 'change_right') {
    el.className = 'hud-box change-right';
    arrowEl.innerHTML    = '&#8680;';
    const targetLane     = current ? current + 1 : null;
    targetEl.textContent = targetLane && total && targetLane <= total
      ? `MOVE TO LANE ${targetLane}` : 'CHANGE RIGHT';

  } else {
    el.className = 'hud-box keep';
    arrowEl.innerHTML    = '&#8679;';
    targetEl.textContent = current && total ? `STAY IN LANE ${current}` : 'KEEP LANE';
  }
}