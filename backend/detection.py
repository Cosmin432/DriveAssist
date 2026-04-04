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
# HELPER FUNCTIONS
# ===============================
def estimate_distance(bbox, frame_width, frame_height):
    """
    Estimează distanța față de obiect pe baza dimensiunii bbox
    (simplificare, bounding box mai mare = mai aproape)
    """
    x1, y1, x2, y2 = bbox
    box_area = (x2 - x1) * (y2 - y1)
    frame_area = frame_width * frame_height
    distance_est = max(0.1, 100 * (1 - box_area / frame_area))
    return round(distance_est, 2)

# ===============================
# DETECTOR
# ===============================
class Detector:
    def __init__(self, video_path=VIDEO_PATH, model_path=MODEL_PATH):
        self.cap = cv2.VideoCapture(video_path)
        if not self.cap.isOpened():
            raise ValueError(f"Nu s-a putut deschide video-ul: {video_path}")
        self.model = YOLO(model_path)
        self.frame_id = 0
        self.tracker_memory = {}
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

        for r in results.boxes:
            cls_name = self.model.names[int(r.cls[0])]
            bbox = r.xyxy[0].tolist()
            conf = float(r.conf[0])
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

            detection = {
                "id": self.next_id,
                "class": cls_name,
                "bbox": bbox,
                "confidence": conf,
                "estimated_distance": est_dist,
                "lateral_position": lateral_pos
            }
            detections.append(detection)
            self.next_id += 1

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

    def detect_lane_info(self, frame):
        """
        Detectare simplificata benzi folosind OpenCV.
        Returneaza dict cu num_lanes, curbe, is_main_road si current_lane.
        """
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        blur = cv2.GaussianBlur(gray, (5,5), 0)
        edges = cv2.Canny(blur, 50, 150)

        height, width = edges.shape

        # ROI (doar partea de jos a imaginii)
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

        left_lines = []
        right_lines = []
        x_positions = []

        if lines is not None:
            for line in lines:
                x1,y1,x2,y2 = line[0]
                slope = (y2 - y1) / (x2 - x1 + 1e-6)

                # ignoram linii aproape orizontale
                if abs(slope) < 0.3 or abs(y2 - y1) < 30:
                    continue

                x_positions.append((x1 + x2) / 2)

                if slope < 0:
                    left_lines.append(line)
                else:
                    right_lines.append(line)

        # Estimare numar benzi
        if x_positions:
            x_positions = sorted(x_positions)
            # Aproximam benzile ca grupuri de linii
            lane_thresh = width / 8  # distanta minima intre linii
            lanes = [x_positions[0]]
            for x in x_positions[1:]:
                if x - lanes[-1] > lane_thresh:
                    lanes.append(x)
            num_lanes = len(lanes)
        else:
            num_lanes = 2

        # Limitam realist intre 2 si 5
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

        # Estimare banda ego (masina centrata)
        frame_center = width / 2
        lane_width = width / num_lanes
        current_lane = int(frame_center // lane_width) + 1  # indexare de la 1

        return {
            "num_lanes": num_lanes,
            "curves": [curve] if curve else [],
            "is_main_road": num_lanes >= 3,
            "current_lane": current_lane
        }

    def release(self):
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