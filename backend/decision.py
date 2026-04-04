"""
Brake / speed decrease only for: vehicle ahead (same direction), STOP, red traffic light.
Other hazards adjust risk or lane hints without forcing brake in this policy.
"""

from __future__ import annotations

import cv2
import numpy as np


def _norm_class(c: str) -> str:
    return (c or "").lower().replace(" ", "_").replace("-", "_")


def _is_traffic_light(cls: str) -> bool:
    n = _norm_class(cls)
    return n == "traffic_light" or ("traffic" in n and "light" in n)


def _is_stop_sign(cls: str) -> bool:
    n = _norm_class(cls)
    return "stop" in n and "sign" in n


def _bbox_red_dominant(bgr: np.ndarray, bbox: list) -> bool:
    """Heuristic: enough red HSV pixels in crop → treat as red light."""
    x1, y1, x2, y2 = map(int, bbox)
    h, w = bgr.shape[:2]
    x1, x2 = max(0, x1), min(w, x2)
    y1, y2 = max(0, y1), min(h, y2)
    if x2 <= x1 or y2 <= y1:
        return False
    roi = bgr[y1:y2, x1:x2]
    if roi.size == 0:
        return False
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    m1 = cv2.inRange(hsv, (0, 60, 50), (12, 255, 255))
    m2 = cv2.inRange(hsv, (168, 60, 50), (180, 255, 255))
    mask = cv2.bitwise_or(m1, m2)
    ratio = float(np.count_nonzero(mask)) / float(mask.size)
    return ratio >= 0.06


def _compute_triggers(
    frame_bgr: np.ndarray | None,
    detections: list,
    traffic_signs: list,
) -> dict[str, bool]:
    vehicle_ahead = False
    stop_sign = "stop" in traffic_signs
    red_traffic_light = False

    for d in detections:
        cls = d.get("class", "")
        if _is_stop_sign(cls):
            stop_sign = True

        dist = float(d.get("estimated_distance", 999))
        lateral = d.get("lateral_position", 0)
        orient = (d.get("orientation") or "same").lower()
        vcls = _norm_class(cls)

        if vcls in ("car", "truck", "bus") and orient != "opposite":
            if lateral == 0 and dist < 30.0:
                vehicle_ahead = True

        if frame_bgr is not None and _is_traffic_light(cls):
            if _bbox_red_dominant(frame_bgr, d.get("bbox", [0, 0, 0, 0])):
                red_traffic_light = True

    return {
        "vehicle_ahead": vehicle_ahead,
        "stop_sign": stop_sign,
        "red_traffic_light": red_traffic_light,
    }


def make_decision(
    detections,
    traffic_signs=None,
    env_conditions=None,
    frame_bgr=None,
):
    if traffic_signs is None:
        traffic_signs = []
    if env_conditions is None:
        env_conditions = []

    brake = "none"
    lane = "keep"
    speed = "maintain"
    risk = "low"

    lateral_near_m = 6.0
    vehicle_classes = frozenset({"car", "truck", "bus"})

    triggers = _compute_triggers(frame_bgr, list(detections), list(traffic_signs))

    for obj in detections:
        cls = obj.get("class", "")
        dist = float(obj.get("estimated_distance", 999))
        lateral = obj.get("lateral_position", 0)
        orient = (obj.get("orientation") or "same").lower()

        if cls in vehicle_classes and orient == "opposite":
            continue

        if cls in ["car", "truck", "bus"]:
            if lateral == -1 and dist < lateral_near_m:
                lane = "change_right"
                risk = "medium" if risk == "low" else risk
            if lateral == 1 and dist < lateral_near_m:
                lane = "keep"
                risk = "medium" if risk == "low" else risk

    for sign in traffic_signs:
        if sign == "speed_limit_high" and brake == "none":
            speed = "increase"
            lane = "keep"
            risk = "low"
        elif sign == "lane_change_left" and brake == "none":
            lane = "change_left"
            risk = "medium"
        elif sign == "lane_change_right" and brake == "none":
            lane = "change_right"
            risk = "medium"

    for cond in env_conditions:
        if cond in ["wet_road", "fog", "low_visibility"] and risk == "low":
            risk = "medium"

    # ── Brake / speed: ONLY stop, red light, or vehicle ahead ─────────────
    if triggers["stop_sign"] or triggers["red_traffic_light"]:
        brake = "strong"
        speed = "decrease"
        risk = "high"
        lane = "keep"
    elif triggers["vehicle_ahead"]:
        brake = "light"
        speed = "decrease"
        risk = "medium" if risk != "high" else risk

    return {
        "brake": brake,
        "lane": lane,
        "speed": speed,
        "risk": risk,
        "alert_triggers": {
            "vehicle_ahead": triggers["vehicle_ahead"],
            "stop_sign": triggers["stop_sign"],
            "red_traffic_light": triggers["red_traffic_light"],
        },
    }
