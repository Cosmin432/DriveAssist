"""
Drive-Assist: video → UFLD lanes + YOLO → merged decisions → output.json + WebSocket + OpenCV preview.
"""

from __future__ import annotations

import logging
import os
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np

import decision as lane_decision_mod
from backend.decision import make_decision as object_decision
from lane_detection import UltraFastLaneDetector
from output import write_snapshot
from server import start_server_background, update_state

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
log = logging.getLogger(__name__)

EMIT_INTERVAL_S = 0.5
SHOW_PREVIEW = os.environ.get("NO_GUI", "").lower() not in ("1", "true", "yes")
WINDOW_NAME = "Drive Assist — YOLO + lanes"
YOLO_MODEL = os.environ.get("YOLO_MODEL", "yolov8n.pt")


def _pick_video_path() -> str:
    env = os.environ.get("VIDEO_PATH")
    if env and Path(env).is_file():
        return env
    root = Path(__file__).resolve().parent
    for name in ("video.mp4", "short.mp4"):
        p = root / name
        if p.is_file():
            return str(p)
    return str(root / "video.mp4")


def _open_capture(path: str) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(path, cv2.CAP_FFMPEG)
    if cap.isOpened():
        return cap
    cap.release()
    return cv2.VideoCapture(path)


def _merge_decisions(lane_d: dict, obj_d: dict) -> dict:
    """Lane model never sets brake; object model owns brake (only STOP / red / vehicle ahead)."""
    rr = {"low": 0, "medium": 1, "high": 2}
    rs = {"maintain": 0, "increase": 1, "decrease": 2}

    brake = obj_d.get("brake", "none")
    lr, obj_r = lane_d.get("risk", "low"), obj_d.get("risk", "low")
    risk = max((lr, obj_r), key=lambda x: rr.get(x, 0))
    ls, obj_s = lane_d.get("speed", "maintain"), obj_d.get("speed", "maintain")

    if obj_d.get("brake") == "strong":
        speed = "decrease"
    elif rs.get(obj_s, 0) >= rs["decrease"] or rs.get(ls, 0) >= rs["decrease"]:
        speed = "decrease"
    elif obj_s == "increase" and brake == "none" and ls != "decrease":
        speed = "increase"
    else:
        speed = "maintain"

    ol, ll = obj_d.get("lane", "keep"), lane_d.get("lane", "keep")
    lane = ol if ol != "keep" else ll
    out = {"brake": brake, "lane": lane, "speed": speed, "risk": risk}
    at = obj_d.get("alert_triggers")
    if at:
        out["alert_triggers"] = dict(at)
    return out


def _aggregate_decision_window(buf: list[dict]) -> dict:
    """Reduce flicker: over ~0.5 s of frames, take worst brake/risk, sticky lane hint."""
    if not buf:
        return {
            "brake": "none",
            "lane": "keep",
            "speed": "maintain",
            "risk": "low",
            "alert_triggers": {
                "vehicle_ahead": False,
                "stop_sign": False,
                "red_traffic_light": False,
            },
        }
    rb = {"none": 0, "light": 1, "strong": 2}
    rr = {"low": 0, "medium": 1, "high": 2}
    brake = max((d.get("brake", "none") for d in buf), key=lambda x: rb.get(x, 0))
    risk = max((d.get("risk", "low") for d in buf), key=lambda x: rr.get(x, 0))
    if any(d.get("speed") == "decrease" for d in buf):
        speed = "decrease"
    elif any(d.get("speed") == "increase" for d in buf) and brake == "none":
        speed = "increase"
    else:
        speed = "maintain"
    lane = "keep"
    for d in reversed(buf):
        if d.get("lane") not in (None, "keep"):
            lane = d["lane"]
            break
    out = {"brake": brake, "lane": lane, "speed": speed, "risk": risk}
    at = {"vehicle_ahead": False, "stop_sign": False, "red_traffic_light": False}
    for d in buf:
        t = d.get("alert_triggers") or {}
        at["vehicle_ahead"] |= bool(t.get("vehicle_ahead"))
        at["stop_sign"] |= bool(t.get("stop_sign"))
        at["red_traffic_light"] |= bool(t.get("red_traffic_light"))
    out["alert_triggers"] = at
    return out


