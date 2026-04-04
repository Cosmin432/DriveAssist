import { DEMO_SCENARIOS } from './scenarios.js';

export function initHUD() {
  const hud = document.createElement('div');
  hud.id = 'hud';
  hud.innerHTML = `
    <div id="hud-top-left"    class="hud-box">BRAKE: NONE</div>
    <div id="hud-top-center"  class="hud-box">SPEED: MAINTAIN</div>
    <div id="hud-top-right"   class="hud-box">LANE: KEEP</div>
    <div id="hud-bottom-left" class="hud-box risk-low">RISK: LOW</div>
    <div id="hud-scenario"    class="hud-scenario"></div>
    <div id="hud-demo-controls" class="hud-demo-controls">
      <button id="btn-prev">&#9664;</button>
      <div id="demo-dots"></div>
      <button id="btn-next">&#9654;</button>
      <button id="btn-pause">&#10074;&#10074;</button>
    </div>
  `;
  document.body.appendChild(hud);
}

export function updateHUD(data, demoIndex, onStep, onPause) {
  const d = data.decisions;

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

  const scenario = DEMO_SCENARIOS[demoIndex];
  const scenEl = document.getElementById('hud-scenario');
  if (scenEl && scenario) {
    scenEl.innerHTML = `
      <span class="scen-index">${demoIndex + 1}/${DEMO_SCENARIOS.length}</span>
      <span class="scen-name">${scenario.name}</span>
      <span class="scen-desc">${scenario.description}</span>
    `;
  }

  // Dots
  const dotsEl = document.getElementById('demo-dots');
  if (dotsEl) {
    dotsEl.innerHTML = DEMO_SCENARIOS.map((_, i) =>
      `<span class="dot ${i === demoIndex ? 'active' : ''}" data-i="${i}"></span>`
    ).join('');
    dotsEl.querySelectorAll('.dot').forEach(dot =>
      dot.addEventListener('click', () => onStep(Number(dot.dataset.i)))
    );
  }

  // Wire buttons once (guard with dataset flag)
  const prev = document.getElementById('btn-prev');
  const next = document.getElementById('btn-next');
  const pause = document.getElementById('btn-pause');
  if (prev && !prev.dataset.wired) {
    prev.dataset.wired = '1';
    prev.addEventListener('click', () => onStep(-1));
  }
  if (next && !next.dataset.wired) {
    next.dataset.wired = '1';
    next.addEventListener('click', () => onStep(1));
  }
  if (pause && !pause.dataset.wired) {
    pause.dataset.wired = '1';
    pause.addEventListener('click', () => onPause(pause));
  }
}
