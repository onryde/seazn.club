"""Process configuration, read once from the environment.

Deliberately a frozen dataclass built by an explicit `from_env()` rather than
module-level `os.environ` reads: the servicer takes its `Settings` as a
constructor argument, so a test can build one directly and never has to reason
about import-time side effects.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    port: int
    max_workers: int
    shared_secret: str
    wall_seconds_max: float

    @classmethod
    def from_env(cls) -> "Settings":
        # No default, and the process refuses to start without it. An empty or
        # missing secret would otherwise make `secret != shared_secret` compare
        # two empty strings and authenticate every unauthenticated caller —
        # failing OPEN, which is the one failure mode auth may not have.
        secret = os.environ.get("CPSAT_SERVICE_SECRET")
        if not secret:
            raise ValueError("CPSAT_SERVICE_SECRET is required")
        return cls(
            port=int(os.environ.get("CPSAT_PORT", "50051")),
            max_workers=int(os.environ.get("CPSAT_MAX_WORKERS", "4")),
            shared_secret=secret,
            # The server's own ceiling on a caller-supplied `wall_seconds`. A
            # request may ask for less; it may not ask for more.
            wall_seconds_max=float(os.environ.get("CPSAT_WALL_SECONDS_MAX", "10")),
        )