def _rich_lane_info(lane: dict, detections: list) -> dict:
    """
    num_lanes: UFLD visible lane lines + ego width heuristic + adjacent cars.
    current_lane: which strip (1..N) contains the ego lane center from offset.
    """
    conf = float(lane.get("lane_confidence") or 0.0)
    off = float(lane.get("lane_center_offset_px") or 0.0)
    fw = max(int(lane.get("frame_width_px") or 1280), 320)
    n_track = int(lane.get("num_tracked_lanes") or 0)
    ego_w = lane.get("ego_lane_width_px")

    num_lanes = max(2, n_track) if n_track >= 2 else 2
    if ego_w is not None and float(ego_w) > 50:
        est = int(round(fw / max(float(ego_w) * 0.92, 1.0)))
        num_lanes = max(num_lanes, min(5, max(2, est)))

    has_l = any(d.get("lateral_position") == -1 for d in detections)
    has_r = any(d.get("lateral_position") == 1 for d in detections)
    if has_l and has_r:
        num_lanes = max(num_lanes, 3)
    num_lanes = int(min(5, max(2, num_lanes)))

    lane_mid_x = fw * 0.5 + off
    lane_w_px = fw / float(num_lanes)
    cur0 = int(lane_mid_x / max(lane_w_px, 1e-6))
    cur0 = max(0, min(num_lanes - 1, cur0))
    current_lane = cur0 + 1

    return {
        "num_lanes": num_lanes,
        "current_lane": current_lane,
        "is_main_road": conf >= 0.35 and num_lanes >= 3,
        "lane_center_offset_px": off,
        "lane_confidence": conf,
        "ego_lane_width_px": ego_w,
        "num_tracked_lanes": n_track,
    }


def _detections_for_payload(raw: list) -> list[dict]:
    out = []
    for d in raw:
        lat = d.get("lateral_position", 0)
        pos = "front" if lat == 0 else "left" if lat == -1 else "right"
        x1, y1, x2, y2 = d["bbox"]
        out.append(
            {
                "id": d["id"],
                "class": d["class"],
                "distance_m": d.get("estimated_distance", 0),
                "position": pos,
                "bbox": d["bbox"],
                "width": x2 - x1,
                "height": y2 - y1,
                "center": [(x1 + x2) / 2, (y1 + y2) / 2],
                "orientation": d.get("orientation", "same"),
            }
        )
    return out


