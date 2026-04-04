"""
server.py — Drive-Assist WebSocket Server
Broadcasts the latest JSON state to all connected clients every 0.5s.
Person A writes to shared_state.py → this server reads and broadcasts.
Fallback: also writes to output.json for Three.js polling.
"""

import asyncio
import json
import logging
import os
import time
try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    print("[server] websockets not installed — running in file-only fallback mode")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [server] %(message)s")
log = logging.getLogger(__name__)

BROADCAST_INTERVAL = 0.5  # seconds
PORT = 8765

# ─── Shared state (Person A writes here via update_state()) ───────────────────

_current_state: dict = {
    "timestamp": 0.0,
    "frame": 0,
    "detections": [],
    "lane_state": {
        "lanes": [],
        "lane_center_offset_px": 0.0,
        "lane_confidence": 0.0,
    },
    "decisions": {
        "brake": "none",
        "lane": "keep",
        "speed": "maintain",
        "risk": "low",
    },
    "alert_triggers": {
        "vehicle_ahead": False,
        "stop_sign": False,
        "red_traffic_light": False,
    },
}

def update_state(new_state: dict) -> None:
    """Called by main.py to push new detection/decision data (WebSocket only)."""
    global _current_state
    _current_state = new_state


def get_state() -> dict:
    return _current_state


# ─── WebSocket broadcast ──────────────────────────────────────────────────────

_connected_clients: set = set()


async def _register(ws) -> None:
    global _connected_clients
    _connected_clients.add(ws)
    log.info(f"Client connected ({len(_connected_clients)} total): {ws.remote_address}")
    try:
        await ws.wait_closed()
    finally:
        _connected_clients.discard(ws)
        log.info(f"Client disconnected ({len(_connected_clients)} remaining)")


async def _broadcast_loop() -> None:
    """Sends current state to all clients every 0.5 s."""
    global _connected_clients
    while True:
        await asyncio.sleep(BROADCAST_INTERVAL)
        if not _connected_clients:
            continue
        payload = json.dumps(_current_state)
        dead = set()
        for ws in list(_connected_clients):
            try:
                await ws.send(payload)
            except Exception:
                dead.add(ws)
        _connected_clients -= dead


async def _run_server() -> None:
    # 0.0.0.0: reachable as 127.0.0.1 from browser and from Vite's Node proxy.
    # compression=None: avoids rare permessage-deflate issues with some clients.
    host = os.environ.get("WS_HOST", "0.0.0.0")
    log.info(f"WebSocket server listening on ws://127.0.0.1:{PORT} (bind {host})")
    async with websockets.serve(
        _register,
        host,
        PORT,
        compression=None,
        ping_interval=20,
        ping_timeout=60,
    ):
        await _broadcast_loop()


# ─── Public entry point ───────────────────────────────────────────────────────

def start_server_background() -> None:
    """
    Call this from main.py to launch the WebSocket server in a background thread.

    Usage in main.py:
        from server import start_server_background, update_state
        start_server_background()
        # ... in your loop:
        update_state(new_state_dict)
    """
    import threading

    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        if WEBSOCKETS_AVAILABLE:
            loop.run_until_complete(_run_server())
        else:
            log.warning("WebSocket unavailable — only writing output.json")
            while True:
                time.sleep(BROADCAST_INTERVAL)

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    log.info("Server thread started")


# ─── Standalone mode (python server.py) ──────────────────────────────────────

if __name__ == "__main__":
    log.info("Running in standalone demo mode — sending dummy state every 0.5s")

    import random, math

    from output import write_snapshot

    async def _demo():
        frame = 0
        classes = ["car", "truck", "person", "stop_sign", "traffic_light"]
        positions = ["front", "front_left", "front_right", "left", "right"]
        brakes = ["none", "light", "strong"]
        speeds = ["increase", "maintain", "decrease"]
        lanes = ["keep", "change_left", "change_right"]
        risks = ["low", "medium", "high"]

        while True:
            frame += 1
            state = {
                "timestamp": round(frame * 0.5, 1),
                "frame": frame,
                "detections": [
                    {
                        "id": i + 1,
                        "class": random.choice(classes),
                        "distance_m": round(random.uniform(4, 40), 1),
                        "position": random.choice(positions),
                    }
                    for i in range(random.randint(0, 3))
                ],
                "lane_state": {
                    "lanes": [],
                    "lane_center_offset_px": 0.0,
                    "lane_confidence": 0.0,
                },
                "decisions": {
                    "brake": random.choice(brakes),
                    "lane": random.choice(lanes),
                    "speed": random.choice(speeds),
                    "risk": random.choice(risks),
                },
                "alert_triggers": {
                    "vehicle_ahead": False,
                    "stop_sign": False,
                    "red_traffic_light": False,
                },
            }
            write_snapshot(state)
            update_state(state)
            await asyncio.sleep(BROADCAST_INTERVAL)

    async def _main():
        await asyncio.gather(_run_server(), _demo())

    if WEBSOCKETS_AVAILABLE:
        asyncio.run(_main())
    else:
        print("Install websockets: pip install websockets")
        print("Writing demo output.json only...")
        import random
        frame = 0
        from output import write_snapshot

        while True:
            frame += 1
            st = {
                "timestamp": frame * 0.5,
                "frame": frame,
                "detections": [],
                "lane_state": {
                    "lanes": [],
                    "lane_center_offset_px": 0.0,
                    "lane_confidence": 0.0,
                },
                "decisions": {
                    "brake": "none",
                    "lane": "keep",
                    "speed": "maintain",
                    "risk": "low",
                },
                "alert_triggers": {
                    "vehicle_ahead": False,
                    "stop_sign": False,
                    "red_traffic_light": False,
                },
            }
            write_snapshot(st)
            update_state(st)
            time.sleep(BROADCAST_INTERVAL)