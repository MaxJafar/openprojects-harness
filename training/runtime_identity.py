from __future__ import annotations

import hashlib
import importlib
import importlib.metadata
import json
import platform
import sys
import sysconfig
from pathlib import Path
from typing import Any


EXPECTED_DISTRIBUTIONS = {
    "mlx-lm": "0.31.3",
    "mlx": "0.31.2",
    "transformers": "5.12.1",
}
MODULES = ("mlx_lm", "mlx.core", "transformers")


def stable_json_bytes(value: Any, pretty: bool = False) -> bytes:
    options = {"ensure_ascii": False, "sort_keys": True, "allow_nan": False}
    text = json.dumps(value, indent=2, **options) + "\n" if pretty else json.dumps(value, separators=(",", ":"), **options)
    return text.encode("utf-8")


def collect_runtime_identity() -> dict[str, Any]:
    if not sys.flags.isolated or not sys.flags.safe_path:
        raise RuntimeError("runtime identity must be collected under Python isolated safe-path mode")
    allowed_roots = {
        Path(value).resolve()
        for key in ("purelib", "platlib")
        if (value := sysconfig.get_path(key))
    }
    distributions: list[dict[str, str]] = []
    for name, expected in EXPECTED_DISTRIBUTIONS.items():
        actual = importlib.metadata.version(name)
        if actual != expected:
            raise RuntimeError(f"{name} must be exactly {expected}; found {actual}")
        distributions.append({"name": name, "version": actual})

    modules: list[dict[str, str]] = []
    for name in MODULES:
        module = importlib.import_module(name)
        raw_origin = getattr(module, "__file__", None)
        if not isinstance(raw_origin, str):
            raise RuntimeError(f"{name} has no concrete module origin")
        origin = Path(raw_origin).resolve()
        if not origin.is_file() or origin.is_symlink():
            raise RuntimeError(f"{name} origin is not a regular installed file")
        if not any(_is_inside(root, origin) for root in allowed_roots):
            raise RuntimeError(f"{name} origin is outside this interpreter's site-packages")
        modules.append({"name": name, "origin": str(origin)})

    core: dict[str, Any] = {
        "schemaVersion": "openprojects.mlx-runtime-identity.v1",
        "pythonExecutable": str(Path(sys.executable).resolve()),
        "pythonImplementation": platform.python_implementation(),
        "pythonVersion": platform.python_version(),
        "isolatedMode": True,
        "safePathMode": True,
        "distributions": distributions,
        "modules": modules,
    }
    return {**core, "sha256": hashlib.sha256(stable_json_bytes(core)).hexdigest()}


def _is_inside(root: Path, path: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def main() -> int:
    try:
        sys.stdout.buffer.write(stable_json_bytes(collect_runtime_identity(), pretty=True))
        return 0
    except Exception as error:
        print(f"MLX runtime rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
