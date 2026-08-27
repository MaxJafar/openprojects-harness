from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import stat
import struct
import sys
from pathlib import Path
from typing import Any, BinaryIO, Iterable


SCHEMA_VERSION = "openprojects.adapter-artifact-postflight.v1"
MAX_SAFETENSORS_BYTES = 512 * 1024 * 1024
MAX_HEADER_BYTES = 8 * 1024 * 1024
MAX_CONFIG_BYTES = 1024 * 1024
MAX_TENSORS = 100_000
MAX_TENSOR_RANK = 32
MAX_TENSOR_DIMENSION = (1 << 63) - 1
READ_CHUNK_BYTES = 1024 * 1024

DTYPE_BYTES = {
    "BOOL": 1,
    "U8": 1,
    "I8": 1,
    "U16": 2,
    "I16": 2,
    "U32": 4,
    "I32": 4,
    "U64": 8,
    "I64": 8,
    "F16": 2,
    "BF16": 2,
    "F32": 4,
    "F64": 8,
}
FLOAT_DTYPES = frozenset({"F16", "BF16", "F32", "F64"})

# These are the adapter-loading and prompt-masking fields that the postflight
# binds to the reviewed MLX run configuration. Other training telemetry and
# path fields are deliberately not interpreted here.
MATCHED_CONFIG_PATHS = (
    ("model",),
    ("fine_tune_type",),
    ("num_layers",),
    ("max_seq_length",),
    ("mask_prompt",),
    ("lora_parameters",),
)


class ArtifactPostflightError(ValueError):
    """A bounded, operator-safe artifact validation failure."""


class _ArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise ArtifactPostflightError(f"invalid arguments: {message}")


def _canonical_json_bytes(value: Any) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            sort_keys=True,
            separators=(",", ":"),
        )
    except (TypeError, ValueError) as error:
        raise ArtifactPostflightError("result could not be represented as strict JSON") from error
    return encoded.encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _with_result_digest(core: dict[str, Any]) -> dict[str, Any]:
    return {**core, "sha256": _sha256_bytes(_canonical_json_bytes(core))}


def _reject_json_constant(value: str) -> None:
    raise ArtifactPostflightError(f"non-finite JSON number {value!r} is not allowed")


def _strict_json_float(value: str) -> float:
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ArtifactPostflightError("overflowing or non-finite JSON numbers are not allowed")
    return parsed


def _strict_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ArtifactPostflightError(f"duplicate JSON object key {key!r}")
        result[key] = value
    return result


def _load_strict_json(data: bytes, label: str) -> Any:
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ArtifactPostflightError(f"{label} is not valid UTF-8") from error
    try:
        return json.loads(
            text,
            object_pairs_hook=_strict_object,
            parse_constant=_reject_json_constant,
            parse_float=_strict_json_float,
        )
    except ArtifactPostflightError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ArtifactPostflightError(f"{label} is not strict JSON") from error


def _load_safetensors_header(data: bytes) -> dict[str, Any]:
    try:
        text = data.decode("utf-8", errors="strict")
    except UnicodeDecodeError as error:
        raise ArtifactPostflightError("safetensors header is not valid UTF-8") from error
    if not text.startswith("{"):
        raise ArtifactPostflightError("safetensors header must begin with a JSON object")
    decoder = json.JSONDecoder(
        object_pairs_hook=_strict_object,
        parse_constant=_reject_json_constant,
        parse_float=_strict_json_float,
    )
    try:
        value, end = decoder.raw_decode(text)
    except ArtifactPostflightError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError) as error:
        raise ArtifactPostflightError("safetensors header is not strict JSON") from error
    if any(character != " " for character in text[end:]):
        raise ArtifactPostflightError("safetensors header has non-space bytes after its JSON object")
    if not isinstance(value, dict):
        raise ArtifactPostflightError("safetensors header must be a JSON object")
    return value


def _absolute_lexical(path: str | Path, label: str) -> Path:
    try:
        expanded = Path(path).expanduser()
    except (TypeError, ValueError, OSError) as error:
        raise ArtifactPostflightError(f"{label} is not a valid filesystem path") from error
    if ".." in expanded.parts:
        raise ArtifactPostflightError(f"{label} must not contain '..' path components")
    try:
        return Path(os.path.abspath(os.fspath(expanded)))
    except (TypeError, ValueError, OSError) as error:
        raise ArtifactPostflightError(f"{label} is not a valid filesystem path") from error


