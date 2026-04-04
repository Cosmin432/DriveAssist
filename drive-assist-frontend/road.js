import * as THREE from 'three';

const dynamicRoadObjects = [];

export function clearDynamicRoad(scene) {
  dynamicRoadObjects.forEach(obj => {
    scene.remove(obj);
    obj.traverse?.(child => {
      child.geometry?.dispose();
      if (Array.isArray(child.material)) child.material.forEach(m => m.dispose());
      else child.material?.dispose();
    });
  });
  dynamicRoadObjects.length = 0;
}

export function buildRoad(scene, roadDef) {
  const { lanes, width, length, separator } = roadDef;
  const halfLen = length / 2;

  // Road surface
  add(scene, plane(width, length, 0x3c3c3c, { rx: -Math.PI/2, z: -halfLen + 5 }));

  // Sidewalks + kerbs
  [-1, 1].forEach(s => {
    add(scene, plane(3.5, length, 0x6e6558, { rx: -Math.PI/2, y: 0.003, x: s * (width/2 + 1.75), z: -halfLen + 5 }));
    add(scene, box(0.25, 0.12, length, 0x8a8070, { y: 0.06, x: s * (width/2 + 0.12), z: -halfLen + 5 }));
  });

  // Edge white lines
  [-width/2, width/2].forEach(x =>
    add(scene, plane(0.2, length, 0xffffff, { rx: -Math.PI/2, y: 0.01, x, z: -halfLen + 5 }))
  );

  // Interior lane separators
  const laneW = width / lanes;
  for (let i = 1; i < lanes; i++) {
    buildSeparator(scene, -width/2 + i * laneW, length, separator || 'dashed_white');
  }

  // Hide scrolling center markers on solid-line roads
  if (separator !== 'dashed_white') {
    add(scene, plane(0.25, length, 0x3c3c3c, { rx: -Math.PI/2, y: 0.015, z: -halfLen + 5 }));
  }
}

function buildSeparator(scene, x, length, type) {
  const halfLen = length / 2;

  if (type === 'dashed_white') {
    for (let z = 5; z > 5 - length; z -= 10)
      add(scene, plane(0.22, 4, 0xffffff, { rx: -Math.PI/2, y: 0.012, x, z: z - 2 }));

  } else if (type === 'solid_yellow') {
    add(scene, plane(0.25, length, 0xffc107, { rx: -Math.PI/2, y: 0.011, x, z: -halfLen + 5 }));

  } else if (type === 'double_yellow') {
    [-0.2, 0.2].forEach(dx =>
      add(scene, plane(0.18, length, 0xffc107, { rx: -Math.PI/2, y: 0.011, x: x + dx, z: -halfLen + 5 }))
    );

  } else { // solid_white
    add(scene, plane(0.22, length, 0xfafafa, { rx: -Math.PI/2, y: 0.011, x, z: -halfLen + 5 }));
  }
}

export function buildJunction(scene, junctionDef, mainWidth) {
  if (!junctionDef) return;
  const { distance_m, road_in } = junctionDef;
  const jZ   = -(distance_m || 28);
  const jLen = road_in.length || 60;
  const jW   = road_in.width  || 12;
  const dirs = road_in.direction === 'both' ? ['left', 'right'] : [road_in.direction];

  dirs.forEach(dir => {
    const s = dir === 'left' ? -1 : 1;

    // Side road surface
    const jRoad = new THREE.Mesh(
      new THREE.PlaneGeometry(jLen, jW),
      new THREE.MeshStandardMaterial({ color: 0x393939 })
    );
    jRoad.rotation.x = -Math.PI / 2;
    jRoad.rotation.z = Math.PI / 2;
    jRoad.position.set(s * (mainWidth/2 + jLen/2), 0, jZ);
    add(scene, jRoad);

    // Sidewalks on side road
    [-1, 1].forEach(sw => {
      const swMesh = new THREE.Mesh(
        new THREE.PlaneGeometry(jLen, 3.5),
        new THREE.MeshStandardMaterial({ color: 0x6e6558 })
      );
      swMesh.rotation.x = -Math.PI / 2;
      swMesh.rotation.z = Math.PI / 2;
      swMesh.position.set(s * (mainWidth/2 + jLen/2), 0.003, jZ + sw * (jW/2 + 1.75));
      add(scene, swMesh);
      add(scene, box(jLen, 0.12, 0.25, 0x8a8070, { y: 0.06, x: s * (mainWidth/2 + jLen/2), z: jZ + sw * (jW/2 + 0.12) }));
    });

    // Intersection patch
    add(scene, plane(mainWidth/2 + 1, jW + 0.4, 0x3a3a3a, { rx: -Math.PI/2, y: 0.005, x: s * mainWidth/4, z: jZ }));

    // Stop line
    add(scene, plane(mainWidth, 0.4, 0xffffff, { rx: -Math.PI/2, y: 0.012, z: jZ - jW/2 - 0.6 }));

    // Give-way markers
    [-0.4, 0.4].forEach(dz =>
      add(scene, plane(0.5, 0.5, 0xffffff, { rx: -Math.PI/2, y: 0.013, x: s * mainWidth/2, z: jZ + dz }))
    );

    // Lane dashes on side road
    const laneW = jW / road_in.lanes;
    for (let i = 1; i < road_in.lanes; i++) {
      const lz = jZ - jW/2 + i * laneW;
      for (let j = 3; j < jLen - 3; j += 9) {
        const seg = new THREE.Mesh(
          new THREE.PlaneGeometry(4, 0.2),
          new THREE.MeshStandardMaterial({ color: 0xffffff })
        );
        seg.rotation.x = -Math.PI / 2;
        seg.position.set(s * (mainWidth/2 + j), 0.013, lz);
        add(scene, seg);
      }
    }

    // Edge lines on side road
    [-jW/2, jW/2].forEach(dz => {
      const el = new THREE.Mesh(
        new THREE.PlaneGeometry(jLen, 0.2),
        new THREE.MeshStandardMaterial({ color: 0xfafafa })
      );
      el.rotation.x = -Math.PI / 2;
      el.rotation.z = Math.PI / 2;
      el.position.set(s * (mainWidth/2 + jLen/2), 0.012, jZ + dz);
      add(scene, el);
    });
  });
}

/* ─── Geometry helpers ──────────────────────────────────────────────────────── */
function plane(w, h, color, t = {}) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ color }));
  m.receiveShadow = true;
  if (t.rx) m.rotation.x = t.rx;
  if (t.rz) m.rotation.z = t.rz;
  m.position.set(t.x || 0, t.y || 0, t.z || 0);
  return m;
}

function box(w, h, d, color, t = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color }));
  m.receiveShadow = true;
  m.position.set(t.x || 0, t.y || 0, t.z || 0);
  return m;
}

function add(scene, object) {
  scene.add(object);
  dynamicRoadObjects.push(object);
}
