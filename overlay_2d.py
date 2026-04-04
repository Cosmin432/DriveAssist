"""
overlay_2d.py — Drive-Assist 2D Overlay Renderer
Draws bounding boxes, labels, HUD decisions, and risk bar onto an OpenCV frame.
"""

import cv2
import numpy as np
from typing import Optional

# ─── Color palette (BGR) ─────────────────────────────────────────────────────

COLORS = {
    "car": (60, 200, 60),  # green
    "truck": (40, 160, 40),  # dark green
    "person": (50, 50, 220),  # red
    "stop_sign": (30, 200, 220),  # yellow
    "traffic_light": (200, 160, 30),  # teal-ish
    "lane": (200, 200, 50),  # cyan
    "default": (180, 180, 180),  # gray fallback
}

RISK_COLORS = {
    "low": (60, 200, 60),  # green
    "medium": (30, 140, 220),  # orange
    "high": (50, 50, 220),  # red
}

BRAKE_COLORS = {
    "none": (60, 200, 60),
    "light": (30, 140, 220),
    "strong": (50, 50, 220),
}

SPEED_COLORS = {
    "increase": (60, 200, 60),
    "maintain": (180, 180, 180),
    "decrease": (30, 140, 220),
}

LANE_COLORS = {
    "keep": (180, 180, 180),
    "change_left": (200, 160, 30),
    "change_right": (200, 160, 30),
}

# ─── Font config ──────────────────────────────────────────────────────────────

FONT = cv2.FONT_HERSHEY_SIMPLEX
FONT_SMALL = 0.45
FONT_MED = 0.55
FONT_BOLD = 0.65
THICKNESS = 1
BOLD = 2


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _text_bg(frame, text, x, y, font_scale, color, thickness=THICKNESS, pad=4):
    """Draw text with a dark semi-transparent background for readability."""
    (tw, th), baseline = cv2.getTextSize(text, FONT, font_scale, thickness)
    overlay = frame.copy()
    cv2.rectangle(overlay,
                  (x - pad, y - th - pad),
                  (x + tw + pad, y + baseline + pad),
                  (20, 20, 20), -1)
    cv2.addWeighted(overlay, 0.6, frame, 0.4, 0, frame)
    cv2.putText(frame, text, (x, y), FONT, font_scale, color, thickness, cv2.LINE_AA)


def _get_color(cls: str):
    return COLORS.get(cls, COLORS["default"])


# ─── Bounding boxes ───────────────────────────────────────────────────────────

def draw_detections(frame: np.ndarray, detections: list) -> np.ndarray:
    """
    Draw bounding boxes and labels for each detection.
    detections: list of dicts with keys: id, class, distance_m, position, bbox (optional)

    If 'bbox' is present: [x1, y1, x2, y2] in pixels.
    If not present: we synthesize a placeholder box from position + distance.
    """
    h, w = frame.shape[:2]

    for det in detections:
        cls = det.get("class", "default")
        obj_id = det.get("id", 0)
        dist = det.get("distance_m", 0.0)
        position = det.get("position", "front")
        bbox = det.get("bbox", None)
        color = _get_color(cls)

        if bbox:
            x1, y1, x2, y2 = [int(v) for v in bbox]
        else:
            # Synthesize a plausible box from position + distance
            x1, y1, x2, y2 = _synthetic_bbox(w, h, position, dist)

        # Main bounding box
        cv2.rectangle(frame, (x1, y1), (x2, y2), color, BOLD)

        # Corner accents (cleaner look than full box)
        corner = 12
        for cx, cy, dx, dy in [(x1, y1, 1, 1), (x2, y1, -1, 1), (x1, y2, 1, -1), (x2, y2, -1, -1)]:
            cv2.line(frame, (cx, cy), (cx + dx * corner, cy), color, BOLD)
            cv2.line(frame, (cx, cy), (cx, cy + dy * corner), color, BOLD)

        # Label: "car #1  12.5m"
        label = f"{cls} #{obj_id}  {dist:.1f}m"
        _text_bg(frame, label, x1, y1 - 6, FONT_SMALL, color, THICKNESS)

    return frame


