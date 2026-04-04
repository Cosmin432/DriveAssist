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
let laneMarkers = [];
const detectedObjects = new Map();

let currentLaneInfo = { num_lanes: 2, current_lane: 1, is_main_road: false };
let egoTargetX      = 0;
let egoCurrentSpeed = 0.08;
let egoTargetSpeed  = 0.08;
let lastFrameTime   = performance.now();

/* =========================
   BOOT
========================= */
async function init() {
  initScene();
  initLights();
  initStaticGround();
  initHUD();
  egoVehicle = await initEgoVehicle(scene);

  connectWebSocket(
    async (data) => {
      await handleIncomingData(data);
      updateHUD(data);
    },
    () => console.warn('[WS] disconnected')
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

  const markerMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
  for (let i = 0; i < 30; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 3), markerMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(0, 0.02, -i * 7);
    scene.add(m);
    laneMarkers.push(m);
  }
}

/* =========================
   DATA HANDLING
========================= */
async function handleIncomingData(data) {
  const norm = normalizeData(data);

  if (norm.lane_info) currentLaneInfo = norm.lane_info;

  clearDynamicRoad(scene);
  if (norm.road) {
    buildRoad(scene, norm.road);
    buildJunction(scene, norm.junction, norm.road.width);
  }

  applyDecisions(norm.decisions);
  await syncDetections(norm.detections);

  data.lane_info = norm.lane_info;
}

function normalizeData(data) {
  const laneInfo = data.lane_info ?? null;
  const road = data.road ?? {
    type:      'straight',
    lanes:     laneInfo?.num_lanes ?? 2,
    width:     (laneInfo?.num_lanes ?? 2) * 6,
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

  if      (lane === 'change_left')  egoTargetX = -2.0;
  else if (lane === 'change_right') egoTargetX =  2.0;
  else                              egoTargetX =  0.0;
}

async function syncDetections(detections) {
  const liveIds = new Set();

  for (let i = 0; i < detections.length; i++) {
    const det = detections[i];
    const id  = det.id ?? `${det.class}-${i}`;
    liveIds.add(id);

    const worldPos = detectionToWorld(det);

    if (!detectedObjects.has(id)) {
      const m = await createObjectMesh(det.class);
      m.position.copy(worldPos);
      m.userData.targetPosition = worldPos.clone();
      if (det.junction_road) m.rotation.y = Math.PI / 2;
      scene.add(m);
      detectedObjects.set(id, { mesh: m });
    } else {
      const obj = detectedObjects.get(id);
      obj.mesh.userData.targetPosition = worldPos.clone();
      obj.mesh.rotation.y = det.junction_road ? Math.PI / 2 : 0;
    }
  }

  for (const [id, obj] of detectedObjects.entries()) {
    if (!liveIds.has(id)) {
      scene.remove(obj.mesh);
      disposeObject(obj.mesh);
      detectedObjects.delete(id);
    }
  }
}

function laneToX(laneNumber, numLanes) {
  const laneWidth  = 3.5;
  const totalWidth = numLanes * laneWidth;
  const leftEdge   = -totalWidth / 2 + laneWidth / 2;
  return leftEdge + (laneNumber - 1) * laneWidth;
}

function detectionToWorld(det) {
  const pos      = (det.position || 'front').toLowerCase();
  const distance = Number(det.distance_m ?? 10);
  const numLanes = currentLaneInfo.num_lanes    ?? 2;
  const egoLane  = currentLaneInfo.current_lane ?? 1;
  const egoX     = laneToX(egoLane, numLanes);

  const posMap = {
    front:       { x: egoX,       z: -distance },
    front_left:  { x: egoX - 3.5, z: -distance },
    front_right: { x: egoX + 3.5, z: -distance },
    left:        { x: egoX - 3.5, z: -Math.min(distance, 40) },
    right:       { x: egoX + 3.5, z: -Math.min(distance, 40) },
  };

  const p = posMap[pos] ?? { x: egoX, z: -distance };
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
    egoVehicle.position.x = THREE.MathUtils.lerp(egoVehicle.position.x, egoTargetX, 0.08);
  }

  laneMarkers.forEach(m => {
    m.position.z += egoCurrentSpeed * 60 * dt;
    if (m.position.z > 8) m.position.z = -190;
  });

  for (const [, obj] of detectedObjects.entries()) {
    const target = obj.mesh.userData.targetPosition;
    if (target) obj.mesh.position.lerp(target, 0.15);
  }

  if (egoVehicle) {
    camera.position.x = THREE.MathUtils.lerp(camera.position.x, egoVehicle.position.x, 0.05);
    camera.lookAt(egoVehicle.position.x, 1.2, -10);
  }

  renderer.render(scene, camera);
}