from __future__ import annotations

import hashlib
import io
import json
import math
import os
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from training import artifact_postflight
from training.artifact_postflight import (
    ArtifactPostflightError,
    main,
    validate_candidate_artifacts,
)


class ArtifactPostflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        # Resolve macOS's /var -> /private/var alias so the strict path-component
        # check sees the canonical, symlink-free path.
        self.root = Path(self.temporary.name).resolve()
        self.adapter = self.root / "adapter"
        self.adapter.mkdir()
        self.expected = self.root / "mlx-config.json"
        self.expected_config = expected_config()
        write_json(self.expected, self.expected_config)
        write_json(self.adapter / "adapter_config.json", self.expected_config)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_accepts_supported_float_integer_and_bool_tensors_with_digests(self) -> None:
        tensors = [
            ("half", "F16", [2], struct.pack("<HH", 0x3C00, 0xBC00)),
            ("bfloat", "BF16", [1], struct.pack("<H", 0x3F80)),
            ("single", "F32", [2], struct.pack("<ff", 1.25, -2.5)),
            ("double", "F64", [], struct.pack("<d", math.pi)),
            ("integer", "I32", [2], struct.pack("<ii", -2, 7)),
            ("boolean", "BOOL", [2], b"\x00\x01"),
        ]
        weights = write_safetensors(self.adapter / "adapters.safetensors", tensors)

        result = validate_candidate_artifacts(self.adapter, self.expected)

        self.assertTrue(result["valid"])
        self.assertEqual(result["safetensors"]["tensorCount"], 6)
        self.assertEqual(result["safetensors"]["floatingTensorCount"], 4)
        self.assertEqual(result["safetensors"]["floatingValueCount"], 6)
        self.assertTrue(result["safetensors"]["allFloatingValuesFinite"])
        self.assertTrue(result["safetensors"]["exactDataCoverage"])
        self.assertEqual(result["safetensors"]["sha256"], hashlib.sha256(weights).hexdigest())
        self.assertEqual(
            result["adapterConfig"]["matchedFields"],
            ["model", "fine_tune_type", "num_layers", "max_seq_length", "mask_prompt", "lora_parameters"],
        )
        core = dict(result)
        digest = core.pop("sha256")
        self.assertEqual(digest, hashlib.sha256(canonical_json(core)).hexdigest())

    def test_rejects_each_supported_nonfinite_encoding(self) -> None:
        cases = {
            "f16_inf": ("F16", struct.pack("<H", 0x7C00)),
            "f16_nan": ("F16", struct.pack("<H", 0x7E01)),
            "bf16_inf": ("BF16", struct.pack("<H", 0x7F80)),
            "bf16_nan": ("BF16", struct.pack("<H", 0x7FC1)),
            "f32_nan": ("F32", struct.pack("<f", float("nan"))),
            "f32_inf": ("F32", struct.pack("<f", float("inf"))),
            "f64_nan": ("F64", struct.pack("<d", float("nan"))),
            "f64_inf": ("F64", struct.pack("<d", float("-inf"))),
        }
        for label, (dtype, data) in cases.items():
            with self.subTest(label=label):
                write_safetensors(self.adapter / "adapters.safetensors", [(label, dtype, [1], data)])
                with self.assertRaisesRegex(ArtifactPostflightError, "non-finite"):
                    validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_duplicate_keys_in_header_and_both_configs(self) -> None:
        duplicate_header = (
            b'{"tensor":{"dtype":"F32","shape":[1],"data_offsets":[0,4]},'
            b'"tensor":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}'
        )
        write_raw_safetensors(self.adapter / "adapters.safetensors", duplicate_header, struct.pack("<f", 1.0))
        with self.assertRaisesRegex(ArtifactPostflightError, "duplicate JSON object key"):
            validate_candidate_artifacts(self.adapter, self.expected)

        write_safetensors(
            self.adapter / "adapters.safetensors", [("tensor", "F32", [1], struct.pack("<f", 1.0))]
        )
        (self.adapter / "adapter_config.json").write_text(
            '{"model":"first","model":"second"}', encoding="utf-8"
        )
        with self.assertRaisesRegex(ArtifactPostflightError, "duplicate JSON object key"):
            validate_candidate_artifacts(self.adapter, self.expected)

        write_json(self.adapter / "adapter_config.json", self.expected_config)
        self.expected.write_text('{"model":"first","model":"second"}', encoding="utf-8")
        with self.assertRaisesRegex(ArtifactPostflightError, "duplicate JSON object key"):
            validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_malformed_shapes_offsets_overlap_gaps_and_trailing_data(self) -> None:
        cases = {
            "shape-size mismatch": (
                {"tensor": {"dtype": "F32", "shape": [2], "data_offsets": [0, 4]}},
                b"\0" * 4,
                "does not match dtype and shape",
            ),
            "overlap": (
                {
                    "first": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]},
                    "second": {"dtype": "I32", "shape": [1], "data_offsets": [2, 6]},
                },
                b"\0" * 6,
                "overlap",
            ),
            "gap": (
                {"tensor": {"dtype": "F32", "shape": [1], "data_offsets": [1, 5]}},
                b"\0" * 5,
                "uncovered gap",
            ),
            "trailing": (
                {"tensor": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}},
                b"\0" * 5,
                "exactly cover",
            ),
            "boolean shape": (
                {"tensor": {"dtype": "F32", "shape": [True], "data_offsets": [0, 4]}},
                b"\0" * 4,
                "must be an integer",
            ),
            "empty tensor": (
                {"tensor": {"dtype": "F32", "shape": [0], "data_offsets": [0, 0]}},
                b"",
                "must not be empty",
            ),
        }
        for label, (header, data, message) in cases.items():
            with self.subTest(label=label):
                write_raw_safetensors(
                    self.adapter / "adapters.safetensors", canonical_json(header), data
                )
                with self.assertRaisesRegex(ArtifactPostflightError, message):
                    validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_no_tensor_no_float_and_unsupported_dtype(self) -> None:
        cases = {
            "no tensor": ({"__metadata__": {"source": "unit"}}, b"", "at least one tensor"),
            "integer only": (
                {"integer": {"dtype": "I32", "shape": [1], "data_offsets": [0, 4]}},
                struct.pack("<i", 1),
                "at least one supported floating",
            ),
            "float8": (
                {"float8": {"dtype": "F8_E4M3", "shape": [1], "data_offsets": [0, 1]}},
                b"\0",
                "unsupported dtype",
            ),
        }
        for label, (header, data, message) in cases.items():
            with self.subTest(label=label):
                write_raw_safetensors(
                    self.adapter / "adapters.safetensors", canonical_json(header), data
                )
                with self.assertRaisesRegex(ArtifactPostflightError, message):
                    validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_bounded_sizes_and_invalid_header_padding(self) -> None:
        path = self.adapter / "adapters.safetensors"
        path.write_bytes(struct.pack("<Q", artifact_postflight.MAX_HEADER_BYTES + 1))
        with self.assertRaisesRegex(ArtifactPostflightError, "header length"):
            validate_candidate_artifacts(self.adapter, self.expected)

        write_safetensors(path, [("tensor", "F32", [1], struct.pack("<f", 1.0))])
        with patch.object(artifact_postflight, "MAX_SAFETENSORS_BYTES", 16):
            with self.assertRaisesRegex(ArtifactPostflightError, "size must be"):
                validate_candidate_artifacts(self.adapter, self.expected)

        raw_header = b'{"tensor":{"dtype":"F32","shape":[1],"data_offsets":[0,4]}}\n'
        write_raw_safetensors(path, raw_header, struct.pack("<f", 1.0), pad=False)
        with self.assertRaisesRegex(ArtifactPostflightError, "non-space bytes"):
            validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_config_mismatch_invalid_policy_and_overflowing_number(self) -> None:
        write_safetensors(
            self.adapter / "adapters.safetensors", [("tensor", "F32", [1], struct.pack("<f", 1.0))]
        )
        changed = dict(self.expected_config)
        changed["num_layers"] = 5
        write_json(self.adapter / "adapter_config.json", changed)
        with self.assertRaisesRegex(ArtifactPostflightError, "does not exactly match"):
            validate_candidate_artifacts(self.adapter, self.expected)

        write_json(self.adapter / "adapter_config.json", self.expected_config)
        invalid = dict(self.expected_config)
        invalid["mask_prompt"] = False
        write_json(self.expected, invalid)
        with self.assertRaisesRegex(ArtifactPostflightError, "mask_prompt must be true"):
            validate_candidate_artifacts(self.adapter, self.expected)

        self.expected.write_text('{"model":"m","fine_tune_type":"lora","scale":1e999}', encoding="utf-8")
        with self.assertRaisesRegex(ArtifactPostflightError, "non-finite JSON numbers"):
            validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_missing_symlinked_and_nonregular_artifacts(self) -> None:
        write_safetensors(
            self.adapter / "adapters.safetensors", [("tensor", "F32", [1], struct.pack("<f", 1.0))]
        )
        (self.adapter / "adapter_config.json").unlink()
        with self.assertRaisesRegex(ArtifactPostflightError, "non-symlink regular file"):
            validate_candidate_artifacts(self.adapter, self.expected)

        write_json(self.adapter / "adapter_config.json", self.expected_config)
        weights = self.adapter / "adapters.safetensors"
        weights.unlink()
        outside = self.root / "outside.safetensors"
        outside.write_bytes(b"not trusted")
        weights.symlink_to(outside)
        with self.assertRaisesRegex(ArtifactPostflightError, "non-symlink regular file"):
            validate_candidate_artifacts(self.adapter, self.expected)

        weights.unlink()
        weights.mkdir()
        with self.assertRaisesRegex(ArtifactPostflightError, "regular file"):
            validate_candidate_artifacts(self.adapter, self.expected)

    def test_rejects_symlinked_path_components_and_parent_traversal(self) -> None:
        write_safetensors(
            self.adapter / "adapters.safetensors", [("tensor", "F32", [1], struct.pack("<f", 1.0))]
        )
        link = self.root / "adapter-link"
        link.symlink_to(self.adapter, target_is_directory=True)
        with self.assertRaisesRegex(ArtifactPostflightError, "symlink path components"):
            validate_candidate_artifacts(link, self.expected)
        with self.assertRaisesRegex(ArtifactPostflightError, "must not contain '..'"):
            validate_candidate_artifacts(self.root / "child" / ".." / "adapter", self.expected)

    def test_cli_always_emits_machine_readable_digest_and_nonzero_on_failure(self) -> None:
        write_safetensors(
            self.adapter / "adapters.safetensors", [("tensor", "F32", [1], struct.pack("<f", 1.0))]
        )
        output = io.BytesIO()
        with patch.object(artifact_postflight.sys, "stdout", binary_stdout(output)):
            returncode = main(["--adapter-dir", str(self.adapter), "--expected-config", str(self.expected)])
        success = json.loads(output.getvalue())
        self.assertEqual(returncode, 0)
        self.assertTrue(success["valid"])
        self.assertIn("sha256", success)

        output = io.BytesIO()
        with patch.object(artifact_postflight.sys, "stdout", binary_stdout(output)):
            returncode = main(["--adapter-dir", str(self.adapter)])
        failure = json.loads(output.getvalue())
        self.assertEqual(returncode, 2)
        self.assertFalse(failure["valid"])
        self.assertEqual(failure["error"]["code"], "artifact_validation_failed")
        self.assertIn("sha256", failure)


