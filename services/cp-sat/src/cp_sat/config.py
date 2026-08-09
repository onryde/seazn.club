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

        # CONCURRENT SOLVES, not the RPC thread pool's size. `cp_sat.main`
        # sizes the pool at this plus `HEALTH_RESERVE_THREADS` and holds the
        # solver to this number with a semaphore, so a saturated solver still
        # has threads left to answer the liveness probe.
        max_workers = int(os.environ.get("CPSAT_MAX_WORKERS", "4"))
        # The server's own ceiling on a caller-supplied `wall_seconds`. A
        # request may ask for less; it may not ask for more.
        wall_seconds_max = float(os.environ.get("CPSAT_WALL_SECONDS_MAX", "10"))

        # --- degenerate configuration. Same zero-scalar family `schema.py`
        # --- guards on the wire, one layer further out — and worse, because a
        # --- bad request is one caller's problem while a bad env var is every
        # --- caller's problem and the service reports SERVING throughout.
        if wall_seconds_max <= 0:
            raise ValueError(
                f"CPSAT_WALL_SECONDS_MAX must be > 0, got {wall_seconds_max!r}. Every request's "
                "budget is clamped to this ceiling, so a non-positive value takes a well-formed "
                "request asking for 8.0 down to 0.0, the tier chain refuses it, and the caller is "
                "told `wall_seconds must be > 0` about a field they set correctly."
            )
        if max_workers <= 0:
            raise ValueError(
                f"CPSAT_MAX_WORKERS must be > 0, got {max_workers!r}. It caps CONCURRENT SOLVES: "
                "the servicer admits that many at once and refuses the rest with SOLVER_BUSY, and "
                "the RPC thread pool is sized this plus a fixed reserve so the health check cannot "
                "be starved by a full solver."
            )

        return cls(
            port=int(os.environ.get("CPSAT_PORT", "50051")),
            max_workers=max_workers,
            shared_secret=secret,
            wall_seconds_max=wall_seconds_max,
        )
