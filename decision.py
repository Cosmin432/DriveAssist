"""
Driving hints from Ultra-Fast-Lane-Detection (lane / speed / risk only — not brake).
Brake comes from object detection in backend.decision.
"""

from __future__ import annotations

from typing import Any

OFFSET_HARD_PX = 60.0
OFFSET_SOFT_PX = 26.0
CONF_HIGH = 0.58
CONF_MED = 0.38
CONF_LOW = 0.22

SAFE_DEFAULT: dict[str, str] = {
    "brake": "none",
    "lane": "keep",
    "speed": "maintain",
    "risk": "medium",
}


def make_decision(lane_result: dict[str, Any] | None) -> dict[str, str]:
    """
    lane_result: UFLD infer_frame output.
    Never sets brake to light — leave brake to YOLO merge (avoids constant light brake).
    """
    if not lane_result:
        return dict(SAFE_DEFAULT)

    conf = float(lane_result.get("lane_confidence") or 0.0)
    offset = float(lane_result.get("lane_center_offset_px") or 0.0)
    lanes = lane_result.get("lanes") or []
    has_pair = any(l.get("lane_id") == "left" for l in lanes) and any(
        l.get("lane_id") == "right" for l in lanes
    )

    brake = "none"
    lane = "keep"
    speed = "maintain"
    risk = "low"

    if not has_pair and conf < 1e-6:
        return dict(SAFE_DEFAULT)

    if not has_pair or conf < CONF_LOW:
        return {
            "brake": "none",
            "lane": "keep",
            "speed": "decrease",
            "risk": "high",
        }

    if conf < CONF_MED:
        risk = "medium"
        speed = "decrease"
    elif conf < CONF_HIGH:
        risk = "medium"
    else:
        risk = "low"

    if abs(offset) <= OFFSET_SOFT_PX:
        lane = "keep"
    elif offset < -OFFSET_HARD_PX:
        lane = "change_right"
    elif offset > OFFSET_HARD_PX:
        lane = "change_left"
    elif offset < -OFFSET_SOFT_PX:
        lane = "change_right"
    elif offset > OFFSET_SOFT_PX:
        lane = "change_left"

    return {"brake": brake, "lane": lane, "speed": speed, "risk": risk}
