import * as THREE from 'three';
import { clearDynamicRoad, buildRoad, buildJunction } from './road.js';
import { initEgoVehicle, createObjectMesh, disposeObject } from './models.js';
import { initHUD, updateHUD, setHUDConnected } from './hud.js';
import { connectWebSocket } from './websocket.js';
import { DEMO_SCENARIOS } from './scenarios.js';

/* ═══════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════ */
const LANE_WIDTH_M        = 3.5;
const WORLD_Z_PER_M       = 0.36;
const OFFSET_PX_TO_WORLD_X = 0.016;
/**
 * How long (ms) a *new* lane count must be seen continuously before we
 * commit to it and rebuild the road.  High value = less flickering.
 * Oscillation (2→3→2→3) can never reset this timer because we only
 * reset `since` when the candidate itself changes.
 */
const LANE_COUNT_STABLE_MS = 4500;

/** How long (ms) a detection must be absent before we fade & remove its mesh. */
const FADE_OUT_MS = 400;

/* ═══════════════════════════════════════════════════════════
   SCENE GLOBALS
   ═══════════════════════════════════════════════════════════ */
let scene, camera, renderer;
let egoVehicle;
const detectedObjects = new Map(); // id → { mesh, lastSeen, fading }

const laneCountStabilizer = { rendered: 2, pending: null, since: 0 };

let currentLaneInfo = {
  num_lanes: 2, current_lane: 1,
  is_main_road: false, lane_center_offset_px: 0, lane_confidence: 0,
};
let egoLaneBaseX    = 0;
let egoDecisionNudgeX = 0;
let egoCurrentSpeed = 0.08;
let egoTargetSpeed  = 0.08;
let lastFrameTime   = performance.now();
let egoPlacedInLane = false;

/* Smoothing */
const orientVotes = new Map();
const posSmooth   = new Map();

/* Sky / environment */
const SKY_NORMAL = new THREE.Color(0x7ba7c0);
const SKY_NIGHT  = new THREE.Color(0x0a0e1a);
const SKY_RAIN   = new THREE.Color(0x4a5560);
let skyTarget = SKY_NORMAL.clone();

/* ═══════════════════════════════════════════════════════════
   BOOT
   ═══════════════════════════════════════════════════════════ */