def _reject_symlink_components(path: Path, label: str) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = os.lstat(current)
        except (OSError, ValueError) as error:
            raise ArtifactPostflightError(f"{label} does not exist or cannot be inspected") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise ArtifactPostflightError(f"{label} must not contain symlink path components")


def _open_directory(path: Path, label: str) -> int:
    _reject_symlink_components(path, label)
    flags = os.O_RDONLY
    flags |= getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_DIRECTORY", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except (OSError, ValueError) as error:
        raise ArtifactPostflightError(f"{label} must be a readable non-symlink directory") from error
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise ArtifactPostflightError(f"{label} must be a directory")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _open_regular_at(directory_descriptor: int, name: str, label: str) -> tuple[int, os.stat_result]:
    if not name or name in {".", ".."} or "/" in name or (os.altsep and os.altsep in name):
        raise ArtifactPostflightError(f"unsafe fixed artifact name for {label}")
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=directory_descriptor)
    except (OSError, ValueError) as error:
        raise ArtifactPostflightError(f"{label} must be a readable non-symlink regular file") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ArtifactPostflightError(f"{label} must be a regular file")
        return descriptor, metadata
    except BaseException:
        os.close(descriptor)
        raise


def _open_regular_path(path: Path, label: str) -> tuple[int, os.stat_result]:
    _reject_symlink_components(path, label)
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except (OSError, ValueError) as error:
        raise ArtifactPostflightError(f"{label} must be a readable non-symlink regular file") from error
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise ArtifactPostflightError(f"{label} must be a regular file")
        return descriptor, metadata
    except BaseException:
        os.close(descriptor)
        raise


def _read_exact(handle: BinaryIO, length: int, label: str) -> bytes:
    chunks: list[bytes] = []
    remaining = length
    while remaining:
        chunk = handle.read(remaining)
        if not chunk:
            raise ArtifactPostflightError(f"{label} ended before its declared length")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _read_bounded_json_descriptor(
    descriptor: int,
    size: int,
    label: str,
) -> tuple[dict[str, Any], bytes]:
    if size <= 0 or size > MAX_CONFIG_BYTES:
        raise ArtifactPostflightError(f"{label} size must be between 1 and {MAX_CONFIG_BYTES} bytes")
    with os.fdopen(descriptor, "rb", closefd=True) as handle:
        data = _read_exact(handle, size, label)
        if handle.read(1):
            raise ArtifactPostflightError(f"{label} changed while it was being read")
    value = _load_strict_json(data, label)
    if not isinstance(value, dict):
        raise ArtifactPostflightError(f"{label} must contain a JSON object")
    return value, data


