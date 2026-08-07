import subprocess
import sys
from pathlib import Path


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
    assert result.returncode == 0, result.stderr
    assert (out_dir / "scheduler_pb2.py").exists()
    assert (out_dir / "scheduler_pb2_grpc.py").exists()
