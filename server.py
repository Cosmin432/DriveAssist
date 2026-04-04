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
from pathlib import Path

try:
    import websockets
    WEBSOCKETS_AVAILABLE = True
except ImportError:
    WEBSOCKETS_AVAILABLE = False
    print("[server] websockets not installed — running in file-only fallback mode")

logging.basicConfig(level=logging.INFO, format="%(asctime)s [server] %(message)s")
log = logging.getLogger(__name__)

OUTPUT_JSON = Path("output.json")
BROADCAST_INTERVAL = 0.5  # seconds
PORT = 8765

# ─── Shared state (Person A writes here via update_state()) ───────────────────

_current_state: dict = {
    "timestamp": 0.0,
    "frame": 0,
    "detections": [],
    "decisions": {
        "brake": "none",
        "lane": "keep",
        "speed": "maintain",
        "risk": "low",
    },
}

def update_state(new_state: dict) -> None:
    """Called by main.py (Person A) to push new detection/decision data."""
    global _current_state
    _current_state = new_state
    _write_json_fallback(new_state)


def get_state() -> dict:
    return _current_state


# ─── JSON fallback (always write, even when WebSocket works) ──────────────────

def _write_json_fallback(state: dict) -> None:
    try:
        tmp = OUTPUT_JSON.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=2))
        tmp.replace(OUTPUT_JSON)          # atomic replace — no partial reads
    except Exception as e:
        log.warning(f"Could not write output.json: {e}")


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
    log.info(f"WebSocket server listening on ws://localhost:{PORT}")
    async with websockets.serve(_register, "0.0.0.0", PORT):
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
                "decisions": {
                    "brake": random.choice(brakes),
                    "lane": random.choice(lanes),
                    "speed": random.choice(speeds),
                    "risk": random.choice(risks),
                },
            }
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
        while True:
            frame += 1
            update_state({"timestamp": frame * 0.5, "frame": frame, "detections": [], "decisions": {"brake": "none", "lane": "keep", "speed": "maintain", "risk": "low"}})
            time.sleep(BROADCAST_INTERVAL)