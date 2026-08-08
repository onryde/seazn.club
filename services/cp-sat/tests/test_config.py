"""Settings load from the environment, and refuse to come up without a secret.

`Settings.from_env()` is the only place the process reads its environment, so
every default that matters to a deploy is stated once, here, and is testable
without standing a server up.
"""

import pytest

from cp_sat.config import Settings


def test_settings_load_from_env(monkeypatch):
    monkeypatch.setenv("CPSAT_PORT", "50051")
    monkeypatch.setenv("CPSAT_MAX_WORKERS", "4")
    monkeypatch.setenv("CPSAT_SERVICE_SECRET", "test-secret")
    monkeypatch.setenv("CPSAT_WALL_SECONDS_MAX", "10")
    s = Settings.from_env()
    assert s.port == 50051
    assert s.max_workers == 4
    assert s.shared_secret == "test-secret"
    assert s.wall_seconds_max == 10.0


def test_settings_requires_secret(monkeypatch):
    monkeypatch.delenv("CPSAT_SERVICE_SECRET", raising=False)
    with pytest.raises(ValueError, match="CPSAT_SERVICE_SECRET"):
        Settings.from_env()
