import * as THREE from 'three';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';

const objLoader  = new OBJLoader();
const mtlLoader  = new MTLLoader();
const gltfLoader = new GLTFLoader();
const modelCache = new Map();

export async function initEgoVehicle(scene) {
  let egoVehicle;
  try {
    const model = await loadOBJModel('/models/van_taxi/18577_Van_Taxi_v1_NEW.obj');
    egoVehicle = prepareOBJModel(model, { scale: 0.5, color: 0x00c853, y: 1, rotationX: 1.6, rotationY: Math.PI, rotationZ: Math.PI/2 });
  } catch {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1, 3.6), new THREE.MeshStandardMaterial({ color: 0x00c853 }));
    body.position.y = 0.8; body.castShadow = true; g.add(body);
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.8, 1.8), new THREE.MeshStandardMaterial({ color: 0x90caf9 }));
    cabin.position.set(0, 1.4, 0.1); cabin.castShadow = true; g.add(cabin);
    egoVehicle = g;
  }
  egoVehicle.position.set(0, 0, 2.5);
  scene.add(egoVehicle);
  return egoVehicle;
}

export async function createObjectMesh(className) {
  const cls = (className || '').toLowerCase();

  try {
    if (cls === 'car' || cls === 'truck') {
      const model = await loadOBJModel('/models/van_taxi/18577_Van_Taxi_v1_NEW.obj');
      return prepareOBJModel(model, {
        scale: cls === 'truck' ? 0.55 : 0.5,
        color: 0x1565c0, y: 0.8,
        rotationX: 1.6, rotationY: Math.PI, rotationZ: Math.PI/2,
      });
    }
    if (cls === 'person') {
      const model = await loadGLBModel('/models/person/stickman.glb');
      return prepareOBJModel(model, { scale: 10, color: 0x2e7d32, y: 0.2 });
    }
  } catch (err) {
    console.error('Model load error:', err);
  }

  if (cls === 'stop_sign' || cls === 'stop sign') {
    const g = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 12), new THREE.MeshStandardMaterial({ color: 0x9e9e9e }));
    pole.position.y = 1.1; g.add(pole);
    const sign = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.08, 8), new THREE.MeshStandardMaterial({ color: 0xc62828 }));
    sign.rotation.x = Math.PI/2; sign.position.y = 2.1; g.add(sign);
    g.userData.targetPosition = new THREE.Vector3();
    return g;
  }

  // Generic fallback
  const fallback = new THREE.Mesh(
    new THREE.BoxGeometry(1.8, 1, 3.6),
    new THREE.MeshStandardMaterial({ color: 0xff9800 })
  );
  fallback.position.y = 0.5;
  fallback.userData.targetPosition = new THREE.Vector3();
  return fallback;
}

export function disposeObject(obj) {
  obj.traverse?.(child => {
    child.geometry?.dispose();
    if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
    else child.material?.dispose();
  });
}

/* ─── Loaders ───────────────────────────────────────────────────────────────── */
function loadOBJModel(objPath, mtlPath = null) {
  return new Promise((resolve, reject) => {
    if (modelCache.has(objPath)) { resolve(modelCache.get(objPath).clone(true)); return; }
    if (mtlPath) {
      mtlLoader.load(mtlPath, materials => {
        materials.preload();
        objLoader.setMaterials(materials);
        objLoader.load(objPath, obj => { modelCache.set(objPath, obj); resolve(obj.clone(true)); }, undefined, reject);
      }, undefined, () => {
        objLoader.load(objPath, obj => { modelCache.set(objPath, obj); resolve(obj.clone(true)); }, undefined, reject);
      });
    } else {
      objLoader.load(objPath, obj => { modelCache.set(objPath, obj); resolve(obj.clone(true)); }, undefined, reject);
    }
  });
}

function loadGLBModel(path) {
  return new Promise((resolve, reject) => {
    if (modelCache.has(path)) { resolve(modelCache.get(path).clone(true)); return; }
    gltfLoader.load(path, gltf => { modelCache.set(path, gltf.scene); resolve(gltf.scene.clone(true)); }, undefined, reject);
  });
}

function prepareOBJModel(model, options = {}) {
  const { scale = 0.02, color = 0x1565c0, y = 0.15, rotationX = 0, rotationY = Math.PI, rotationZ = Math.PI } = options;
  model.scale.set(scale, scale, scale);
  model.rotation.set(rotationX, rotationY, rotationZ);
  model.position.set(0, y, 0);
  model.traverse(child => {
    if (child.isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
      child.material = new THREE.MeshStandardMaterial({ color });
    }
  });
  const wrapper = new THREE.Group();
  wrapper.add(model);
  wrapper.userData.targetPosition = new THREE.Vector3();
  return wrapper;
}