async function init() {
  initScene();
  initLights();
  initStaticGround();
  initHUD();

  egoVehicle = await initEgoVehicle(scene);
  egoLaneBaseX = laneToX(currentLaneInfo.current_lane, currentLaneInfo.num_lanes);
  egoVehicle.position.x = egoLaneBaseX;

  connectWebSocket(
    async (data) => {
      await handleIncomingData(data);
      updateHUD(data);
    },
    () => {
      console.info('[WS] ready');
      setHUDConnected(true);
    },
    () => setHUDConnected(false)
  );

  initDemoOverlay();

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

init();
animate();

/* ═══════════════════════════════════════════════════════════
   SCENE SETUP
   ═══════════════════════════════════════════════════════════ */
function initScene() {
  scene = new THREE.Scene();
  scene.background = SKY_NORMAL.clone();
  scene.fog = new THREE.FogExp2(0x7ba7c0, 0.006);

  camera = new THREE.PerspectiveCamera(62, window.innerWidth / window.innerHeight, 0.1, 300);
  camera.position.set(0, 7, 13);
  camera.lookAt(0, 0.5, -8);

  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.body.appendChild(renderer.domElement);
}

function initLights() {
  scene.add(new THREE.AmbientLight(0xfff5e0, 0.7));

  const sun = new THREE.DirectionalLight(0xfff0d0, 1.1);
  sun.position.set(15, 30, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near   = 0.5;
  sun.shadow.camera.far    = 300;
  sun.shadow.camera.left   = -80;
  sun.shadow.camera.right  =  80;
  sun.shadow.camera.top    =  80;
  sun.shadow.camera.bottom = -80;
  scene.add(sun);

  const fill = new THREE.DirectionalLight(0xc8dff0, 0.35);
  fill.position.set(-10, 10, -10);
  scene.add(fill);
}

function initStaticGround() {
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.MeshStandardMaterial({ color: 0x5a7a3a })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.02;
  ground.receiveShadow = true;
  scene.add(ground);
}

/* ═══════════════════════════════════════════════════════════
   LANE COUNT STABILIZER
   ═══════════════════════════════════════════════════════════ */
function stabilizeLaneCount(raw, now) {
  const n = Math.min(5, Math.max(2, Math.round(Number(raw) || 2)));

  // Already showing this count — keep it, clear any pending challenge
  if (n === laneCountStabilizer.rendered) {
    laneCountStabilizer.pending = null;
    return n;
  }

  // A different count is being proposed
  if (n !== laneCountStabilizer.pending) {
    // Brand-new challenger — start the clock
    laneCountStabilizer.pending = n;
    laneCountStabilizer.since   = now;
    return laneCountStabilizer.rendered;   // stay on current until stable
  }

  // Same challenger still coming in — check if it has been stable long enough
  // NOTE: we do NOT reset `since` here, so oscillation between two values
  // just keeps accumulating time against the challenger.
  if (now - laneCountStabilizer.since >= LANE_COUNT_STABLE_MS) {
    laneCountStabilizer.rendered = n;
    laneCountStabilizer.pending  = null;
    return n;
  }

  return laneCountStabilizer.rendered;
}

/* ═══════════════════════════════════════════════════════════
   DATA HANDLING
   ═══════════════════════════════════════════════════════════ */
async function handleIncomingData(data) {
  let norm = normalizeData(data);
  const now = performance.now();

  if (norm.lane_info) {
    const stableN = stabilizeLaneCount(norm.lane_info.num_lanes ?? 2, now);
    const curLane = Math.min(Math.max(1, norm.lane_info.current_lane ?? 1), stableN);
    norm = {
      ...norm,
      lane_info: { ...norm.lane_info, num_lanes: stableN, current_lane: curLane },
      road: { ...norm.road, lanes: stableN, width: stableN * LANE_WIDTH_M },
    };
  }

  if (norm.lane_info) {
    currentLaneInfo = norm.lane_info;
    egoLaneBaseX = laneToX(currentLaneInfo.current_lane, currentLaneInfo.num_lanes);
    if (egoVehicle && !egoPlacedInLane) {
      egoVehicle.position.x = egoLaneBaseX;
      egoPlacedInLane = true;
    }
  }

  /* Sky / environment conditions */
  _applyEnvConditions(data.env_conditions ?? []);

  clearDynamicRoad(scene);
  if (norm.road) {
    buildRoad(scene, norm.road);
    buildJunction(scene, norm.junction, norm.road.width);
  }

  applyDecisions(norm.decisions);
  await syncDetections(norm.detections);

  data.lane_info = norm.lane_info;
}

function _applyEnvConditions(conditions) {
  if (!Array.isArray(conditions) || !conditions.length) {
    skyTarget = SKY_NORMAL.clone();
    return;
  }
  const c = conditions.map(x => (x || '').toLowerCase());
  if      (c.includes('night'))    skyTarget = SKY_NIGHT.clone();
  else if (c.includes('rain'))     skyTarget = SKY_RAIN.clone();
  else                             skyTarget = SKY_NORMAL.clone();
}

function normalizeData(data) {
  const laneInfo = data.lane_info ?? laneInfoFromLaneState(data.lane_state);
  const road = data.road ?? {
    type:      'straight',
    lanes:     laneInfo?.num_lanes ?? 2,
    width:     (laneInfo?.num_lanes ?? 2) * LANE_WIDTH_M,
    length:    200,
    separator: laneInfo?.is_main_road ? 'solid_yellow' : 'dashed_white',
  };
  return {
    timestamp:  data.timestamp  ?? 0,
    frame:      data.frame      ?? 0,
    road,
    junction:   data.junction   ?? null,
    detections: data.detections ?? [],
    decisions:  data.decisions  ?? { brake: 'none', lane: 'keep', speed: 'maintain', risk: 'low' },
    lane_info:  laneInfo,
    alert_triggers: data.alert_triggers ?? {},
  };
}

function laneInfoFromLaneState(ls) {
  if (!ls) return null;
  const nTrack = ls.num_tracked_lanes ?? 0;
  const num = Math.min(5, Math.max(2, nTrack >= 2 ? nTrack : 2));
  return {
    num_lanes: num,
    current_lane: Math.min(num, Math.max(1, Math.ceil(num / 2))),
    is_main_road: (ls.lane_confidence ?? 0) >= 0.35 && num >= 3,
    lane_center_offset_px: ls.lane_center_offset_px ?? 0,
    lane_confidence: ls.lane_confidence ?? 0,
    ego_lane_width_px: ls.ego_lane_width_px,
    num_tracked_lanes: nTrack,
  };
}

function applyDecisions({ speed, brake, lane }) {
  if      (brake === 'strong')                        egoTargetSpeed = 0.0;
  else if (brake === 'light' || speed === 'decrease') egoTargetSpeed = 0.03;
  else if (speed === 'increase')                      egoTargetSpeed = 0.14;
  else                                                egoTargetSpeed = 0.08;

  if      (lane === 'change_left')  egoDecisionNudgeX = -LANE_WIDTH_M * 0.85;
  else if (lane === 'change_right') egoDecisionNudgeX =  LANE_WIDTH_M * 0.85;
  else                              egoDecisionNudgeX =  0;
}

/* ─── Smoothing helpers ───────────────────────────────────── */
function stableOrientation(id, raw) {
  const o = (raw || 'same').toLowerCase() === 'opposite' ? 'opposite' : 'same';
  const arr = orientVotes.get(id) || [];
  arr.push(o);
  while (arr.length > 6) arr.shift();
  orientVotes.set(id, arr);
  return arr.filter(x => x === 'opposite').length >= Math.ceil(arr.length / 2)
    ? 'opposite' : 'same';
}

function smoothTarget(id, v) {
  const prev = posSmooth.get(id);
  if (!prev) { posSmooth.set(id, v.clone()); return v.clone(); }
  const a = 0.22;
  const out = new THREE.Vector3(
    THREE.MathUtils.lerp(prev.x, v.x, a), 0,
    THREE.MathUtils.lerp(prev.z, v.z, a)
  );
  posSmooth.set(id, out);
  return out;
}

function pruneSmoothing(liveIds) {
  for (const k of orientVotes.keys()) if (!liveIds.has(k)) orientVotes.delete(k);
  for (const k of posSmooth.keys())   if (!liveIds.has(k)) posSmooth.delete(k);
}

/* ─── Detection sync with fade-out ───────────────────────── */
function detectionYaw(det) {
  if (det.junction_road)                              return Math.PI / 2;
  return (det.orientation || 'same').toLowerCase() === 'opposite' ? Math.PI : 0;
}

async function syncDetections(detections) {
  const liveIds = new Set();
  const now = performance.now();

  // Build stable fallback IDs: car→car#0, car→car#1, truck→truck#0, etc.
  // This avoids phantom meshes when YOLO returns the same classes in a
  // different order across frames (index-based IDs would mismatch).
  const classCounts = {};
  const resolvedIds = detections.map(det => {
    if (det.id != null) return String(det.id);
    const cls = det.class || 'obj';
    classCounts[cls] = (classCounts[cls] ?? 0);
    const stableId = `${cls}#${classCounts[cls]}`;
    classCounts[cls]++;
    return stableId;
  });

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const id  = resolvedIds[i];
    liveIds.add(id);

    const orient   = stableOrientation(id, det.orientation);
    const detUse   = { ...det, orientation: orient };
    const rawPos   = detectionToWorld(detUse);
    const worldPos = smoothTarget(id, rawPos);
    const yaw      = detectionYaw(detUse);

    if (!detectedObjects.has(id)) {
      const m = await createObjectMesh(det.class);
      m.position.copy(worldPos);
      m.userData.targetPosition = worldPos.clone();
      m.rotation.y = yaw;
      _setMeshOpacity(m, 0);
      scene.add(m);
      detectedObjects.set(id, { mesh: m, lastSeen: now, fading: false });
      requestAnimationFrame(() => _fadeMesh(m, 0, 1, 250));
    } else {
      const obj = detectedObjects.get(id);
      obj.lastSeen = now;
      obj.fading   = false;
      obj.mesh.userData.targetPosition = worldPos.clone();
      obj.mesh.rotation.y = THREE.MathUtils.lerp(obj.mesh.rotation.y, yaw, 0.2);
      _setMeshOpacity(obj.mesh, 1);
    }
  }

  pruneSmoothing(liveIds);

  // Fade out anything not present in this frame
  for (const [id, obj] of detectedObjects.entries()) {
    if (!liveIds.has(id) && !obj.fading) {
      obj.fading = true;
      _fadeMesh(obj.mesh, 1, 0, FADE_OUT_MS, () => {
        scene.remove(obj.mesh);
        disposeObject(obj.mesh);
        detectedObjects.delete(id);
      });
    }
  }
}

function _setMeshOpacity(obj, opacity) {
  obj.traverse(child => {
    if (!child.isMesh) return;
    if (Array.isArray(child.material)) {
      child.material.forEach(m => { m.transparent = true; m.opacity = opacity; });
    } else if (child.material) {
      child.material.transparent = true;
      child.material.opacity = opacity;
    }
  });
}

function _fadeMesh(obj, from, to, durationMs, onDone) {
  const start = performance.now();
  function step(now) {
    const t = Math.min((now - start) / durationMs, 1);
    _setMeshOpacity(obj, THREE.MathUtils.lerp(from, to, t));
    if (t < 1) requestAnimationFrame(step);
    else { _setMeshOpacity(obj, to); onDone?.(); }
  }
  requestAnimationFrame(step);
}

/* ─── Geometry helpers ────────────────────────────────────── */
function laneToX(laneNumber, numLanes) {
  const totalWidth = numLanes * LANE_WIDTH_M;
  return -totalWidth / 2 + LANE_WIDTH_M / 2 + (laneNumber - 1) * LANE_WIDTH_M;
}

function detectionToWorld(det) {
  const pos      = (det.position || 'front').toLowerCase();
  const distance = Number(det.distance_m ?? 10);
  const depth    = distance * WORLD_Z_PER_M;
  const numLanes = currentLaneInfo.num_lanes    ?? 2;
  const egoLane  = currentLaneInfo.current_lane ?? 1;
  const orient   = (det.orientation || 'same').toLowerCase();

  let baseX;
  if (orient === 'opposite') {
    const useLeftStrip = egoLane > numLanes / 2;
    baseX = useLeftStrip ? laneToX(1, numLanes) : laneToX(numLanes, numLanes);
  } else {
    baseX = laneToX(egoLane, numLanes);
  }

  const posMap = {
    front:       { x: baseX,                  z: -depth },
    front_left:  { x: baseX - LANE_WIDTH_M,   z: -depth },
    front_right: { x: baseX + LANE_WIDTH_M,   z: -depth },
    left:        { x: baseX - LANE_WIDTH_M,   z: -Math.min(depth, 40 * WORLD_Z_PER_M) },
    right:       { x: baseX + LANE_WIDTH_M,   z: -Math.min(depth, 40 * WORLD_Z_PER_M) },
  };

  const p = posMap[pos] ?? { x: baseX, z: -depth };
  return new THREE.Vector3(p.x, 0, p.z);
}

/* ═══════════════════════════════════════════════════════════
   ANIMATION LOOP
   ═══════════════════════════════════════════════════════════ */
function animate(now = performance.now()) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  egoCurrentSpeed = THREE.MathUtils.lerp(egoCurrentSpeed, egoTargetSpeed, 0.05);

  /* Sky lerp */
  if (scene.background instanceof THREE.Color) {
    scene.background.lerp(skyTarget, 0.01);
    if (scene.fog) scene.fog.color.lerp(skyTarget, 0.01);
  }

  if (egoVehicle) {
    const offPx   = Number(currentLaneInfo.lane_center_offset_px ?? 0);
    const lateral = THREE.MathUtils.clamp(-offPx * OFFSET_PX_TO_WORLD_X, -2.5, 2.5);
    const targetX = egoLaneBaseX + lateral + egoDecisionNudgeX;
    egoVehicle.position.x = THREE.MathUtils.lerp(egoVehicle.position.x, targetX, 0.14);
  }

  for (const [, obj] of detectedObjects.entries()) {
    if (!obj.fading) {
      const target = obj.mesh.userData.targetPosition;
      if (target) obj.mesh.position.lerp(target, 0.15);
    }
  }

  if (egoVehicle) {
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, egoVehicle.position.x, 0.08);
    camera.lookAt(egoVehicle.position.x, 1.2, -10);
  }

  renderer.render(scene, camera);
}

