import * as THREE from 'three';
import { clearDynamicRoad, buildRoad, buildJunction } from './road.js';
import { initEgoVehicle, createObjectMesh, disposeObject } from './models.js';
import { initHUD, updateHUD } from './hud.js';
import { connectWebSocket } from './websocket.js';

/* =========================
   SCENE GLOBALS
========================= */
let scene, camera, renderer;
let egoVehicle;
const detectedObjects = new Map();

/** World: 1 unit ≈ 1 m along road; lane width 3.5 m (matches backend mental model). */
const LANE_WIDTH_M = 3.5;
/** Backend distance_m → world -Z (lower = objects appear closer for same meters). */
const WORLD_Z_PER_M = 0.36;
/** UFLD offset = lane_mid − image_center; negative → steer right (+X) to re-center in lane. */
const OFFSET_PX_TO_WORLD_X = 0.016;
/** Require this long at the same lane count before rebuilding road (ms). */
const LANE_COUNT_STABLE_MS = 1800;

const laneCountStabilizer = {
  rendered: 2,
  pending: null,
  since: 0,
};

function stabilizeLaneCount(raw, now) {
  const n = Math.min(5, Math.max(2, Math.round(Number(raw) || 2)));
  if (n === laneCountStabilizer.rendered) {
    laneCountStabilizer.pending = null;
    return n;
  }
  if (n !== laneCountStabilizer.pending) {
    laneCountStabilizer.pending = n;
    laneCountStabilizer.since = now;
    return laneCountStabilizer.rendered;
  }
  if (now - laneCountStabilizer.since >= LANE_COUNT_STABLE_MS) {
    laneCountStabilizer.rendered = n;
    laneCountStabilizer.pending = null;
    return n;
  }
  return laneCountStabilizer.rendered;
}

let currentLaneInfo = {
  num_lanes: 2,
  current_lane: 1,
  is_main_road: false,
  lane_center_offset_px: 0,
  lane_confidence: 0,
};
/** World X of center of ego lane (without fine offset / maneuver nudge). */
let egoLaneBaseX = 0;
/** Temporary lateral nudge from decisions (lane-change hint). */
let egoDecisionNudgeX = 0;
let egoCurrentSpeed = 0.08;
let egoTargetSpeed = 0.08;
let lastFrameTime = performance.now();
let egoPlacedInLane = false;

/** Per-detection-id smoothing to reduce flicker */
const orientVotes = new Map();
const posSmooth = new Map();

function stableOrientation(id, raw) {
  const o = (raw || 'same').toLowerCase() === 'opposite' ? 'opposite' : 'same';
  const arr = orientVotes.get(id) || [];
  arr.push(o);
  while (arr.length > 6) arr.shift();
  orientVotes.set(id, arr);
  const opp = arr.filter((x) => x === 'opposite').length;
  return opp >= Math.ceil(arr.length / 2) ? 'opposite' : 'same';
}

function smoothTarget(id, v) {
  const prev = posSmooth.get(id);
  if (!prev) {
    posSmooth.set(id, v.clone());
    return v.clone();
  }
  const a = 0.22;
  const out = new THREE.Vector3(
    THREE.MathUtils.lerp(prev.x, v.x, a),
    0,
    THREE.MathUtils.lerp(prev.z, v.z, a)
  );
  posSmooth.set(id, out);
  return out;
}

function pruneSmoothing(liveIds) {
  for (const k of orientVotes.keys()) {
    if (!liveIds.has(k)) orientVotes.delete(k);
  }
  for (const k of posSmooth.keys()) {
    if (!liveIds.has(k)) posSmooth.delete(k);
  }
}

/* =========================
   BOOT
========================= */
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
    () => console.info('[WS] ready')
  );

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
}

init();
animate();

/* =========================
   SCENE SETUP
========================= */
function initScene() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x7ba7c0);
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
  sun.shadow.camera.right  = 80;
  sun.shadow.camera.top    = 80;
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
  /* Lane markings come only from buildRoad() (dynamic), not scrolling quads here. */
}

