/* ═══════════════════════════════════════════════════════════
   HUD — Drive-Assist  (enhanced)
   Consumes every field the backend emits:
     decisions, lane_info, detections, alert_triggers,
     timestamp, frame
   ═══════════════════════════════════════════════════════════ */

/* ── DOM scaffold ─────────────────────────────────────────── */
export function initHUD() {
  if (document.getElementById('hud')) return;

  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div id="hud-scanlines" aria-hidden="true"></div>

    <!-- ── TOP BAR ─────────────────────────────── -->
    <div id="hud-topbar">
      <div class="tb-section">
        <span class="tb-label">SYSTEM</span>
        <span id="tb-conn" class="tb-conn tb-connecting">◉ CONNECTING</span>
      </div>
      <div class="tb-section tb-center-section">
        <span class="tb-title">DRIVE-ASSIST</span>
        <div id="tb-meta-row">
          <span id="tb-frame" class="tb-meta">F:0000</span>
          <span class="tb-sep">|</span>
          <span id="tb-ts"    class="tb-meta">T:0.00s</span>
          <span class="tb-sep">|</span>
          <span id="tb-fps"   class="tb-meta">-- FPS</span>
        </div>
      </div>
      <div class="tb-section tb-right">
        <span class="tb-label">RISK</span>
        <span id="tb-risk" class="risk-chip risk-low">● LOW</span>
      </div>
    </div>

    <!-- ── FULL-WIDTH ALERT ────────────────────── -->
    <div id="hud-alert" class="hud-alert" aria-live="assertive" hidden></div>

    <!-- ── LEFT COLUMN ────────────────────────── -->
    <div id="hud-left-col">
      <div class="hud-panel" id="panel-speed">
        <div class="panel-label">SPEED</div>
        <canvas id="speed-gauge" width="130" height="72"></canvas>
        <div id="speed-mode" class="speed-mode maintain">MAINTAIN</div>
      </div>

      <div class="hud-panel" id="panel-brake">
        <div class="panel-label">BRAKE</div>
        <div id="brake-bar-wrap">
          <div class="brake-seg" id="bseg-none">NONE</div>
          <div class="brake-seg" id="bseg-light">LIGHT</div>
          <div class="brake-seg" id="bseg-strong">STRONG</div>
        </div>
      </div>

      <div class="hud-panel" id="panel-lane">
        <div class="panel-label">LANE POSITION</div>
        <canvas id="lane-canvas" width="180" height="52"></canvas>
        <div id="lane-offset-text" class="lane-meta"></div>
        <div id="lane-conf-text"   class="lane-meta"></div>
      </div>
    </div>

    <!-- ── RIGHT COLUMN ───────────────────────── -->
    <div id="hud-right-col">
      <div class="hud-panel" id="panel-lci">
        <div class="panel-label">LANE DECISION</div>
        <div id="lci-inner" class="lci keep">
          <span id="lci-arrow" class="lci-arrow">&#8679;</span>
          <span id="lci-text"  class="lci-text">KEEP LANE</span>
        </div>
      </div>

      <div class="hud-panel" id="panel-radar">
        <div class="panel-label">SURROUNDINGS</div>
        <canvas id="radar-canvas" width="190" height="190"></canvas>
      </div>
    </div>

    <!-- ── BOTTOM BAR ─────────────────────────── -->
    <div id="hud-bottombar">
      <div id="hud-threat-list"></div>
      <div id="hud-lane-chips">
        <span id="chip-lane-num"   class="info-chip">LANE —</span>
        <span id="chip-main-road"  class="info-chip chip-main" hidden>MAIN ROAD</span>
        <span id="chip-confidence" class="info-chip">CONF —</span>
      </div>
    </div>
  `;
  document.body.appendChild(hud);

  _initSpeedGauge();
  _initRadar();
  _startFpsCounter();
}

/* ── Public update entry-point ────────────────────────────── */
export function updateHUD(data) {
  const d   = data.decisions      ?? {};
  const l   = data.lane_info      ?? null;
  const det = data.detections     ?? [];
  const t   = data.alert_triggers ?? {};

  _updateTopBar(data);
  _updateBrake(d.brake   || 'none');
  _updateSpeedMode(d.speed || 'maintain');
  _updateRiskChip(d.risk  || 'low');
  _updateLanePanel(l);
  _updateLCI(d.lane || 'keep', l);
  _updateRadar(det, l, d);
  _updateThreatList(det, t);
  _updateAlert(d, t);
  _updateBottomChips(l);
}

/* ── Connection state ─────────────────────────────────────── */
export function setHUDConnected(ok) {
  const el = document.getElementById('tb-conn');
  if (!el) return;
  if (ok) {
    el.className = 'tb-conn tb-online';
    el.textContent = '◉ LIVE';
  } else {
    el.className = 'tb-conn tb-offline';
    el.textContent = '◉ OFFLINE';
  }
}

/* ═══════════════════════════════════════════════════════════
   TOP BAR
   ═══════════════════════════════════════════════════════════ */
function _updateTopBar({ frame, timestamp }) {
  const f  = document.getElementById('tb-frame');
  const ts = document.getElementById('tb-ts');
  if (f)  f.textContent = `F:${String(frame ?? 0).padStart(4, '0')}`;
  if (ts) ts.textContent = `T:${Number(timestamp ?? 0).toFixed(2)}s`;
}

let _fpsFrames = 0, _fpsLast = performance.now();
function _startFpsCounter() {
  function tick() {
    _fpsFrames++;
    const now = performance.now();
    if (now - _fpsLast >= 1000) {
      const el = document.getElementById('tb-fps');
      if (el) el.textContent = `${_fpsFrames} FPS`;
      _fpsFrames = 0;
      _fpsLast = now;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/* ═══════════════════════════════════════════════════════════
   BRAKE PANEL
   ═══════════════════════════════════════════════════════════ */
function _updateBrake(brake) {
  ['none', 'light', 'strong'].forEach(lvl => {
    const el = document.getElementById(`bseg-${lvl}`);
    if (!el) return;
    el.className = `brake-seg${brake === lvl ? ` brake-active brake-${lvl}` : ''}`;
  });
}

/* ═══════════════════════════════════════════════════════════
   SPEED GAUGE  (canvas arc)
   ═══════════════════════════════════════════════════════════ */
let _gaugeCtx    = null;
let _gaugeTarget = 0.5;
let _gaugeValue  = 0.5;
let _gaugeRafId  = null;

const SPEED_LEVELS = { decrease: 0.18, maintain: 0.5, increase: 0.85 };

function _initSpeedGauge() {
  const c = document.getElementById('speed-gauge');
  if (c) { _gaugeCtx = c.getContext('2d'); _drawGauge(0.5); }
}

function _updateSpeedMode(mode) {
  const el = document.getElementById('speed-mode');
  if (el) { el.textContent = mode.toUpperCase(); el.className = `speed-mode ${mode}`; }
  _gaugeTarget = SPEED_LEVELS[mode] ?? 0.5;
  if (!_gaugeRafId) _animateGauge();
}

function _animateGauge() {
  _gaugeValue += (_gaugeTarget - _gaugeValue) * 0.1;
  _drawGauge(_gaugeValue);
  if (Math.abs(_gaugeValue - _gaugeTarget) > 0.003) {
    _gaugeRafId = requestAnimationFrame(_animateGauge);
  } else {
    _gaugeValue = _gaugeTarget;
    _drawGauge(_gaugeValue);
    _gaugeRafId = null;
  }
}

function _drawGauge(v) {
  const ctx = _gaugeCtx;
  if (!ctx) return;
  const W = 130, H = 72, cx = W / 2, cy = H - 6, r = 54;
  ctx.clearRect(0, 0, W, H);

  // Track
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, 0, false);
  ctx.strokeStyle = 'rgba(0,242,255,0.1)';
  ctx.lineWidth = 9;
  ctx.stroke();

  // Ticks
  for (let i = 0; i <= 10; i++) {
    const a = Math.PI + (i / 10) * Math.PI;
    const inner = r - 8, outer = r + 2;
    ctx.beginPath();
    ctx.moveTo(cx + inner * Math.cos(a), cy + inner * Math.sin(a));
    ctx.lineTo(cx + outer * Math.cos(a), cy + outer * Math.sin(a));
    ctx.strokeStyle = 'rgba(0,242,255,0.3)';
    ctx.lineWidth = i % 5 === 0 ? 1.5 : 0.8;
    ctx.stroke();
  }

  // Colored arc
  const color = v < 0.35 ? '#ff3d00' : v > 0.65 ? '#00e676' : '#ff9800';
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI + v * Math.PI, false);
  ctx.strokeStyle = color;
  ctx.lineWidth = 9;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Glow
  ctx.beginPath();
  ctx.arc(cx, cy, r, Math.PI, Math.PI + v * Math.PI, false);
  ctx.strokeStyle = color + '55';
  ctx.lineWidth = 16;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Needle
  const angle = Math.PI + v * Math.PI;
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + (r - 10) * Math.cos(angle), cy + (r - 10) * Math.sin(angle));
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.stroke();

  // Center dot
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#fff';
  ctx.fill();
}

/* ═══════════════════════════════════════════════════════════
   RISK CHIP
   ═══════════════════════════════════════════════════════════ */
function _updateRiskChip(risk) {
  const el = document.getElementById('tb-risk');
  if (!el) return;
  el.textContent = `● ${risk.toUpperCase()}`;
  el.className = `risk-chip risk-${risk}`;
}

/* ═══════════════════════════════════════════════════════════
   LANE PANEL
   ═══════════════════════════════════════════════════════════ */
function _updateLanePanel(l) {
  if (!l) return;
  _drawLaneDiagram(l);

  const offEl  = document.getElementById('lane-offset-text');
  const confEl = document.getElementById('lane-conf-text');
  if (offEl) {
    const off = Number(l.lane_center_offset_px ?? 0);
    offEl.textContent = `OFFSET ${off >= 0 ? '+' : ''}${off.toFixed(0)}px`;
    offEl.style.color = Math.abs(off) > 60 ? '#ff9800' : '#00f2ff';
  }
  if (confEl) {
    const c = Number(l.lane_confidence ?? 0);
    confEl.textContent = `CONF ${(c * 100).toFixed(0)}%`;
    confEl.style.color = c < 0.3 ? '#ff3d00' : c < 0.6 ? '#ff9800' : '#00e676';
  }
}

function _drawLaneDiagram(l) {
  const c = document.getElementById('lane-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = 180, H = 52;
  ctx.clearRect(0, 0, W, H);

  const nL   = l.num_lanes    ?? 2;
  const cur  = l.current_lane ?? 1;
  const off  = Number(l.lane_center_offset_px ?? 0);
  const pad  = 12;
  const laneW = (W - pad * 2) / nL;

  for (let i = 0; i < nL; i++) {
    const x = pad + i * laneW;
    const isEgo = (i + 1) === cur;
    ctx.fillStyle = isEgo ? 'rgba(0,242,255,0.15)' : 'rgba(255,255,255,0.03)';
    ctx.fillRect(x + 1, 6, laneW - 2, H - 12);
    // Dividers
    ctx.beginPath();
    ctx.moveTo(x, 6); ctx.lineTo(x, H - 6);
    ctx.strokeStyle = (i === 0 || i === nL) ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = (i === 0) ? 1.5 : 0.8;
    ctx.setLineDash(i === 0 || i === nL - 1 ? [] : [4, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // Right edge
  const rightEdge = pad + nL * laneW;
  ctx.beginPath();
  ctx.moveTo(rightEdge, 6); ctx.lineTo(rightEdge, H - 6);
  ctx.strokeStyle = 'rgba(255,255,255,0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // Ego vehicle glyph with offset
  const egoLaneMid = pad + (cur - 1) * laneW + laneW / 2;
  const scaledOff  = off * (laneW / 200);
  const vx = Math.max(pad + 6, Math.min(rightEdge - 6, egoLaneMid + scaledOff));
  const vy = H / 2;

  ctx.fillStyle = '#00f2ff';
  ctx.shadowColor = '#00f2ff';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.roundRect(vx - 5, vy - 9, 10, 18, 2);
  ctx.fill();
  ctx.shadowBlur = 0;
}

/* ═══════════════════════════════════════════════════════════
   LANE CHANGE INDICATOR
   ═══════════════════════════════════════════════════════════ */
function _updateLCI(lane, laneInfo) {
  const wrap  = document.getElementById('lci-inner');
  const arrow = document.getElementById('lci-arrow');
  const text  = document.getElementById('lci-text');
  if (!wrap || !arrow || !text) return;

  const cur   = laneInfo?.current_lane ?? null;
  const total = laneInfo?.num_lanes    ?? null;

  if (lane === 'change_left') {
    wrap.className = 'lci change-left';
    arrow.innerHTML = '&#8678;';
    const t = cur ? cur - 1 : null;
    text.textContent = (t && t >= 1) ? `MOVE TO LANE ${t}` : 'CHANGE LEFT';
  } else if (lane === 'change_right') {
    wrap.className = 'lci change-right';
    arrow.innerHTML = '&#8680;';
    const t = cur ? cur + 1 : null;
    text.textContent = (t && total && t <= total) ? `MOVE TO LANE ${t}` : 'CHANGE RIGHT';
  } else {
    wrap.className = 'lci keep';
    arrow.innerHTML = '&#8679;';
    text.textContent = (cur && total) ? `STAY IN LANE ${cur}` : 'KEEP LANE';
  }
}

/* ═══════════════════════════════════════════════════════════
   RADAR
   ═══════════════════════════════════════════════════════════ */
const RADAR_MAX_M = 65;
const CLASS_COLORS = {
  car:          '#00f2ff',
  truck:        '#ff9800',
  person:       '#00e676',
  pedestrian:   '#00e676',
  traffic_light:'#f9a825',
  trafficlight: '#f9a825',
  stop_sign:    '#ff3d00',
};
function _detColor(cls) {
  return CLASS_COLORS[(cls || '').toLowerCase().replace(/[\s-]/g, '_')] || '#aabb88';
}

let _radarCtx   = null;
let _radarSweep = 0;
let _radarDets  = [];
let _radarLane  = null;
let _radarDec   = {};

function _initRadar() {
  const c = document.getElementById('radar-canvas');
  if (!c) return;
  _radarCtx = c.getContext('2d');
  _radarLoop();
}

function _radarLoop() {
  requestAnimationFrame(_radarLoop);
  _radarSweep = (_radarSweep + 1.5) % 360;
  _drawRadar(_radarDets, _radarLane, _radarDec);
}

function _updateRadar(detections, laneInfo, decisions) {
  _radarDets = detections;
  _radarLane = laneInfo;
  _radarDec  = decisions;
}

function _drawRadar(detections, laneInfo, decisions) {
  const ctx = _radarCtx;
  if (!ctx) return;
  const W = 190, H = 190, cx = W / 2, cy = H * 0.72;
  const maxR = cy - 10;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(0,6,14,0.96)';
  ctx.fillRect(0, 0, W, H);

  // Sweep sector
  const sweepRad = (_radarSweep * Math.PI) / 180 - Math.PI / 2;
  ctx.save();
  ctx.translate(cx, cy);
  const sg = ctx.createLinearGradient(
    Math.cos(sweepRad - 0.5) * maxR,
    Math.sin(sweepRad - 0.5) * maxR,
    Math.cos(sweepRad) * maxR,
    Math.sin(sweepRad) * maxR
  );
  sg.addColorStop(0, 'rgba(0,242,255,0.0)');
  sg.addColorStop(1, 'rgba(0,242,255,0.12)');
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.arc(0, 0, maxR, sweepRad - 0.5, sweepRad);
  ctx.closePath();
  ctx.fillStyle = sg;
  ctx.fill();
  ctx.restore();

  // Range rings
  [0.33, 0.66, 1.0].forEach((f, i) => {
    const ringR = f * maxR;
    const distM = Math.round(RADAR_MAX_M * f);
    ctx.beginPath();
    ctx.arc(cx, cy, ringR, Math.PI, 0, false);
    ctx.strokeStyle = `rgba(0,242,255,${0.08 + i * 0.05})`;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,242,255,0.35)';
    ctx.font = '8px "Rajdhani", monospace';
    ctx.textAlign = 'right';
    ctx.fillText(`${distM}m`, cx - ringR - 2, cy + 3);
  });

  // Center axis
  ctx.beginPath();
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx, cy - maxR * 1.02);
  ctx.strokeStyle = 'rgba(0,242,255,0.2)';
  ctx.lineWidth = 0.7;
  ctx.setLineDash([4, 5]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Lane boundaries
  const nL     = laneInfo?.num_lanes    ?? 2;
  const LANE_W = 3.5;
  const xScale = (W * 0.30) / (nL * LANE_W);
  for (let i = 0; i <= nL; i++) {
    const lx = cx + (i - nL / 2) * LANE_W * xScale;
    ctx.beginPath();
    ctx.moveTo(lx, cy);
    ctx.lineTo(lx, cy - maxR * 0.97);
    ctx.strokeStyle = (i === 0 || i === nL) ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)';
    ctx.lineWidth = (i === 0 || i === nL) ? 1.0 : 0.6;
    ctx.setLineDash((i === 0 || i === nL) ? [] : [5, 6]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Detections
  const LATERAL = { front: 0, front_left: -1, front_right: 1, left: -1.7, right: 1.7 };
  detections.forEach(det => {
    const dist = Number(det.distance_m ?? 0);
    const pos  = (det.position || 'front').toLowerCase();
    const cls  = (det.class || '').toLowerCase().replace(/[\s-]/g, '_');
    const lat  = LATERAL[pos] ?? 0;
    const col  = _detColor(cls);
    const isOpp = (det.orientation || '').toLowerCase() === 'opposite';

    const py = cy - (dist / RADAR_MAX_M) * maxR;
    const px = cx + lat * LANE_W * xScale;

    if (py < 4 || py > H || px < 4 || px > W - 4) return;

    // Threat ring for close objects
    if (dist < 20) {
      ctx.beginPath();
      ctx.arc(px, py, 13, 0, Math.PI * 2);
      ctx.strokeStyle = col + '55';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Blip with glow
    ctx.shadowColor = col;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(px, py, 5, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Direction arrow for oncoming
    if (isOpp) {
      ctx.save();
      ctx.translate(px, py + 9);
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.lineTo(-3, -5); ctx.lineTo(3, -5);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // Distance label
    ctx.fillStyle = col;
    ctx.font = 'bold 8px "Rajdhani", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(`${dist.toFixed(0)}m`, px, py - 8);
  });

  // Ego vehicle glyph
  ctx.fillStyle = '#00f2ff';
  ctx.shadowColor = '#00f2ff';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 12);
  ctx.lineTo(cx - 5, cy + 4);
  ctx.lineTo(cx + 5, cy + 4);
  ctx.closePath();
  ctx.fill();
  ctx.shadowBlur = 0;
}

/* ═══════════════════════════════════════════════════════════
   THREAT LIST
   ═══════════════════════════════════════════════════════════ */
function _updateThreatList(detections, alertTriggers) {
  const el = document.getElementById('hud-threat-list');
  if (!el) return;

  if (!detections.length) {
    el.innerHTML = '<span class="threat-clear">✓ CLEAR</span>';
    return;
  }

  const sorted = [...detections]
    .sort((a, b) => (a.distance_m ?? 999) - (b.distance_m ?? 999))
    .slice(0, 5);

  el.innerHTML = sorted.map(d => {
    const cls   = (d.class || 'unknown').toUpperCase();
    const dist  = Number(d.distance_m ?? 0).toFixed(0);
    const pos   = (d.position || 'front').toUpperCase().replace(/_/g, ' ');
    const col   = _detColor((d.class || '').toLowerCase());
    const isCrit = Number(d.distance_m ?? 99) < 15;
    return `<span class="threat-item${isCrit ? ' threat-crit' : ''}" style="--tc:${col}">
      <span class="ti-cls">${cls}</span>
      <span class="ti-dist">${dist}m</span>
      <span class="ti-pos">${pos}</span>
    </span>`;
  }).join('');
}

/* ═══════════════════════════════════════════════════════════
   BOTTOM CHIPS
   ═══════════════════════════════════════════════════════════ */
function _updateBottomChips(l) {
  if (!l) return;
  const numEl  = document.getElementById('chip-lane-num');
  const mainEl = document.getElementById('chip-main-road');
  const confEl = document.getElementById('chip-confidence');

  if (numEl) numEl.textContent = `LANE ${l.current_lane ?? '?'}/${l.num_lanes ?? '?'}`;
  if (mainEl) mainEl.hidden = !l.is_main_road;
  if (confEl) {
    const c = Number(l.lane_confidence ?? 0);
    confEl.textContent = `CONF ${(c * 100).toFixed(0)}%`;
    confEl.style.color = c < 0.3 ? '#ff3d00' : c < 0.6 ? '#ff9800' : '#00e676';
  }
}

/* ═══════════════════════════════════════════════════════════
   ALERT POPUP
   ═══════════════════════════════════════════════════════════ */
let _alertHideTimer = null;

function _updateAlert(d, t) {
  const el = document.getElementById('hud-alert');
  if (!el) return;

  const eligible = t.vehicle_ahead || t.stop_sign || t.red_traffic_light;
  const show = eligible && (d.brake === 'strong' || d.brake === 'light' || d.speed === 'decrease');

  if (show) {
    clearTimeout(_alertHideTimer);
    el.hidden = false;
    if (t.red_traffic_light || t.stop_sign) {
      el.className = 'hud-alert show alert-strong';
      el.textContent = t.stop_sign ? '⚠ STOP — OPREȘTE' : '⚠ SEMAFOR ROȘU — FRÂNĂ';
    } else {
      el.className = 'hud-alert show alert-warn';
      el.textContent = '⚠ VEHICUL ÎN FAȚĂ — REDU VITEZA';
    }
    return;
  }

  if (!el.classList.contains('show')) { el.hidden = true; return; }
  clearTimeout(_alertHideTimer);
  _alertHideTimer = setTimeout(() => {
    el.classList.remove('show', 'alert-strong', 'alert-warn');
    el.textContent = '';
    el.hidden = true;
  }, 600);
}