/* ═══════════════════════════════════════════════════════════
   DEMO OVERLAY  (runs scenarios when WS offline)
   ═══════════════════════════════════════════════════════════ */
let _demoTimer    = null;
let _demoIdx      = 0;
let _demoActive   = false;
let _demoStart    = 0;
let _demoDuration = 4000;

function initDemoOverlay() {
  const overlay = document.createElement('div');
  overlay.id = 'demo-overlay';
  overlay.innerHTML = `
    <div id="demo-title">SCENARIO</div>
    <div id="demo-name">—</div>
    <div id="demo-desc">Connect WebSocket or run demo</div>
    <div id="demo-progress"><div id="demo-progress-bar"></div></div>
    <div id="demo-btn-row">
      <button class="demo-btn" id="demo-btn-play">▶ DEMO</button>
      <button class="demo-btn" id="demo-btn-prev">◀</button>
      <button class="demo-btn" id="demo-btn-next">▶</button>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('demo-btn-play').onclick = toggleDemo;
  document.getElementById('demo-btn-prev').onclick = () => { _demoIdx = (_demoIdx - 1 + DEMO_SCENARIOS.length) % DEMO_SCENARIOS.length; _runScenario(_demoIdx); };
  document.getElementById('demo-btn-next').onclick = () => { _demoIdx = (_demoIdx + 1) % DEMO_SCENARIOS.length; _runScenario(_demoIdx); };

  /* Progress bar animation */
  (function tickProgress() {
    requestAnimationFrame(tickProgress);
    if (!_demoActive) return;
    const elapsed  = performance.now() - _demoStart;
    const pct = Math.min(100, (elapsed / _demoDuration) * 100);
    const bar = document.getElementById('demo-progress-bar');
    if (bar) bar.style.width = `${pct}%`;
  })();
}

function toggleDemo() {
  if (_demoActive) {
    _demoActive = false;
    clearTimeout(_demoTimer);
    document.getElementById('demo-btn-play').textContent = '▶ DEMO';
    document.getElementById('demo-btn-play').classList.remove('active');
  } else {
    _demoActive = true;
    document.getElementById('demo-btn-play').textContent = '■ STOP';
    document.getElementById('demo-btn-play').classList.add('active');
    _runScenario(_demoIdx);
  }
}

async function _runScenario(idx) {
  const s = DEMO_SCENARIOS[idx];
  if (!s) return;

  document.getElementById('demo-name').textContent = s.name;
  document.getElementById('demo-desc').textContent = s.description;
  _demoStart    = performance.now();
  _demoDuration = s.duration;

  const payload = { ...s.data, timestamp: performance.now() / 1000, frame: idx * 10 };
  await handleIncomingData(payload);
  updateHUD(payload);

  if (_demoActive) {
    _demoTimer = setTimeout(() => {
      _demoIdx = (_demoIdx + 1) % DEMO_SCENARIOS.length;
      _runScenario(_demoIdx);
    }, s.duration);
  }
}