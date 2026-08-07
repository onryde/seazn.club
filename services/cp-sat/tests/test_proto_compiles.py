import importlib
import re
import subprocess
import sys
from pathlib import Path

from google.protobuf.descriptor import FieldDescriptor

REPO_ROOT = Path(__file__).resolve().parents[3]
PROTO_DIR = REPO_ROOT / "proto"
PROTO_PATH = PROTO_DIR / "scheduler.proto"
TRACKED_DIR = REPO_ROOT / "services" / "cp-sat" / "src" / "cp_sat" / "generated"
STUB_NAMES = ("scheduler_pb2.py", "scheduler_pb2_grpc.py")

# protoc emits a flat top-level `import scheduler_pb2 as scheduler__pb2` into
# the generated *_pb2_grpc.py. That resolves only if the generated directory is
# itself on sys.path, so `from cp_sat.generated import scheduler_pb2_grpc`
# raises ModuleNotFoundError. Rewriting it to a package-relative import is the
# standard workaround, and it has to happen as part of generation because
# protoc overwrites the file on every run.
FLAT_IMPORT_RE = re.compile(r"^import (\w+_pb2) as (\w+)$", re.MULTILINE)

REGEN_HINT = (
    "Generated stubs are out of date with proto/scheduler.proto. "
    "Regenerate with: venv/bin/python3 tests/test_proto_compiles.py"
)


def _generate(out_dir):
    """Compile the proto into out_dir and apply the import rewrite."""
    out_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            sys.executable, "-m", "grpc_tools.protoc",
            f"-I{PROTO_DIR}",
            f"--python_out={out_dir}",
            f"--grpc_python_out={out_dir}",
            str(PROTO_PATH),
        ],
        capture_output=True, text=True,
    )
    grpc_stub = out_dir / "scheduler_pb2_grpc.py"
    if grpc_stub.exists():
        grpc_stub.write_text(
            FLAT_IMPORT_RE.sub(r"from . import \1 as \2", grpc_stub.read_text())
        )
    return result


def test_generated_stubs_match_proto(tmp_path):
    """Drift gate: the tracked stubs must equal a fresh compile of the proto.

    Generation happens in tmp_path, never in the source tree, so a stale
    checked-in stub fails loudly instead of being silently healed.
    """
    result = _generate(tmp_path)
    assert result.returncode == 0, result.stderr

    for name in STUB_NAMES:
        fresh = tmp_path / name
        tracked = TRACKED_DIR / name
        assert fresh.exists(), f"protoc did not emit {name}"
        assert tracked.exists(), f"{name} is not committed. {REGEN_HINT}"
        assert tracked.read_bytes() == fresh.read_bytes(), f"{name} is stale. {REGEN_HINT}"


def test_grpc_stub_imports_as_a_package_module():
    """The rewrite exists so this import works — assert the behavior, not a string."""
    module = importlib.import_module("cp_sat.generated.scheduler_pb2_grpc")
    assert module.SchedulerServiceStub is not None
    assert module.SchedulerServiceServicer is not None

    # Cheap diagnostic kept alongside the real check: if the import above ever
    # fails, this pinpoints the flat-import regression as the cause.
    stub_src = (TRACKED_DIR / "scheduler_pb2_grpc.py").read_text()
    assert "from . import scheduler_pb2 as scheduler__pb2" in stub_src
    assert not FLAT_IMPORT_RE.search(stub_src), (
        "generated grpc stub still contains a flat cross-module import"
    )


# Field-by-field contract. A rename, a renumber, a type change or a
# repeated/singular flip in proto/scheduler.proto breaks these — this task owns
# catching that, because a mismatch here becomes a bug in every downstream task.
# Tuples are (field number, wire type, is_repeated).
EXPECTED_REQUEST_FIELDS = {
    "request_id":   (1, FieldDescriptor.TYPE_STRING,  False),
    "courts":       (2, FieldDescriptor.TYPE_STRING,  True),
    "grid":         (3, FieldDescriptor.TYPE_MESSAGE, False),
    "fixtures":     (4, FieldDescriptor.TYPE_MESSAGE, True),
    "existing":     (5, FieldDescriptor.TYPE_MESSAGE, True),
    "dependencies": (6, FieldDescriptor.TYPE_MESSAGE, True),
    "constraints":  (7, FieldDescriptor.TYPE_MESSAGE, False),
    "wall_seconds": (8, FieldDescriptor.TYPE_DOUBLE,  False),
}

EXPECTED_RESPONSE_FIELDS = {
    "assignments":      (1, FieldDescriptor.TYPE_MESSAGE, True),
    "status":           (2, FieldDescriptor.TYPE_ENUM,    False),
    "tiers_completed":  (3, FieldDescriptor.TYPE_INT32,   False),
    "objective_values": (4, FieldDescriptor.TYPE_MESSAGE, True),
    "elapsed_ms":       (5, FieldDescriptor.TYPE_INT64,   False),
    "wall_exhausted":   (6, FieldDescriptor.TYPE_BOOL,    False),
    "error":            (7, FieldDescriptor.TYPE_MESSAGE, False),
}

EXPECTED_SOLVE_STATUS = {
    "SOLVE_STATUS_UNSPECIFIED": 0,
    "SOLVE_STATUS_OPTIMAL": 1,
    "SOLVE_STATUS_FEASIBLE": 2,
    "SOLVE_STATUS_INFEASIBLE": 3,
    "SOLVE_STATUS_UNKNOWN": 4,
    "SOLVE_STATUS_ERROR": 5,
}


def _assert_fields(descriptor, expected):
    actual = descriptor.fields_by_name
    assert set(actual) == set(expected), (
        f"{descriptor.full_name} field set changed: "
        f"unexpected={sorted(set(actual) - set(expected))}, "
        f"missing={sorted(set(expected) - set(actual))}"
    )
    for name, (number, type_, repeated) in expected.items():
        field = actual[name]
        assert (field.number, field.type, field.is_repeated) == (number, type_, repeated), (
            f"{descriptor.full_name}.{name} changed: "
            f"got (number={field.number}, type={field.type}, repeated={field.is_repeated}), "
            f"expected (number={number}, type={type_}, repeated={repeated})"
        )


def test_solve_build_request_contract():
    pb2 = importlib.import_module("cp_sat.generated.scheduler_pb2")
    _assert_fields(pb2.SolveBuildRequest.DESCRIPTOR, EXPECTED_REQUEST_FIELDS)


def test_solve_build_response_contract():
    pb2 = importlib.import_module("cp_sat.generated.scheduler_pb2")
    _assert_fields(pb2.SolveBuildResponse.DESCRIPTOR, EXPECTED_RESPONSE_FIELDS)


def test_solve_status_enum_contract():
    pb2 = importlib.import_module("cp_sat.generated.scheduler_pb2")
    enum = pb2.SolveStatus.DESCRIPTOR
    actual = {value.name: value.number for value in enum.values}
    assert actual == EXPECTED_SOLVE_STATUS


if __name__ == "__main__":
    # Regeneration entry point, referenced by REGEN_HINT. This is the only
    # path that writes into the source tree; the tests never do.
    outcome = _generate(TRACKED_DIR)
    if outcome.returncode != 0:
        sys.exit(outcome.stderr)
    print(f"regenerated {', '.join(STUB_NAMES)} in {TRACKED_DIR}")
