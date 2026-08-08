"""The gRPC server: bootstrap, auth, health, and the SolveBuild handler.

Application/infrastructure layer. It orchestrates and nothing else: it
authenticates, asks `cp_sat.schema` to translate the request into domain types,
asks the domain (`build_model` / `solve`) to compute, and asks `cp_sat.schema`
to translate the plain-Python outcome back onto the wire. It decides nothing
about scheduling and — deliberately — constructs no proto message itself. Both
directions of the translation live in the one anti-corruption layer, which is
why this module imports `scheduler_pb2_grpc` (the generated servicer base and
its registration helper) but never `scheduler_pb2`.

Sync `grpcio` with a `ThreadPoolExecutor`, not `grpc.aio`: a solve is a
CPU-bound OR-Tools call that never yields, so an event loop buys nothing and
would starve the health check. Auth is a shared secret on request metadata,
not mTLS — 6PN is already WireGuard-encrypted, and cert rotation would be cost
against a threat model nothing else in this repo defends against.
"""

from __future__ import annotations

import hmac
import logging
from concurrent import futures

import grpc
from grpc_health.v1 import health, health_pb2, health_pb2_grpc

from cp_sat.config import Settings
from cp_sat.generated import scheduler_pb2_grpc
from cp_sat.model import build_model, solve
from cp_sat.schema import (
    InvalidRequestError,
    error_response,
    outcome_to_response,
    request_to_model_input,
)

AUTH_METADATA_KEY = "x-internal-secret"


class SchedulerServicer(scheduler_pb2_grpc.SchedulerServiceServicer):
    def __init__(self, settings: Settings):
        self._settings = settings

    def _authenticated(self, context) -> bool:
        # Header names are case-insensitive on the wire and a real transport
        # lower-cases them before the servicer sees them; normalising here
        # means the in-process test harness and a live server agree.
        metadata = {key.lower(): value for key, value in (context.invocation_metadata() or ())}
        secret = metadata.get(AUTH_METADATA_KEY)
        if not isinstance(secret, str):
            return False
        # Constant-time. The comparison is cheap either way, and a shared
        # secret compared with `==` leaks its prefix through timing.
        return hmac.compare_digest(secret, self._settings.shared_secret)

    def SolveBuild(self, request, context):
        if not self._authenticated(context):
            # Before ANY work: an unauthenticated caller must not be able to
            # spend a worker thread, let alone a whole wall budget, on a solve.
            # `abort` raises, so nothing below runs.
            context.abort(grpc.StatusCode.UNAUTHENTICATED, "missing or invalid secret")

        try:
            parsed = request_to_model_input(request)
        except InvalidRequestError as exc:
            return error_response("INVALID_REQUEST", str(exc))

        wall = min(parsed.wall_seconds, self._settings.wall_seconds_max)

        # Defence in depth, NOT dead code. `request_to_model_input` already
        # rejects every degenerate scalar `build_model` and `run_tier_chain`
        # guard against, so in principle nothing here can raise. But the two
        # layers are independent by design — the domain guards protect the
        # bench and any future caller, and the wire guard protects the RPC —
        # and "in principle nothing raises" is exactly the assumption that ends
        # with a raw traceback going back to a caller as an opaque UNKNOWN.
        # Same response shape as the branch above: whichever layer noticed, the
        # caller sees one thing.
        try:
            model = build_model(
                parsed.fixtures,
                parsed.courts,
                parsed.grid_slots,
                parsed.step_minutes,
                parsed.constraints,
                parsed.existing,
                parsed.dependencies,
            )
            outcome = solve(model, wall_seconds=wall)
        except ValueError as exc:
            logging.warning("solve rejected request %s: %s", request.request_id, exc)
            return error_response("INVALID_REQUEST", str(exc))

        # `wall`, not `parsed.wall_seconds`: the budget the solve was actually
        # given is the one `wall_exhausted` has to be measured against.
        return outcome_to_response(outcome, wall_seconds=wall)


def build_health_servicer() -> health.HealthServicer:
    """The readiness probe's servicer, marked SERVING for the empty (whole
    server) service name. A function rather than four lines inside `serve()` so
    the wiring is testable without binding a port."""
    health_servicer = health.HealthServicer()
    health_servicer.set("", health_pb2.HealthCheckResponse.SERVING)
    return health_servicer


def serve() -> None:
    logging.basicConfig(level=logging.INFO)
    settings = Settings.from_env()
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=settings.max_workers))
    scheduler_pb2_grpc.add_SchedulerServiceServicer_to_server(SchedulerServicer(settings), server)
    health_pb2_grpc.add_HealthServicer_to_server(build_health_servicer(), server)

    server.add_insecure_port(f"[::]:{settings.port}")
    server.start()
    logging.info("cp-sat service listening on :%d (max_workers=%d)", settings.port, settings.max_workers)
    server.wait_for_termination()


if __name__ == "__main__":
    serve()
