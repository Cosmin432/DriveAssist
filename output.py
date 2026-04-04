"""
Atomic JSON snapshot + append-only log for Drive-Assist.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

OUTPUT_JSON = Path("output.json")
LOG_TXT = Path("log.txt")


def write_snapshot(payload: dict[str, Any]) -> None:
    """Write output.json atomically; append one line to log.txt."""
    try:
        tmp = OUTPUT_JSON.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        tmp.replace(OUTPUT_JSON)
    except OSError as e:
        log.warning("write_snapshot: could not write %s: %s", OUTPUT_JSON, e)

    line = json.dumps(payload, separators=(",", ":"))
    ts = datetime.now(timezone.utc).isoformat()
    try:
        with LOG_TXT.open("a", encoding="utf-8") as f:
            f.write(f"{ts}\t{line}\n")
    except OSError as e:
        log.warning("write_snapshot: could not append %s: %s", LOG_TXT, e)