def _synthetic_bbox(w, h, position, distance_m):
    """
    Fallback: generate a plausible bbox when Person A hasn't sent real pixel coords.
    Closer objects → bigger box, lower on frame.
    """
    # Normalize distance: 5m = big, 40m = small
    scale = max(0.05, min(0.35, 0.35 * (10.0 / max(distance_m, 5.0))))
    bw = int(w * scale)
    bh = int(h * scale * 0.6)

    center_x = {
        "front": w // 2,
        "front_left": w // 3,
        "front_right": 2 * w // 3,
        "left": w // 5,
        "right": 4 * w // 5,
    }.get(position, w // 2)

    # Closer objects sit lower in frame (vanishing point perspective)
    center_y = int(h * (0.45 + 0.25 * (1 - scale / 0.35)))

    x1 = max(0, center_x - bw // 2)
    y1 = max(0, center_y - bh // 2)
    x2 = min(w, center_x + bw // 2)
    y2 = min(h, center_y + bh // 2)
    return x1, y1, x2, y2


# ─── HUD ─────────────────────────────────────────────────────────────────────

def draw_hud(frame: np.ndarray, decisions: dict, timestamp: float = 0.0) -> np.ndarray:
    """
    Draw the decision HUD in the bottom-left corner.
    Also draws a risk bar on the right edge.
    """
    h, w = frame.shape[:2]

    brake = decisions.get("brake", "none")
    speed = decisions.get("speed", "maintain")
    lane = decisions.get("lane", "keep")
    risk = decisions.get("risk", "low")

    # ── Semi-transparent HUD background panel ──
    panel_x, panel_y = 10, h - 140
    panel_w, panel_h = 340, 125
    overlay = frame.copy()
    cv2.rectangle(overlay, (panel_x, panel_y), (panel_x + panel_w, panel_y + panel_h),
                  (15, 15, 15), -1)
    cv2.addWeighted(overlay, 0.65, frame, 0.35, 0, frame)

    # ── Header ──
    cv2.putText(frame, "DRIVE-ASSIST", (panel_x + 8, panel_y + 18),
                FONT, FONT_SMALL, (200, 200, 200), THICKNESS, cv2.LINE_AA)
    cv2.putText(frame, f"T={timestamp:.1f}s", (panel_x + 200, panel_y + 18),
                FONT, FONT_SMALL, (120, 120, 120), THICKNESS, cv2.LINE_AA)
    cv2.line(frame, (panel_x + 8, panel_y + 24), (panel_x + panel_w - 8, panel_y + 24),
             (60, 60, 60), 1)

    # ── Decision rows ──
    rows = [
        ("BRAKE", brake.upper(), BRAKE_COLORS.get(brake, (180, 180, 180)), 42),
        ("SPEED", speed.upper(), SPEED_COLORS.get(speed, (180, 180, 180)), 62),
        ("LANE", lane.upper(), LANE_COLORS.get(lane, (180, 180, 180)), 82),
        ("RISK", risk.upper(), RISK_COLORS.get(risk, (180, 180, 180)), 102),
    ]

    for label, value, color, y_off in rows:
        y = panel_y + y_off
        # Label (dim)
        cv2.putText(frame, label + ":", (panel_x + 8, y),
                    FONT, FONT_SMALL, (140, 140, 140), THICKNESS, cv2.LINE_AA)
        # Value (bright, colored)
        cv2.putText(frame, value, (panel_x + 80, y),
                    FONT, FONT_MED, color, BOLD, cv2.LINE_AA)

    # ── Risk bar (right edge) ──
    frame = draw_risk_bar(frame, risk)

    return frame


def draw_risk_bar(frame: np.ndarray, risk: str) -> np.ndarray:
    """Vertical risk indicator bar on the right edge."""
    h, w = frame.shape[:2]
    bar_x = w - 28
    bar_h = int(h * 0.6)
    bar_y_start = (h - bar_h) // 2
    bar_w = 14

    levels = {"low": 1, "medium": 2, "high": 3}
    level = levels.get(risk, 1)

    # Background
    cv2.rectangle(frame, (bar_x, bar_y_start), (bar_x + bar_w, bar_y_start + bar_h),
                  (30, 30, 30), -1)

    # Segments
    seg_h = bar_h // 3
    seg_colors = [
        (50, 50, 220),  # top = high = red
        (30, 140, 220),  # mid = medium = orange
        (60, 200, 60),  # bottom = low = green
    ]
    seg_labels = ["H", "M", "L"]

    for i, (sc, sl) in enumerate(zip(seg_colors, seg_labels)):
        sy = bar_y_start + i * seg_h
        seg_level = 3 - i  # top=3(high), mid=2, bot=1(low)
        alpha = 0.9 if seg_level <= level else 0.2

        overlay = frame.copy()
        cv2.rectangle(overlay, (bar_x + 1, sy + 1), (bar_x + bar_w - 1, sy + seg_h - 1),
                      sc, -1)
        cv2.addWeighted(overlay, alpha, frame, 1 - alpha, 0, frame)

        cv2.putText(frame, sl,
                    (bar_x + 3, sy + seg_h - 5),
                    FONT, 0.35, (230, 230, 230), 1, cv2.LINE_AA)

    # Border
    cv2.rectangle(frame, (bar_x, bar_y_start), (bar_x + bar_w, bar_y_start + bar_h),
                  (80, 80, 80), 1)

    # Label below
    cv2.putText(frame, "RISK", (bar_x - 2, bar_y_start + bar_h + 14),
                FONT, 0.32, (150, 150, 150), 1, cv2.LINE_AA)

    return frame


# ─── Lane lines (optional, called when lane detection data is available) ──────

def draw_lane_lines(frame: np.ndarray, left_line=None, right_line=None,
                    lane_decision: str = "keep") -> np.ndarray:
    """
    Draw detected lane lines if available.
    left_line / right_line: list of (x, y) points or None.
    """
    color = {
        "keep": (60, 200, 60),
        "change_left": (200, 160, 30),
        "change_right": (200, 160, 30),
    }.get(lane_decision, (60, 200, 60))

    if left_line and len(left_line) >= 2:
        pts = np.array(left_line, dtype=np.int32)
        cv2.polylines(frame, [pts], False, color, 3, cv2.LINE_AA)

    if right_line and len(right_line) >= 2:
        pts = np.array(right_line, dtype=np.int32)
        cv2.polylines(frame, [pts], False, color, 3, cv2.LINE_AA)

    return frame


# ─── Master render function ───────────────────────────────────────────────────

def render_frame(
        frame: np.ndarray,
        state: dict,
        show_hud: bool = True,
        left_line=None,
        right_line=None,
) -> np.ndarray:
    """
    Main entry point for Person B.

    Args:
        frame:      Raw OpenCV frame (BGR numpy array)
        state:      The JSON state dict from server / output.json
        show_hud:   Whether to draw the decision HUD
        left_line:  Optional lane line points [(x,y), ...]
        right_line: Optional lane line points [(x,y), ...]

    Returns:
        Annotated frame (BGR numpy array)
    """
    detections = state.get("detections", [])
    decisions = state.get("decisions", {})
    timestamp = state.get("timestamp", 0.0)

    # 1. Lane lines (behind boxes)
    lane_dec = decisions.get("lane", "keep")
    frame = draw_lane_lines(frame, left_line, right_line, lane_dec)

    # 2. Detection boxes
    frame = draw_detections(frame, detections)

    # 3. HUD
    if show_hud:
        frame = draw_hud(frame, decisions, timestamp)

    return frame


# ─── Quick smoke test ─────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Creates a dummy 720p frame and renders a test state
    test_frame = np.zeros((720, 1280, 3), dtype=np.uint8)
    test_frame[:] = (40, 40, 40)  # dark gray background

    test_state = {
        "timestamp": 3.5,
        "frame": 7,
        "detections": [
            {"id": 1, "class": "car", "distance_m": 12.0, "position": "front"},
            {"id": 2, "class": "person", "distance_m": 6.5, "position": "front_left"},
            {"id": 3, "class": "stop_sign", "distance_m": 20.0, "position": "front_right"},
        ],
        "decisions": {
            "brake": "strong",
            "lane": "keep",
            "speed": "decrease",
            "risk": "high",
        },
    }

    out = render_frame(test_frame, test_state)
    cv2.imwrite("test_overlay.png", out)
    print("Saved test_overlay.png — check it visually!")

    # Optional: show in window (comment out if no display)
    # cv2.imshow("overlay test", out)
    # cv2.waitKey(0)
    # cv2.destroyAllWindows()