def expected_config() -> dict[str, object]:
    return {
        "model": "/local/training/models/qwen",
        "fine_tune_type": "lora",
        "num_layers": 4,
        "max_seq_length": 1024,
        "mask_prompt": True,
        "lora_parameters": {
            "keys": ["self_attn.q_proj", "self_attn.v_proj"],
            "rank": 8,
            "scale": 16.0,
            "dropout": 0.0,
        },
        "irrelevant_training_field": "allowed",
    }


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")


def write_json(path: Path, value: object) -> None:
    path.write_bytes(canonical_json(value) + b"\n")


def write_safetensors(
    path: Path,
    tensors: list[tuple[str, str, list[int], bytes]],
) -> bytes:
    header: dict[str, object] = {}
    data = bytearray()
    for name, dtype, shape, payload in tensors:
        start = len(data)
        data.extend(payload)
        header[name] = {"dtype": dtype, "shape": shape, "data_offsets": [start, len(data)]}
    return write_raw_safetensors(path, canonical_json(header), bytes(data))


def write_raw_safetensors(path: Path, header: bytes, data: bytes, *, pad: bool = True) -> bytes:
    if pad:
        header += b" " * ((8 - len(header) % 8) % 8)
    content = struct.pack("<Q", len(header)) + header + data
    path.write_bytes(content)
    return content


class binary_stdout:
    def __init__(self, buffer: io.BytesIO) -> None:
        self.buffer = buffer


if __name__ == "__main__":
    unittest.main()
