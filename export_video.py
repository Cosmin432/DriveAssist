"""
export_video.py — Drive-Assist Overlay Video Exporter
Reads video.mp4 + output.json log, renders overlay on every frame, saves output_overlay.mp4.
"""

import cv2
import json
import sys
from pathlib import Path
from overlay_2d import render_frame

INPUT_VIDEO   = Path("video.mp4")
OUTPUT_VIDEO  = Path("output/output_overlay.mp4")
JSON_LOG      = Path("output.json")   # can also accept a list log — see below


def load_json_states(json_path: Path) -> list[dict]:
    """
    Accepts two formats:
    1. Single dict  → wraps in list (live output.json format)
    2. List of dicts → used as-is (full session log)
    """
    raw = json.loads(json_path.read_text())
    if isinstance(raw, list):
        return sorted(raw, key=lambda s: s.get("timestamp", 0))
    return [raw]


def find_state_for_timestamp(states: list[dict], t: float) -> dict:
    """Return the state whose timestamp is closest to t (floor match)."""
    best = states[0]
    for s in states:
        if s.get("timestamp", 0) <= t:
            best = s
        else:
            break
    return best


def export(
    input_path: Path = INPUT_VIDEO,
    output_path: Path = OUTPUT_VIDEO,
    json_path: Path = JSON_LOG,
    show_preview: bool = False,
) -> None:
    if not input_path.exists():
        print(f"[export] ERROR: {input_path} not found")
        sys.exit(1)

    states = []
    if json_path.exists():
        states = load_json_states(json_path)
        print(f"[export] Loaded {len(states)} JSON state(s) from {json_path}")
    else:
        print(f"[export] WARNING: {json_path} not found — exporting with empty decisions")
        states = [{"timestamp": 0, "frame": 0, "detections": [], "decisions": {}}]

    cap = cv2.VideoCapture(str(input_path))
    if not cap.isOpened():
        print(f"[export] ERROR: Cannot open {input_path}")
        sys.exit(1)

    fps    = cap.get(cv2.CAP_PROP_FPS) or 30.0
    width  = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total  = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(output_path), fourcc, fps, (width, height))

    print(f"[export] {width}x{height} @ {fps:.1f}fps  →  {output_path}")
    print(f"[export] Processing {total} frames...")

    frame_idx = 0
    while True:
        ret, frame = cap.read()
        if not ret:
            break

        timestamp = frame_idx / fps
        state = find_state_for_timestamp(states, timestamp)
        annotated = render_frame(frame.copy(), state)
        writer.write(annotated)

        if show_preview:
            cv2.imshow("export preview", annotated)
            if cv2.waitKey(1) & 0xFF == ord("q"):
                break

        if frame_idx % 100 == 0:
            pct = frame_idx / max(total, 1) * 100
            print(f"  {frame_idx}/{total} ({pct:.0f}%)")

        frame_idx += 1

    cap.release()
    writer.release()
    if show_preview:
        cv2.destroyAllWindows()

    print(f"[export] Done → {output_path}")


if __name__ == "__main__":
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--input",   default=str(INPUT_VIDEO))
    p.add_argument("--output",  default=str(OUTPUT_VIDEO))
    p.add_argument("--json",    default=str(JSON_LOG))
    p.add_argument("--preview", action="store_true")
    args = p.parse_args()

    export(Path(args.input), Path(args.output), Path(args.json), args.preview)