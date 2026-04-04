import cv2
import sys
import os
import torch
from ultralytics import YOLO
import numpy as np


# ===============================
# CONFIGURARE
# ===============================
VIDEO_PATH = "../video.mp4"
MODEL_PATH = "yolov8n.pt"
CONF_THRESHOLD = 0.3

# ===============================
# DETECTOR
# ===============================
class Detector:
    def __init__(self, video_path=VIDEO_PATH, model_path=MODEL_PATH):
        """
        video_path=None: do not open a capture (caller supplies frames, e.g. main.py + UFLD).
        Default VIDEO_PATH keeps backward compatibility for scripts that call Detector().
        """
        self.cap = None
        if video_path is not None and str(video_path).strip() != "":
            self.cap = cv2.VideoCapture(video_path)
            if not self.cap.isOpened():
                raise ValueError(f"Nu s-a putut deschide video-ul: {video_path}")
        self.model = YOLO(model_path)
        self.frame_id = 0
        self.next_id = 0

    def get_frame(self):
        ret, frame = self.cap.read()
        if not ret:
            return None
        self.frame_id += 1
        return frame

    def detect_frame(self, frame):
        results = self.model(frame)[0]
        detections = []
        traffic_signs = []

        frame_height, frame_width = frame.shape[:2]

        for r in results.boxes:
            cls_name = self.model.names[int(r.cls[0])]
            bbox = r.xyxy[0].tolist()
            est_dist = self.estimate_distance(bbox)
            lateral_pos = self.get_lateral_position(frame, bbox)

            # Detectare semne de circulatie
            if cls_name in ["stop_sign", "speed_limit_low", "speed_limit_high",
                            "lane_change_left", "lane_change_right"]:
                sign_map = {
                    "stop_sign": "stop",
                    "speed_limit_low": "speed_limit_low",
                    "speed_limit_high": "speed_limit_high",
                    "lane_change_left": "lane_change_left",
                    "lane_change_right": "lane_change_right"
                }
                traffic_signs.append(sign_map[cls_name])
                continue

            detections.append({
                "id": self.next_id,
                "class": cls_name,
                "bbox": bbox,
                "estimated_distance": est_dist,
                "lateral_position": lateral_pos
            })
            self.next_id += 1

        # Adaugam orientarea obiectelor fata de banda ego
        lane_info = self.detect_lane_info(frame)
        detections = self.annotate_orientation(
            detections, lane_info, frame_width=frame_width
        )

        return detections, traffic_signs

    def detect_traffic_signs(self, frame):
        _, traffic_signs = self.detect_frame(frame)
        return traffic_signs

    def get_env_conditions(self, frame):
        env_conditions = []
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        mean_brightness = gray.mean()
        if mean_brightness < 50:
            env_conditions.append("low_visibility")
        elif mean_brightness < 100:
            env_conditions.append("wet_road")
        return env_conditions

    def estimate_distance(self, bbox):
        y1, y2 = bbox[1], bbox[3]
        height = y2 - y1
        distance = 2000 / max(height, 1)
        return round(distance, 2)

    def get_lateral_position(self, frame, bbox):
        frame_center = frame.shape[1] / 2
        box_center = (bbox[0] + bbox[2]) / 2
        rel_pos = box_center - frame_center
        if rel_pos < -50:
            return -1
        elif rel_pos > 50:
            return 1
        else:
            return 0

    def detect_lane_info(self, frame, history_frames=5):
        """
        Detectare benzi folosind OpenCV, histogramă și medie pe ultimele frame-uri.
        history_frames: numarul de frame-uri pentru medie (stabilizare)
        """
        if not hasattr(self, "_lane_history"):
            self._lane_history = []

        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5,5), 0)
        edges = cv2.Canny(blur, 50, 150)

        height, width = edges.shape

        # ROI
        mask = np.zeros_like(edges)
        polygon = np.array([[
            (0, height),
            (width, height),
            (width, int(height*0.6)),
            (0, int(height*0.6))
        ]], np.int32)
        cv2.fillPoly(mask, polygon, 255)
        cropped = cv2.bitwise_and(edges, mask)

        # Detectare linii
        lines = cv2.HoughLinesP(
            cropped,
            rho=1,
            theta=np.pi/180,
            threshold=50,
            minLineLength=50,
            maxLineGap=50
        )

        x_positions = []
        if lines is not None:
            for line in lines:
                x1,y1,x2,y2 = line[0]
                slope = (y2 - y1) / (x2 - x1 + 1e-6)
                if abs(slope) < 0.3 or abs(y2 - y1) < 30:
                    continue
                x_positions.append((x1 + x2)/2)

        # Adaugam pozitiile x in istoric
        self._lane_history.append(x_positions)
        if len(self._lane_history) > history_frames:
            self._lane_history.pop(0)

        # Facem media pozitiilor x pe ultimele frame-uri
        all_x = [x for hist in self._lane_history for x in hist]
        all_x.sort()

        # Grupare linii apropiate
        lanes = []
        lane_thresh = width / 8
        for x in all_x:
            if not lanes or x - lanes[-1] > lane_thresh:
                lanes.append(x)

        num_lanes = len(lanes)
        num_lanes = min(max(num_lanes, 2), 5)

        # Curbe (medie slope)
        curve = None
        if lines is not None and len(lines) > 0:
            slopes = [(y2 - y1)/(x2 - x1 + 1e-6) for x1,y1,x2,y2 in lines[:,0]]
            avg_slope = np.mean(slopes)
            if avg_slope > 0.2:
                curve = {"direction": "right", "degrees": int(abs(avg_slope)*50)}
            elif avg_slope < -0.2:
                curve = {"direction": "left", "degrees": int(abs(avg_slope)*50)}

        # Banda ego (centrata)
        frame_center = width / 2
        lane_width = width / num_lanes
        current_lane = int(frame_center // lane_width) + 1

        # Drumuri adiacente
        adjacent_lanes = []
        if current_lane > 1:
            adjacent_lanes.append({"side": "left", "angle": 0})
        if current_lane < num_lanes:
            adjacent_lanes.append({"side": "right", "angle": 0})

        return {
            "num_lanes": num_lanes,
            "curves": [curve] if curve else [],
            "is_main_road": num_lanes >= 3,
            "current_lane": current_lane,
            "adjacent_lanes": adjacent_lanes
        }

    def annotate_orientation(self, detections, lane_info, frame_width=None):
        """
        same = same carriageway (any lane same direction). opposite = other half of road
        (typical undivided 4-lane: lanes 1–2 vs 3–4). n<=2: always same.
        """
        fw = float(frame_width if frame_width is not None else 1920)
        n = max(int(lane_info.get("num_lanes", 2)), 1)
        ego_lane = max(1, min(n, int(lane_info.get("current_lane", 1))))
        ego_idx = ego_lane - 1

        for d in detections:
            bbox = d["bbox"]
            cx = (bbox[0] + bbox[2]) / 2.0
            lane_idx = int(np.clip((cx / max(fw, 1.0)) * n, 0, n - 1))

            if n <= 2:
                d["orientation"] = "same"
                continue

            ego_half = 0 if ego_idx < n / 2.0 else 1
            obj_half = 0 if lane_idx < n / 2.0 else 1
            d["orientation"] = "same" if ego_half == obj_half else "opposite"

        return detections

    def release(self):
        if self.cap is not None:
            self.cap.release()


# ===============================
# TEST SCRIPT
# ===============================
if __name__ == "__main__":
    detector = Detector()
    while True:
        frame = detector.get_frame()
        if frame is None:
            break
        dets, signs = detector.detect_frame(frame)
        env = detector.get_env_conditions(frame)
        lanes = detector.detect_lane_info(frame)

        print(f"Frame {detector.frame_id}:")
        print("Detections:", dets)
        print("Traffic signs:", signs)
        print("Environment:", env)
        print("Lane info:", lanes)

    detector.release()