export function initHUD() {
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
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

  // Lane info box (current lane / total)
  const laneEl = document.getElementById('hud-lane-info');
  if (laneEl) {
    if (l) {
      const current  = l.current_lane ?? '?';
      const total    = l.num_lanes    ?? '?';
      const mainRoad = l.is_main_road ? ' • MAIN' : '';
      laneEl.textContent = `LANE ${current}/${total}${mainRoad}`;
      laneEl.style.display = 'block';
    } else {
      laneEl.style.display = 'none';
    }
  }

  updateLaneIndicator(d.lane || 'keep', l);
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