def _draw_lane_overlay(frame: np.ndarray, lane: dict, decisions: dict) -> None:
    for L in lane.get("lanes") or []:
        pts = L.get("points") or []
        if len(pts) < 2:
            continue
        arr = np.array([[int(float(p[0])), int(float(p[1]))] for p in pts], dtype=np.int32)
        lid = L.get("lane_id")
        color = (0, 255, 0) if lid == "left" else (0, 165, 255)
        cv2.polylines(frame, [arr], False, color, 3, cv2.LINE_AA)

    off = float(lane.get("lane_center_offset_px") or 0.0)
    conf = float(lane.get("lane_confidence") or 0.0)
    lines = [
        f"offset {off:.1f}px  conf {conf:.2f}",
        f"brake={decisions.get('brake')}  lane={decisions.get('lane')}  "
        f"speed={decisions.get('speed')}  risk={decisions.get('risk')}",
    ]
    y = 26
    for t in lines:
        cv2.putText(
            frame,
            t,
            (10, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.6,
            (0, 255, 255),
            2,
            cv2.LINE_AA,
        )
        y += 26


def _draw_yolo_boxes(frame: np.ndarray, detections: list) -> None:
    for d in detections:
        x1, y1, x2, y2 = map(int, d["bbox"])
        cls = d.get("class", "?")
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.putText(
            frame,
            f"{cls}",
            (x1, max(0, y1 - 6)),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            (0, 255, 0),
            1,
            cv2.LINE_AA,
        )


def _payload(
    timestamp: float,
    frame_id: int,
    lane: dict,
    decisions: dict,
    detections: list,
    raw_detections: list,
) -> dict:
    lane_state = {
        "lanes": lane.get("lanes", []),
        "lane_center_offset_px": float(lane.get("lane_center_offset_px", 0.0)),
        "lane_confidence": float(lane.get("lane_confidence", 0.0)),
        "num_tracked_lanes": int(lane.get("num_tracked_lanes") or 0),
        "ego_lane_width_px": lane.get("ego_lane_width_px"),
    }
    lane_info = _rich_lane_info(lane, raw_detections)
    dec_out = {k: v for k, v in decisions.items() if k != "alert_triggers"}
    at = decisions.get("alert_triggers") or {}
    return {
        "timestamp": round(float(timestamp), 3),
        "frame": int(frame_id),
        "detections": detections,
        "lane_state": lane_state,
        "lane_info": lane_info,
        "decisions": dec_out,
        "alert_triggers": at,
    }


def main() -> None:
    start_server_background()

    video_path = _pick_video_path()
    log.info("Video file: %s", video_path)

    try:
        lane_net = UltraFastLaneDetector()
    except FileNotFoundError as e:
        raise SystemExit(str(e)) from e

    yolo = None
    try:
        from backend.detection import Detector

        yolo = Detector(video_path=None, model_path=YOLO_MODEL)
        log.info("YOLO ready (%s)", YOLO_MODEL)
    except Exception as e:
        log.warning("YOLO disabled: %s", e)

    cap = _open_capture(video_path)
    if not cap.isOpened():
        raise SystemExit(f"Cannot open video: {video_path}")

    ret, probe = cap.read()
    if ret and probe is not None and probe.size:
        mean_b = float(probe.mean())
        if mean_b < 2.0:
            log.warning(
                "First frame is nearly black (mean=%.2f). Wrong file, codec, or path — check %s",
                mean_b,
                video_path,
            )
    cap.set(cv2.CAP_PROP_POS_FRAMES, 0)

    t0 = time.perf_counter()
    last_emit = t0
    frame_id = 0
    last_lane: dict = {
        "frame": 0,
        "timestamp": 0.0,
        "lanes": [],
        "lane_center_offset_px": 0.0,
        "lane_confidence": 0.0,
    }

    if SHOW_PREVIEW:
        cv2.namedWindow(WINDOW_NAME, cv2.WINDOW_NORMAL)

    log.info("Pipeline start — emit every %.1fs", EMIT_INTERVAL_S)

    dec_hist: deque[dict] = deque(maxlen=20)

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame is None or frame.size == 0:
            continue
        frame_id += 1
        now = time.perf_counter()
        timestamp = now - t0

        try:
            last_lane = lane_net.infer_frame(frame, frame_id, timestamp)
        except Exception as e:
            log.warning("Frame %s lane error: %s", frame_id, e)
            last_lane = {
                "frame": frame_id,
                "timestamp": timestamp,
                "lanes": [],
                "lane_center_offset_px": 0.0,
                "lane_confidence": 0.0,
            }

        dets_raw: list = []
        traffic_signs: list = []
        env_cond: list = []
        if yolo is not None:
            try:
                dets_raw, traffic_signs = yolo.detect_frame(frame)
                env_cond = yolo.get_env_conditions(frame)
            except Exception as e:
                log.warning("Frame %s YOLO error: %s", frame_id, e)

        detections_api = _detections_for_payload(dets_raw)
        lane_d = lane_decision_mod.make_decision(last_lane)
        obj_d = object_decision(
            dets_raw,
            traffic_signs=traffic_signs,
            env_conditions=env_cond,
            frame_bgr=frame,
        )
        decisions_now = _merge_decisions(lane_d, obj_d)
        dec_hist.append(decisions_now)
        decisions_agg = _aggregate_decision_window(list(dec_hist))

        if SHOW_PREVIEW:
            vis = frame.copy()
            _draw_yolo_boxes(vis, dets_raw)
            _draw_lane_overlay(vis, last_lane, decisions_agg)
            cv2.imshow(WINDOW_NAME, vis)
            if (cv2.waitKey(1) & 0xFF) == ord("q"):
                log.info("Quit (q)")
                break

        if now - last_emit >= EMIT_INTERVAL_S:
            last_emit = now
            payload = _payload(
                last_lane.get("timestamp", timestamp),
                frame_id,
                last_lane,
                decisions_agg,
                detections_api,
                dets_raw,
            )
            write_snapshot(payload)
            update_state(payload)
            log.info(
                "tick f=%s dets=%s offset=%.1f -> %s",
                frame_id,
                len(detections_api),
                last_lane.get("lane_center_offset_px", 0.0),
                decisions_agg,
            )

    cap.release()
    if yolo is not None:
        yolo.release()
    if SHOW_PREVIEW:
        try:
            cv2.destroyAllWindows()
        except Exception:
            pass
    log.info("Done at frame %s", frame_id)


if __name__ == "__main__":
    main()