/* =========================
   DATA HANDLING
========================= */
async function handleIncomingData(data) {
  let norm = normalizeData(data);
  const now = performance.now();

  if (norm.lane_info) {
    const rawN = norm.lane_info.num_lanes ?? 2;
    const stableN = stabilizeLaneCount(rawN, now);
    const curLane = Math.min(Math.max(1, norm.lane_info.current_lane ?? 1), stableN);
    norm = {
      ...norm,
      lane_info: { ...norm.lane_info, num_lanes: stableN, current_lane: curLane },
      road: {
        ...norm.road,
        lanes: stableN,
        width: stableN * LANE_WIDTH_M,
      },
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

  clearDynamicRoad(scene);
  if (norm.road) {
    buildRoad(scene, norm.road);
    buildJunction(scene, norm.junction, norm.road.width);
  }

  applyDecisions(norm.decisions);
  await syncDetections(norm.detections);

  data.lane_info = norm.lane_info;
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
    timestamp:  data.timestamp ?? 0,
    frame:      data.frame     ?? 0,
    road,
    junction:   data.junction  ?? null,
    detections: data.detections ?? [],
    decisions:  data.decisions  ?? { brake: 'none', lane: 'keep', speed: 'maintain', risk: 'low' },
    lane_info:  laneInfo,
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

function detectionYaw(det) {
  if (det.junction_road) return Math.PI / 2;
  const o = (det.orientation || 'same').toLowerCase();
  if (o === 'opposite') return Math.PI;
  return 0;
}

async function syncDetections(detections) {
  const liveIds = new Set();

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const id  = det.id ?? `${det.class}-${i}`;
    liveIds.add(id);

    const orient = stableOrientation(id, det.orientation);
    const detUse = { ...det, orientation: orient };
    const rawPos = detectionToWorld(detUse);
    const worldPos = smoothTarget(id, rawPos);
    const yaw = detectionYaw(detUse);

    if (!detectedObjects.has(id)) {
      const m = await createObjectMesh(det.class);
      m.position.copy(worldPos);
      m.userData.targetPosition = worldPos.clone();
      m.rotation.y = yaw;
      scene.add(m);
      detectedObjects.set(id, { mesh: m });
    } else {
      const obj = detectedObjects.get(id);
      obj.mesh.userData.targetPosition = worldPos.clone();
      obj.mesh.rotation.y = THREE.MathUtils.lerp(obj.mesh.rotation.y, yaw, 0.2);
    }
  }

  pruneSmoothing(liveIds);

  for (const [id, obj] of detectedObjects.entries()) {
    if (!liveIds.has(id)) {
      scene.remove(obj.mesh);
      disposeObject(obj.mesh);
      detectedObjects.delete(id);
    }
  }
}

function laneToX(laneNumber, numLanes) {
  const totalWidth = numLanes * LANE_WIDTH_M;
  const leftEdge   = -totalWidth / 2 + LANE_WIDTH_M / 2;
  return leftEdge + (laneNumber - 1) * LANE_WIDTH_M;
}

function detectionToWorld(det) {
  const pos      = (det.position || 'front').toLowerCase();
  const distance = Number(det.distance_m ?? 10);
  const depth    = distance * WORLD_Z_PER_M;
  const numLanes = currentLaneInfo.num_lanes    ?? 2;
  const egoLane  = currentLaneInfo.current_lane ?? 1;
  const orient   = (det.orientation || 'same').toLowerCase();

  const carriagewayW = numLanes * LANE_WIDTH_M;
  let baseX;

  if (orient === 'opposite') {
    /*
     * Keep oncoming vehicles on the drawn road mesh (single carriageway strip).
     * Place them on the far edge lane from ego so they read as "other flow" but stay on asphalt.
     */
    const useLeftStrip = egoLane > numLanes / 2;
    baseX = useLeftStrip ? laneToX(1, numLanes) : laneToX(numLanes, numLanes);
  } else {
    baseX = laneToX(egoLane, numLanes);
  }

  const posMap = {
    front:       { x: baseX, z: -depth },
    front_left:  { x: baseX - LANE_WIDTH_M, z: -depth },
    front_right: { x: baseX + LANE_WIDTH_M, z: -depth },
    left:        { x: baseX - LANE_WIDTH_M, z: -Math.min(depth, 40 * WORLD_Z_PER_M) },
    right:       { x: baseX + LANE_WIDTH_M, z: -Math.min(depth, 40 * WORLD_Z_PER_M) },
  };

  const p = posMap[pos] ?? { x: baseX, z: -depth };
  return new THREE.Vector3(p.x, 0, p.z);
}

/* =========================
   ANIMATION LOOP
========================= */
function animate(now = performance.now()) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - lastFrameTime) / 1000, 0.05);
  lastFrameTime = now;

  egoCurrentSpeed = THREE.MathUtils.lerp(egoCurrentSpeed, egoTargetSpeed, 0.05);

  if (egoVehicle) {
    const offPx = Number(currentLaneInfo.lane_center_offset_px ?? 0);
    const lateral = THREE.MathUtils.clamp(-offPx * OFFSET_PX_TO_WORLD_X, -2.5, 2.5);
    const targetX = egoLaneBaseX + lateral + egoDecisionNudgeX;
    egoVehicle.position.x = THREE.MathUtils.lerp(egoVehicle.position.x, targetX, 0.14);
  }

  for (const [, obj] of detectedObjects.entries()) {
    const target = obj.mesh.userData.targetPosition;
    if (target) obj.mesh.position.lerp(target, 0.15);
  }

  if (egoVehicle) {
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, egoVehicle.position.x, 0.08);
    camera.lookAt(egoVehicle.position.x, 1.2, -10);
  }

  renderer.render(scene, camera);
}
