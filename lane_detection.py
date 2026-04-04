"""
Ultra-Fast-Lane-Detection inference wrapper for video frames.
Relies on the official repo (model + row anchors); no training required.

Expected weights: TuSimple ResNet-18 (see README trained models link).
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

import cv2
import numpy as np
import torch
import torchvision.transforms as transforms
from PIL import Image

# TuSimple inference geometry (must match pretrained model)
TUSIMPLE_IMG_W = 1280
TUSIMPLE_IMG_H = 720
CLS_NUM_PER_LANE = 56
GRIDING_NUM = 100
NUM_LANES = 4
BACKBONE = "18"


def _project_root() -> Path:
    return Path(__file__).resolve().parent


def _ufld_root() -> Path:
    env = os.environ.get("UFLD_ROOT")
    if env:
        return Path(env).resolve()
    return _project_root() / "Ultra-Fast-Lane-Detection"


def _ensure_ufld_on_path() -> Path:
    root = _ufld_root()
    if not root.is_dir():
        raise FileNotFoundError(
            f"Ultra-Fast-Lane-Detection not found at {root}. "
            "Clone the repo there or set UFLD_ROOT."
        )
    s = str(root)
    if s not in sys.path:
        sys.path.insert(0, s)
    return root


def _softmax(x: np.ndarray, axis: int = 0) -> np.ndarray:
    x = x - np.max(x, axis=axis, keepdims=True)
    e = np.exp(x)
    return e / np.sum(e, axis=axis, keepdims=True)


class UltraFastLaneDetector:
    """
    Loads TuSimple-trained parsingNet and runs per-frame inference.
    """

    def __init__(
        self,
        weights_path: str | None = None,
        device: str | torch.device | None = None,
    ) -> None:
        _ensure_ufld_on_path()
        from data.constant import tusimple_row_anchor
        from model.model import parsingNet

        self._row_anchor = tusimple_row_anchor
        self._img_w = TUSIMPLE_IMG_W
        self._img_h = TUSIMPLE_IMG_H
        self._griding_num = GRIDING_NUM
        self._cls_num_per_lane = CLS_NUM_PER_LANE

        if device is None:
            self._device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        else:
            self._device = torch.device(device)

        wpath = weights_path or os.environ.get("UFLD_WEIGHTS")
        if not wpath:
            wpath = str(_ufld_root() / "tusimple_18.pth")
        wpath = os.path.abspath(wpath)
        if not os.path.isfile(wpath):
            raise FileNotFoundError(
                f"Missing weights: {wpath}\n"
                "Download TuSimple ResNet-18 from the README (Google Drive) and save as "
                "Ultra-Fast-Lane-Detection/tusimple_18.pth or set UFLD_WEIGHTS."
            )

        self._net = parsingNet(
            pretrained=False,
            backbone=BACKBONE,
            cls_dim=(self._griding_num + 1, self._cls_num_per_lane, NUM_LANES),
            use_aux=False,
        ).to(self._device)

        try:
            state = torch.load(wpath, map_location="cpu", weights_only=False)
        except TypeError:
            state = torch.load(wpath, map_location="cpu")
        sd = state["model"] if isinstance(state, dict) and "model" in state else state
        fixed: dict[str, torch.Tensor] = {}
        for k, v in sd.items():
            nk = k[7:] if k.startswith("module.") else k
            fixed[nk] = v
        self._net.load_state_dict(fixed, strict=False)
        self._net.eval()

        self._transform = transforms.Compose(
            [
                transforms.Resize((288, 800)),
                transforms.ToTensor(),
                transforms.Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225)),
            ]
        )

        col_sample = np.linspace(0, 800 - 1, self._griding_num)
        self._col_sample_w = float(col_sample[1] - col_sample[0])

    @torch.inference_mode()
    def infer_frame(self, bgr: np.ndarray, frame_index: int, timestamp: float) -> dict[str, Any]:
        """
        bgr: OpenCV image, any size. Resized internally to TuSimple resolution for the model;
        lane points are returned in the *original* frame pixel coordinates.
        """
        if bgr is None or bgr.size == 0:
            return self._failure(frame_index, timestamp)

        orig_h, orig_w = bgr.shape[:2]
        resized = cv2.resize(bgr, (TUSIMPLE_IMG_W, TUSIMPLE_IMG_H))
        rgb = cv2.cvtColor(resized, cv2.COLOR_BGR2RGB)
        pil = Image.fromarray(rgb)
        tensor = self._transform(pil).unsqueeze(0).to(self._device)

        try:
            out = self._net(tensor)
        except Exception as e:
            logging.getLogger(__name__).warning("UFLD inference failed: %s", e)
            return self._failure(frame_index, timestamp)

        out_j = out[0].detach().float().cpu().numpy()
        out_j = out_j[:, ::-1, :]
        prob = _softmax(out_j[:-1, :, :], axis=0)
        idx = np.arange(self._griding_num, dtype=np.float32).reshape(-1, 1, 1) + 1.0
        loc = np.sum(prob * idx, axis=0)
        argmax = np.argmax(out_j, axis=0)
        loc[argmax == self._griding_num] = 0.0

        lanes_raw = self._lanes_from_loc(loc, prob, argmax)
        left_id, right_id, confidence = self._pick_ego_pair(lanes_raw, loc, prob)

        lanes_out: list[dict[str, Any]] = []
        sx = orig_w / TUSIMPLE_IMG_W
        sy = orig_h / TUSIMPLE_IMG_H

        def scale_lane(points: list[list[float]]) -> list[list[float]]:
            return [[float(x) * sx, float(y) * sy] for x, y in points]

        if left_id is not None and lanes_raw[left_id]["valid"]:
            lanes_out.append(
                {"lane_id": "left", "points": scale_lane(lanes_raw[left_id]["points"])}
            )
        if right_id is not None and lanes_raw[right_id]["valid"]:
            lanes_out.append(
                {"lane_id": "right", "points": scale_lane(lanes_raw[right_id]["points"])}
            )

        lane_center_offset_px, offset_ok = self._lane_center_offset(
            lanes_raw, left_id, right_id, orig_w, sx
        )
        if not offset_ok:
            confidence = min(confidence, 0.35)

        num_tracked = sum(1 for L in lanes_raw if L["valid"])
        ego_w_px = self._ego_lane_width_px(lanes_raw, left_id, right_id, sx)

        return {
            "frame": int(frame_index),
            "timestamp": float(timestamp),
            "lanes": lanes_out,
            "lane_center_offset_px": float(lane_center_offset_px),
            "lane_confidence": float(confidence),
            "num_tracked_lanes": int(num_tracked),
            "ego_lane_width_px": ego_w_px,
            "frame_width_px": int(orig_w),
        }

    def _failure(self, frame_index: int, timestamp: float) -> dict[str, Any]:
        return {
            "frame": int(frame_index),
            "timestamp": float(timestamp),
            "lanes": [],
            "lane_center_offset_px": 0.0,
            "lane_confidence": 0.0,
            "num_tracked_lanes": 0,
            "ego_lane_width_px": None,
            "frame_width_px": 0,
        }

    def _ego_lane_width_px(
        self,
        lanes_raw: list[dict[str, Any]],
        left_id: int | None,
        right_id: int | None,
        sx: float,
    ) -> float | None:
        if left_id is None or right_id is None:
            return None
        if not lanes_raw[left_id]["valid"] or not lanes_raw[right_id]["valid"]:
            return None

        def bottom_mean_x(lane: dict[str, Any]) -> float:
            pts = lane["points"][-8:]
            return float(np.mean([p[0] for p in pts])) if pts else 0.0

        w = abs(bottom_mean_x(lanes_raw[right_id]) - bottom_mean_x(lanes_raw[left_id])) * sx
        return float(w) if w > 5.0 else None

    def _lanes_from_loc(
        self,
        loc: np.ndarray,
        prob: np.ndarray,
        argmax: np.ndarray,
    ) -> list[dict[str, Any]]:
        """Build polylines for each of 4 TuSimple lanes in TuSimple pixel space."""
        img_w, img_h = self._img_w, self._img_h
        k_rows, k_lanes = loc.shape
        lanes = []
        for lane_i in range(k_lanes):
            pts: list[list[float]] = []
            confs: list[float] = []
            for k in range(k_rows):
                grid_idx = loc[k, lane_i]
                if grid_idx <= 0:
                    continue
                x = int(grid_idx * self._col_sample_w * img_w / 800) - 1
                y = int(img_h * (self._row_anchor[self._cls_num_per_lane - 1 - k] / 288)) - 1
                pts.append([float(x), float(y)])
                p = prob[int(argmax[k, lane_i]), k, lane_i]
                confs.append(float(p))
            valid = len(pts) > 2
            lanes.append(
                {
                    "valid": valid,
                    "points": pts,
                    "mean_conf": float(np.mean(confs)) if confs else 0.0,
                }
            )
        return lanes

    def _pick_ego_pair(
        self,
        lanes_raw: list[dict[str, Any]],
        loc: np.ndarray,
        prob: np.ndarray,
    ) -> tuple[int | None, int | None, float]:
        """Choose two ego lane boundaries: middle two lanes by bottom-row x ordering."""
        bottom_k = min(8, loc.shape[0])
        xs = []
        for i, lane in enumerate(lanes_raw):
            if not lane["valid"]:
                xs.append((float("inf"), i))
                continue
            acc_x: list[float] = []
            for k in range(bottom_k):
                if loc[k, i] > 0:
                    acc_x.append(float(loc[k, i] * self._col_sample_w * self._img_w / 800))
            xs.append((float(np.median(acc_x)) if acc_x else float("inf"), i))
        xs.sort(key=lambda t: t[0])
        finite = [t for t in xs if t[0] < float("inf")]
        if len(finite) < 2:
            return None, None, 0.2
        mid = len(finite) // 2
        if len(finite) >= 4:
            left_id = finite[1][1]
            right_id = finite[2][1]
        else:
            left_id = finite[mid - 1][1]
            right_id = finite[mid][1]
        c = (lanes_raw[left_id]["mean_conf"] + lanes_raw[right_id]["mean_conf"]) / 2.0
        return left_id, right_id, float(np.clip(c, 0.0, 1.0))

    def _lane_center_offset(
        self,
        lanes_raw: list[dict[str, Any]],
        left_id: int | None,
        right_id: int | None,
        orig_w: int,
        sx: float,
    ) -> tuple[float, bool]:
        if left_id is None or right_id is None:
            return 0.0, False
        if not lanes_raw[left_id]["valid"] or not lanes_raw[right_id]["valid"]:
            return 0.0, False

        def bottom_mean_x(lane: dict[str, Any]) -> float:
            pts = lane["points"][-8:]
            return float(np.mean([p[0] for p in pts]))

        xl = bottom_mean_x(lanes_raw[left_id]) * sx
        xr = bottom_mean_x(lanes_raw[right_id]) * sx
        lane_mid = 0.5 * (xl + xr)
        img_mid = orig_w / 2.0
        return lane_mid - img_mid, True


def detect_lanes_in_video_frame(
    detector: UltraFastLaneDetector,
    bgr: np.ndarray,
    frame_index: int,
    timestamp: float,
) -> dict[str, Any]:
    """Functional alias for tests and simple imports."""
    return detector.infer_frame(bgr, frame_index, timestamp)
