import re
import subprocess
import sys
from pathlib import Path

# protoc emits a flat top-level `import scheduler_pb2 as scheduler__pb2` inside
# the generated *_pb2_grpc.py. That resolves only if the generated directory is
# itself on sys.path, so `from cp_sat.generated import scheduler_pb2_grpc`
# raises ModuleNotFoundError. Rewriting it to a package-relative import is the
# standard workaround. It has to happen here, in the generation step, because
# protoc overwrites the file on every run — a hand-edit would not survive.
FLAT_IMPORT_RE = re.compile(r"^import (\w+_pb2) as (\w+)$", re.MULTILINE)


def test_proto_compiles_to_python():
    repo_root = Path(__file__).resolve().parents[3]
    proto_path = repo_root / "proto" / "scheduler.proto"
    out_dir = repo_root / "services" / "cp-sat" / "src" / "cp_sat" / "generated"
    out_dir.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            sys.executable, "-m", "grpc_tools.protoc",
            f"-I{repo_root / 'proto'}",
            f"--python_out={out_dir}",
            f"--grpc_python_out={out_dir}",
            str(proto_path),
        ],
        capture_output=True, text=True,
    )

    grpc_stub = out_dir / "scheduler_pb2_grpc.py"
    if grpc_stub.exists():
        grpc_stub.write_text(
            FLAT_IMPORT_RE.sub(r"from . import \1 as \2", grpc_stub.read_text())
        )

    assert result.returncode == 0, result.stderr
    assert (out_dir / "scheduler_pb2.py").exists()
    assert grpc_stub.exists()

    # Guard the rewrite: a naive regeneration that skips it must fail here
    # rather than surfacing later as a collection-time ModuleNotFoundError.
    stub_src = grpc_stub.read_text()
    assert "from . import scheduler_pb2 as scheduler__pb2" in stub_src
    assert not FLAT_IMPORT_RE.search(stub_src), (
        "generated grpc stub still contains a flat cross-module import"
    )
