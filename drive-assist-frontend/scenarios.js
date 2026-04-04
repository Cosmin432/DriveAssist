export const DEMO_SCENARIOS = [
  {
    name: 'Highway Cruise',
    description: 'Three-lane highway, clear ahead',
    duration: 4000,
    data: {
      timestamp: 0, frame: 0,
      road: { type: 'straight', lanes: 3, width: 18, length: 200, separator: 'dashed_white' },
      junction: null,
      detections: [
        { id: 1, class: 'car',   distance_m: 35, position: 'front_right', lane:  1, junction_road: false },
        { id: 2, class: 'truck', distance_m: 50, position: 'front',       lane:  0, junction_road: false },
      ],
      decisions: { brake: 'none', lane: 'keep', speed: 'maintain', risk: 'low' },
    },
  },
  {
    name: 'Car Cutting In',
    description: 'Vehicle merging from the right, increase following distance',
    duration: 4000,
    data: {
      timestamp: 4, frame: 8,
      road: { type: 'straight', lanes: 3, width: 18, length: 200, separator: 'dashed_white' },
      junction: null,
      detections: [
        { id: 1, class: 'car', distance_m: 12, position: 'front',       lane:  0, junction_road: false },
        { id: 2, class: 'car', distance_m: 18, position: 'front_right', lane:  1, junction_road: false },
        { id: 3, class: 'car', distance_m: 40, position: 'front_left',  lane: -1, junction_road: false },
      ],
      decisions: { brake: 'light', lane: 'keep', speed: 'decrease', risk: 'medium' },
    },
  },
  {
    name: 'City Street',
    description: 'Two-lane city road, pedestrian crossing',
    duration: 4000,
    data: {
      timestamp: 8, frame: 16,
      road: { type: 'straight', lanes: 2, width: 12, length: 200, separator: 'solid_yellow' },
      junction: null,
      detections: [
        { id: 1, class: 'person', distance_m: 8,  position: 'front',      lane:  0, junction_road: false },
        { id: 2, class: 'car',    distance_m: 20, position: 'front_left', lane: -1, junction_road: false },
      ],
      decisions: { brake: 'strong', lane: 'keep', speed: 'decrease', risk: 'high' },
    },
  },
  {
    name: 'T-Junction Approach',
    description: 'Car entering from the left side road',
    duration: 5000,
    data: {
      timestamp: 12, frame: 24,
      road: { type: 'straight', lanes: 2, width: 12, length: 200, separator: 'double_yellow' },
      junction: { type: 'T', distance_m: 28, road_in: { direction: 'left', lanes: 2, width: 11, length: 60 } },
      detections: [
        { id: 1, class: 'car', distance_m: 28, position: 'left',  lane: -2, junction_road: true },
        { id: 2, class: 'car', distance_m: 22, position: 'front', lane:  0, junction_road: false },
      ],
      decisions: { brake: 'light', lane: 'keep', speed: 'decrease', risk: 'medium' },
    },
  },
  {
    name: 'Crossroads',
    description: 'Vehicles crossing from both sides',
    duration: 5000,
    data: {
      timestamp: 17, frame: 34,
      road: { type: 'straight', lanes: 2, width: 12, length: 200, separator: 'solid_white' },
      junction: { type: 'cross', distance_m: 28, road_in: { direction: 'both', lanes: 2, width: 11, length: 60 } },
      detections: [
        { id: 1, class: 'car', distance_m: 28, position: 'right', lane:  2, junction_road: true },
        { id: 2, class: 'car', distance_m: 28, position: 'left',  lane: -2, junction_road: true },
        { id: 3, class: 'car', distance_m: 10, position: 'front', lane:  0, junction_road: false },
      ],
      decisions: { brake: 'strong', lane: 'keep', speed: 'decrease', risk: 'high' },
    },
  },
  {
    name: 'Stop Sign',
    description: 'Stop sign detected ahead, full stop required',
    duration: 4000,
    data: {
      timestamp: 22, frame: 44,
      road: { type: 'straight', lanes: 2, width: 12, length: 200, separator: 'solid_yellow' },
      junction: { type: 'T', distance_m: 20, road_in: { direction: 'right', lanes: 1, width: 8, length: 50 } },
      detections: [
        { id: 1, class: 'stop_sign', distance_m: 18, position: 'front', lane: 0, junction_road: false },
      ],
      decisions: { brake: 'strong', lane: 'keep', speed: 'decrease', risk: 'high' },
    },
  },
  {
    name: 'Lane Change Left',
    description: 'Slow truck ahead, safe to overtake on the left',
    duration: 4000,
    data: {
      timestamp: 26, frame: 52,
      road: { type: 'straight', lanes: 3, width: 18, length: 200, separator: 'dashed_white' },
      junction: null,
      detections: [
        { id: 1, class: 'truck', distance_m: 15, position: 'front',      lane:  0, junction_road: false },
        { id: 2, class: 'car',   distance_m: 45, position: 'front_left', lane: -1, junction_road: false },
      ],
      decisions: { brake: 'none', lane: 'change_left', speed: 'maintain', risk: 'low' },
    },
  },
];