def _require_int(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise ArtifactPostflightError(f"{label} must be an integer in [{minimum}, {maximum}]")
    return value


def _require_finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ArtifactPostflightError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise ArtifactPostflightError(f"{label} must be a finite number")
    return result


def _validate_expected_config(config: dict[str, Any]) -> None:
    model = config.get("model")
    if not isinstance(model, str) or not model or len(model) > 4096:
        raise ArtifactPostflightError("expected config model must be a non-empty bounded string")
    if config.get("fine_tune_type") != "lora":
        raise ArtifactPostflightError("expected config fine_tune_type must be 'lora'")
    _require_int(config.get("num_layers"), "expected config num_layers", 1, 1024)
    _require_int(config.get("max_seq_length"), "expected config max_seq_length", 1, 1_000_000)
    if config.get("mask_prompt") is not True:
        raise ArtifactPostflightError("expected config mask_prompt must be true")

    parameters = config.get("lora_parameters")
    if not isinstance(parameters, dict):
        raise ArtifactPostflightError("expected config lora_parameters must be an object")
    if set(parameters) != {"keys", "rank", "scale", "dropout"}:
        raise ArtifactPostflightError(
            "expected config lora_parameters must contain exactly keys, rank, scale, and dropout"
        )
    keys = parameters["keys"]
    if (
        not isinstance(keys, list)
        or not keys
        or len(keys) > 1024
        or any(not isinstance(key, str) or not key or len(key) > 1024 for key in keys)
        or len(set(keys)) != len(keys)
    ):
        raise ArtifactPostflightError("expected config lora_parameters.keys must be unique bounded strings")
    _require_int(parameters["rank"], "expected config lora_parameters.rank", 1, 1_000_000)
    scale = _require_finite_number(parameters["scale"], "expected config lora_parameters.scale")
    dropout = _require_finite_number(parameters["dropout"], "expected config lora_parameters.dropout")
    if scale <= 0:
        raise ArtifactPostflightError("expected config lora_parameters.scale must be positive")
    if not 0 <= dropout < 1:
        raise ArtifactPostflightError("expected config lora_parameters.dropout must be in [0, 1)")


def _get_config_path(config: dict[str, Any], path: tuple[str, ...], label: str) -> Any:
    value: Any = config
    for component in path:
        if not isinstance(value, dict) or component not in value:
            raise ArtifactPostflightError(f"{label} is missing required field {'.'.join(path)}")
        value = value[component]
    return value


def _same_json_value(left: Any, right: Any) -> bool:
    if type(left) is not type(right):
        return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(_same_json_value(left[key], right[key]) for key in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(_same_json_value(a, b) for a, b in zip(left, right))
    return bool(left == right)


def _validate_adapter_config_matches(
    adapter_config: dict[str, Any], expected_config: dict[str, Any]
) -> list[str]:
    matched: list[str] = []
    for path in MATCHED_CONFIG_PATHS:
        expected = _get_config_path(expected_config, path, "expected config")
        actual = _get_config_path(adapter_config, path, "adapter_config.json")
        if not _same_json_value(actual, expected):
            raise ArtifactPostflightError(
                f"adapter_config.json field {'.'.join(path)} does not exactly match the expected config"
            )
        matched.append(".".join(path))
    return matched


def _validate_metadata(value: Any) -> None:
    if not isinstance(value, dict):
        raise ArtifactPostflightError("safetensors __metadata__ must be a JSON object")
    for key, item in value.items():
        if not isinstance(key, str) or not isinstance(item, str):
            raise ArtifactPostflightError("safetensors __metadata__ keys and values must be strings")


def _validate_tensor_entries(
    header: dict[str, Any], data_length: int
) -> tuple[list[dict[str, Any]], dict[str, int], int, int, int]:
    if "__metadata__" in header:
        _validate_metadata(header["__metadata__"])
    tensor_items = [(name, value) for name, value in header.items() if name != "__metadata__"]
    if not tensor_items:
        raise ArtifactPostflightError("safetensors must contain at least one tensor")
    if len(tensor_items) > MAX_TENSORS:
        raise ArtifactPostflightError(f"safetensors contains more than {MAX_TENSORS} tensors")

    entries: list[dict[str, Any]] = []
    dtype_counts: dict[str, int] = {}
    floating_tensors = 0
    floating_values = 0
    element_count = 0
    for name, descriptor in tensor_items:
        if not isinstance(name, str) or not name or len(name) > 4096 or "\x00" in name:
            raise ArtifactPostflightError("safetensors tensor names must be non-empty bounded strings without NUL")
        if not isinstance(descriptor, dict) or set(descriptor) != {"dtype", "shape", "data_offsets"}:
            raise ArtifactPostflightError(
                f"tensor {name!r} must contain exactly dtype, shape, and data_offsets"
            )
        dtype = descriptor["dtype"]
        if not isinstance(dtype, str) or dtype not in DTYPE_BYTES:
            raise ArtifactPostflightError(
                f"tensor {name!r} uses unsupported dtype {dtype!r}; float8, complex, and unknown dtypes are rejected"
            )
        shape = descriptor["shape"]
        if not isinstance(shape, list) or len(shape) > MAX_TENSOR_RANK:
            raise ArtifactPostflightError(f"tensor {name!r} shape must be a bounded JSON array")
        elements = 1
        for index, dimension in enumerate(shape):
            dimension = _require_int(
                dimension,
                f"tensor {name!r} shape[{index}]",
                0,
                MAX_TENSOR_DIMENSION,
            )
            elements *= dimension
            if elements > MAX_SAFETENSORS_BYTES:
                # Every supported dtype is at least one byte, so a larger
                # element count cannot fit within the file bound.
                raise ArtifactPostflightError(f"tensor {name!r} shape exceeds the artifact size bound")
        if elements == 0:
            raise ArtifactPostflightError(f"tensor {name!r} must not be empty")

        offsets = descriptor["data_offsets"]
        if not isinstance(offsets, list) or len(offsets) != 2:
            raise ArtifactPostflightError(f"tensor {name!r} data_offsets must be a two-integer array")
        start = _require_int(offsets[0], f"tensor {name!r} data_offsets[0]", 0, data_length)
        end = _require_int(offsets[1], f"tensor {name!r} data_offsets[1]", 0, data_length)
        if end <= start:
            raise ArtifactPostflightError(f"tensor {name!r} data_offsets must describe a non-empty range")
        expected_bytes = elements * DTYPE_BYTES[dtype]
        if end - start != expected_bytes:
            raise ArtifactPostflightError(
                f"tensor {name!r} byte range does not match dtype and shape"
            )
        entry = {
            "name": name,
            "dtype": dtype,
            "shape": shape,
            "start": start,
            "end": end,
            "elements": elements,
        }
        entries.append(entry)
        dtype_counts[dtype] = dtype_counts.get(dtype, 0) + 1
        element_count += elements
        if dtype in FLOAT_DTYPES:
            floating_tensors += 1
            floating_values += elements

    if floating_tensors == 0:
        raise ArtifactPostflightError("safetensors must contain at least one supported floating-point tensor")
    entries.sort(key=lambda item: (item["start"], item["end"], item["name"]))
    cursor = 0
    for entry in entries:
        if entry["start"] < cursor:
            raise ArtifactPostflightError("safetensors tensor byte ranges overlap")
        if entry["start"] > cursor:
            raise ArtifactPostflightError("safetensors tensor byte ranges leave an uncovered gap")
        cursor = entry["end"]
    if cursor != data_length:
        raise ArtifactPostflightError("safetensors tensor byte ranges do not exactly cover the data section")
    return entries, dict(sorted(dtype_counts.items())), floating_tensors, floating_values, element_count


def _reject_nonfinite_chunk(dtype: str, chunk: bytes, tensor_name: str) -> None:
    if dtype == "F16":
        if any((bits & 0x7C00) == 0x7C00 for (bits,) in struct.iter_unpack("<H", chunk)):
            raise ArtifactPostflightError(f"tensor {tensor_name!r} contains a non-finite F16 value")
    elif dtype == "BF16":
        if any((bits & 0x7F80) == 0x7F80 for (bits,) in struct.iter_unpack("<H", chunk)):
            raise ArtifactPostflightError(f"tensor {tensor_name!r} contains a non-finite BF16 value")
    elif dtype == "F32":
        if any(not math.isfinite(value) for (value,) in struct.iter_unpack("<f", chunk)):
            raise ArtifactPostflightError(f"tensor {tensor_name!r} contains a non-finite F32 value")
    elif dtype == "F64":
        if any(not math.isfinite(value) for (value,) in struct.iter_unpack("<d", chunk)):
            raise ArtifactPostflightError(f"tensor {tensor_name!r} contains a non-finite F64 value")


def _scan_tensor_data(
    handle: BinaryIO,
    entries: Iterable[dict[str, Any]],
    file_digest: "hashlib._Hash",
) -> str:
    data_digest = hashlib.sha256()
    for entry in entries:
        remaining = entry["end"] - entry["start"]
        item_size = DTYPE_BYTES[entry["dtype"]]
        while remaining:
            length = min(remaining, READ_CHUNK_BYTES)
            if length % item_size:
                length -= length % item_size
            if length == 0:
                length = item_size
            chunk = _read_exact(handle, length, f"tensor {entry['name']!r}")
            remaining -= len(chunk)
            data_digest.update(chunk)
            file_digest.update(chunk)
            if entry["dtype"] in FLOAT_DTYPES:
                _reject_nonfinite_chunk(entry["dtype"], chunk, entry["name"])
    if handle.read(1):
        raise ArtifactPostflightError("safetensors file has undeclared bytes after the data section")
    return data_digest.hexdigest()


def _validate_safetensors_descriptor(
    descriptor: int,
    file_size: int,
) -> dict[str, Any]:
    if file_size < 8 or file_size > MAX_SAFETENSORS_BYTES:
        raise ArtifactPostflightError(
            f"adapters.safetensors size must be between 8 and {MAX_SAFETENSORS_BYTES} bytes"
        )
    with os.fdopen(descriptor, "rb", closefd=True) as handle:
        prefix = _read_exact(handle, 8, "adapters.safetensors length prefix")
        header_length = struct.unpack("<Q", prefix)[0]
        if header_length == 0 or header_length > MAX_HEADER_BYTES:
            raise ArtifactPostflightError(
                f"safetensors header length must be between 1 and {MAX_HEADER_BYTES} bytes"
            )
        if 8 + header_length > file_size:
            raise ArtifactPostflightError("safetensors header length exceeds the file size")
        header_bytes = _read_exact(handle, header_length, "safetensors header")
        header = _load_safetensors_header(header_bytes)
        data_length = file_size - 8 - header_length
        entries, dtype_counts, floating_tensors, floating_values, element_count = _validate_tensor_entries(
            header, data_length
        )
        file_digest = hashlib.sha256(prefix + header_bytes)
        data_digest = _scan_tensor_data(handle, entries, file_digest)

    return {
        "sizeBytes": file_size,
        "sha256": file_digest.hexdigest(),
        "headerSizeBytes": header_length,
        "headerSha256": _sha256_bytes(header_bytes),
        "dataSizeBytes": data_length,
        "dataSha256": data_digest,
        "tensorCount": len(entries),
        "floatingTensorCount": floating_tensors,
        "floatingValueCount": floating_values,
        "elementCount": element_count,
        "dtypeCounts": dtype_counts,
        "allFloatingValuesFinite": True,
        "exactDataCoverage": True,
    }


def validate_candidate_artifacts(
    adapter_dir: str | Path,
    expected_config_path: str | Path,
) -> dict[str, Any]:
    adapter_path = _absolute_lexical(adapter_dir, "adapter directory")
    expected_path = _absolute_lexical(expected_config_path, "expected config")

    expected_descriptor, expected_metadata = _open_regular_path(expected_path, "expected config")
    expected_config, expected_bytes = _read_bounded_json_descriptor(
        expected_descriptor, expected_metadata.st_size, "expected config"
    )
    _validate_expected_config(expected_config)

    directory_descriptor = _open_directory(adapter_path, "adapter directory")
    try:
        config_descriptor, config_metadata = _open_regular_at(
            directory_descriptor, "adapter_config.json", "adapter_config.json"
        )
        adapter_config, adapter_config_bytes = _read_bounded_json_descriptor(
            config_descriptor, config_metadata.st_size, "adapter_config.json"
        )
        matched_fields = _validate_adapter_config_matches(adapter_config, expected_config)

        tensor_descriptor, tensor_metadata = _open_regular_at(
            directory_descriptor, "adapters.safetensors", "adapters.safetensors"
        )
        safetensors = _validate_safetensors_descriptor(tensor_descriptor, tensor_metadata.st_size)
    finally:
        os.close(directory_descriptor)

    core: dict[str, Any] = {
        "schemaVersion": SCHEMA_VERSION,
        "valid": True,
        "adapterDirectory": str(adapter_path),
        "expectedConfig": {
            "path": str(expected_path),
            "sizeBytes": len(expected_bytes),
            "sha256": _sha256_bytes(expected_bytes),
        },
        "adapterConfig": {
            "fileName": "adapter_config.json",
            "sizeBytes": len(adapter_config_bytes),
            "sha256": _sha256_bytes(adapter_config_bytes),
            "matchedFields": matched_fields,
        },
        "safetensors": {"fileName": "adapters.safetensors", **safetensors},
    }
    return _with_result_digest(core)


def _emit_result(value: dict[str, Any]) -> None:
    sys.stdout.buffer.write(_canonical_json_bytes(value) + b"\n")


def build_parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(
        description="Structurally validate a local MLX adapter candidate without importing MLX or NumPy."
    )
    parser.add_argument("--adapter-dir", required=True, help="Directory containing MLX adapter artifacts")
    parser.add_argument(
        "--expected-config",
        required=True,
        help="Reviewed MLX JSON config whose adapter-critical fields must match",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = build_parser().parse_args(argv)
        _emit_result(validate_candidate_artifacts(arguments.adapter_dir, arguments.expected_config))
        return 0
    except ArtifactPostflightError as error:
        failure = _with_result_digest(
            {
                "schemaVersion": SCHEMA_VERSION,
                "valid": False,
                "error": {"code": "artifact_validation_failed", "message": str(error)},
            }
        )
        _emit_result(failure)
        return 2
    except OSError:
        failure = _with_result_digest(
            {
                "schemaVersion": SCHEMA_VERSION,
                "valid": False,
                "error": {
                    "code": "artifact_validation_failed",
                    "message": "artifact validation encountered an operating-system error",
                },
            }
        )
        _emit_result(failure)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
