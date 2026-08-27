from __future__ import annotations

import json
import os
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import PropertyMock, patch

from training.common import (
    TrainingLabError,
    deterministic_split,
    load_lab_config,
    load_model_lock_file,
    parse_json_bytes,
    sha256_bytes,
    stable_json_bytes,
    write_once_or_verify,
)
from training.prepare_dataset import prepare_dataset
from training.run_mlx_lora import (
    build_mlx_config,
    execute_training,
    local_training_environment,
    plan_training,
    reject_existing_adapter_state,
    run_candidate_postflight,
    stable_sha256_regular_file,
    validate_local_model,
)
from training.tokenizer_preflight import read_completion_records, validate_token_lengths


class TrainingLabTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "reviewed-export"
        self.bundle.mkdir()
        self.rows = [
            sft_row("sft-a1", "run-a", "Prompt A1", "Reviewed answer A1", "2026-08-25T08:00:00.000Z"),
            sft_row("sft-a2", "run-a", "Prompt A2", "Reviewed answer A2", "2026-08-25T08:00:01.000Z"),
            sft_row("sft-b", "run-b", "Prompt B", "Reviewed answer B", "2026-08-25T08:00:02.000Z"),
            sft_row("sft-c", "run-c", "Prompt C", "Reviewed answer C", "2026-08-25T08:00:03.000Z"),
            sft_row("sft-d", "run-d", "Prompt D", "Reviewed answer D", "2026-08-25T08:00:04.000Z"),
        ]
        self.manifest = write_export(self.bundle, self.rows)
        write_review(self.bundle, self.manifest, [row["id"] for row in self.rows])
        self.config_path = self.root / "lab.json"
        write_config(self.config_path)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def test_prepares_an_idempotent_source_grouped_holdout(self) -> None:
        config = load_lab_config(self.config_path)
        first = prepare_dataset(config)
        second = prepare_dataset(config)

        self.assertEqual(first, second)
        self.assertEqual(first["schemaVersion"], "openprojects.mlx-dataset.v1")
        self.assertTrue(first["split"]["holdoutIsSealedFromMlxV1"])
        train_prompts = completion_prompts(config.dataset_dir / "train.jsonl")
        test_prompts = completion_prompts(config.holdout_dir / "holdout.jsonl")
        self.assertEqual("Prompt A1" in train_prompts, "Prompt A2" in train_prompts)
        self.assertEqual("Prompt A1" in test_prompts, "Prompt A2" in test_prompts)
        self.assertFalse(train_prompts & test_prompts)
        self.assertEqual(len(train_prompts | test_prompts), len(self.rows))
        self.assertEqual({path.name for path in config.dataset_dir.iterdir()}, {"train.jsonl", "prepared-manifest.json"})
        holdout_manifest = json.loads((config.holdout_dir / "holdout-manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(holdout_manifest["sealed"])
        self.assertTrue(holdout_manifest["burnAfterAccess"])

    def test_split_keeps_same_runs_and_same_prompts_in_one_component(self) -> None:
        rows = [
            sft_row("one", "run-one", "Shared first", "A", "2026-08-25T08:00:00.000Z"),
            sft_row("two", "run-one", "Bridge prompt", "B", "2026-08-25T08:00:01.000Z"),
            sft_row("three", "run-two", "Bridge prompt", "C", "2026-08-25T08:00:02.000Z"),
            sft_row("four", "run-three", "Independent", "D", "2026-08-25T08:00:03.000Z"),
        ]
        training, test = deterministic_split(rows, "component-seed", 0.25)
        training_ids = {row["id"] for row in training}
        test_ids = {row["id"] for row in test}
        component = {"one", "two", "three"}
        self.assertTrue(component <= training_ids or component <= test_ids)

    def test_rejects_a_tampered_dataset_digest(self) -> None:
        with (self.bundle / "sft.jsonl").open("ab") as handle:
            handle.write(b"\n")
        with self.assertRaisesRegex(TrainingLabError, "sha256 mismatch"):
            prepare_dataset(load_lab_config(self.config_path), write=False)

    def test_requires_exact_model_training_purpose(self) -> None:
        review_path = self.bundle / "review.json"
        review = json.loads(review_path.read_text(encoding="utf-8"))
        review["purpose"] = "content_quality_review"
        review_path.write_bytes(stable_json_bytes(review, pretty=True))
        with self.assertRaisesRegex(TrainingLabError, "purpose must be 'model_training'"):
            prepare_dataset(load_lab_config(self.config_path), write=False)

    def test_requires_explicit_known_row_ids(self) -> None:
        review_path = self.bundle / "review.json"
        review = json.loads(review_path.read_text(encoding="utf-8"))
        review["datasets"][0]["approvedRowIds"].append("sft-not-present")
        review_path.write_bytes(stable_json_bytes(review, pretty=True))
        with self.assertRaisesRegex(TrainingLabError, "unknown approved row IDs"):
            prepare_dataset(load_lab_config(self.config_path), write=False)

    def test_review_must_postdate_the_bound_export(self) -> None:
        review_path = self.bundle / "review.json"
        review = json.loads(review_path.read_text(encoding="utf-8"))
        review["reviewedAt"] = "2026-08-25T07:59:59.000Z"
        review_path.write_bytes(stable_json_bytes(review, pretty=True))
        with self.assertRaisesRegex(TrainingLabError, "cannot precede"):
            prepare_dataset(load_lab_config(self.config_path), write=False)

    def test_rejects_database_or_other_unrecognized_config_fields(self) -> None:
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        config["database"] = "../openprojects.sqlite"
        self.config_path.write_bytes(stable_json_bytes(config, pretty=True))
        with self.assertRaisesRegex(TrainingLabError, "unexpected or missing fields"):
            load_lab_config(self.config_path)

    def test_dry_plan_never_starts_training_or_creates_adapter_directory(self) -> None:
        config = load_lab_config(self.config_path)
        with patch("training.run_mlx_lora.subprocess.run") as subprocess_run:
            plan = plan_training(config)

        subprocess_run.assert_not_called()
        self.assertFalse(plan["willExecute"])
        self.assertFalse(plan["trainingEnabledInConfig"])
        self.assertEqual(plan["command"][:5], [sys.executable, "-I", "-m", "mlx_lm", "lora"])
        self.assertNotIn("--resume-adapter-file", plan["command"])
        self.assertTrue(plan["mlxConfig"]["mask_prompt"])
        self.assertFalse(plan["mlxConfig"]["test"])
        self.assertEqual({path.name for path in config.dataset_dir.iterdir()}, {"train.jsonl", "prepared-manifest.json"})
        self.assertIn("sealed", plan["holdout"])
        self.assertFalse(config.adapter_dir.exists())

    def test_execute_needs_both_config_and_command_gate(self) -> None:
        config = load_lab_config(self.config_path)
        with self.assertRaisesRegex(TrainingLabError, "mlx.enabled is false"):
            execute_training(config)

    def test_execute_rejects_a_mutable_hub_id_and_automated_holdout_eval(self) -> None:
        config = load_lab_config(self.config_path)
        with self.assertRaisesRegex(TrainingLabError, "Hub IDs are plan-only"):
            validate_local_model(config)
        raw = json.loads(self.config_path.read_text(encoding="utf-8"))
        raw["mlx"]["evaluateAfterTraining"] = True
        self.config_path.write_bytes(stable_json_bytes(raw, pretty=True))
        with self.assertRaisesRegex(TrainingLabError, "holdout stays sealed"):
            load_lab_config(self.config_path)

    def test_success_records_candidate_hashes_without_promotion(self) -> None:
        update_training_enabled(self.config_path, True)
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)

        def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[list[str]]:
            self.assertIs(kwargs["shell"], False)
            (config.adapter_dir / "adapters.safetensors").write_bytes(b"candidate weights")
            (config.adapter_dir / "adapter_config.json").write_text('{"rank":8}\n', encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)

        with execution_prerequisites(config), patch("training.run_mlx_lora.subprocess.run", side_effect=fake_run):
            returncode = execute_training(config)

        self.assertEqual(returncode, 0)
        result_path = config.adapter_dir / "attempts" / "attempt-0001.result.json"
        result = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(result["status"], "candidate_unverified")
        self.assertFalse(result["qualified"])
        self.assertEqual(result["promotion"], "not-authorized")
        self.assertEqual(result["processExitCode"], 0)
        self.assertEqual({item["fileName"] for item in result["artifacts"]}, {"adapters.safetensors", "adapter_config.json"})
        run_spec = json.loads((config.adapter_dir / "run-spec.json").read_text(encoding="utf-8"))
        self.assertEqual(run_spec["promotion"], "manual-only")
        self.assertEqual(run_spec["resume"], "unsupported-v1")
        self.assertEqual(run_spec["holdout"], "sealed-not-consumed-v1")
        self.assertEqual(run_spec["runtimeIdentity"], fake_runtime_identity())
        self.assertEqual(run_spec["reviewedModelSource"], "Qwen/Qwen3-1.7B-MLX-4bit")

    def test_zero_process_exit_without_candidate_files_is_not_success(self) -> None:
        update_training_enabled(self.config_path, True)
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)
        with execution_prerequisites(config), patch(
            "training.run_mlx_lora.run_candidate_postflight",
            side_effect=TrainingLabError("missing candidate artifacts"),
        ), patch("training.run_mlx_lora.subprocess.run", return_value=subprocess.CompletedProcess([], 0)):
            returncode = execute_training(config)
        self.assertEqual(returncode, 3)
        result = json.loads(
            (config.adapter_dir / "attempts" / "attempt-0001.result.json").read_text(encoding="utf-8")
        )
        self.assertEqual(result["status"], "failed_artifact_validation")
        self.assertEqual(result["artifacts"], [])

    def test_v1_refuses_every_existing_adapter_directory_instead_of_resuming(self) -> None:
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)
        config.adapter_dir.mkdir(parents=True)
        (config.adapter_dir / "adapters.safetensors").write_bytes(b"partial warm-start weights")
        with self.assertRaisesRegex(TrainingLabError, "never resumes"):
            reject_existing_adapter_state(config)

    def test_training_environment_drops_api_keys(self) -> None:
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "must-not-pass",
                "PATH": "/bin",
                "HF_HUB_OFFLINE": "1",
                "TRANSFORMERS_OFFLINE": "1",
            },
            clear=True,
        ):
            environment = local_training_environment()
        self.assertNotIn("OPENAI_API_KEY", environment)
        self.assertEqual(environment["PATH"], "/bin")
        self.assertEqual(environment["HF_HUB_OFFLINE"], "1")
        self.assertEqual(environment["TRANSFORMERS_OFFLINE"], "1")
        self.assertEqual(environment["HF_HUB_DISABLE_IMPLICIT_TOKEN"], "1")
        self.assertNotIn("HTTPS_PROXY", environment)
        self.assertEqual(environment["PYTHONSAFEPATH"], "1")
        self.assertEqual(environment["PYTHONNOUSERSITE"], "1")

    def test_model_value_is_not_a_shell_command(self) -> None:
        config = json.loads(self.config_path.read_text(encoding="utf-8"))
        config["mlx"]["model"] = "model;touch-pwned"
        self.config_path.write_bytes(stable_json_bytes(config, pretty=True))
        with self.assertRaisesRegex(TrainingLabError, "simple Hugging Face ID"):
            load_lab_config(self.config_path)

    def test_coarse_limits_reject_prompt_swallowing_or_tiny_targets(self) -> None:
        rows = [
            sft_row("long-a", "run-long-a", "x" * 2040, "Reviewed response alpha", "2026-08-25T08:00:00.000Z"),
            sft_row("long-b", "run-long-b", "y" * 700, "Reviewed response beta", "2026-08-25T08:00:01.000Z"),
        ]
        self.manifest = write_export(self.bundle, rows)
        write_review(self.bundle, self.manifest, [row["id"] for row in rows])
        with self.assertRaisesRegex(TrainingLabError, "prompt and response"):
            prepare_dataset(load_lab_config(self.config_path), write=False)

        rows[0]["prompt"] = "Short prompt"
        rows[0]["response"] = "tiny"
        self.manifest = write_export(self.bundle, rows)
        write_review(self.bundle, self.manifest, [row["id"] for row in rows])
        with self.assertRaisesRegex(TrainingLabError, "at least 8"):
            prepare_dataset(load_lab_config(self.config_path), write=False)

    def test_exact_tokenizer_preflight_reserves_margin_and_completion_tokens(self) -> None:
        tokenizer = FakeTokenizer()
        result = validate_token_lengths(
            tokenizer,
            [{"prompt": "p" * 100, "completion": "c" * 40}],
            max_sequence_length=1024,
            reserved_tokens=64,
            minimum_completion_tokens=16,
        )
        self.assertLessEqual(result["maximumObservedFullTokens"], 960)
        self.assertGreaterEqual(result["minimumObservedCompletionTokens"], 16)
        self.assertFalse(result["truncationAllowed"])
        with self.assertRaisesRegex(ValueError, "exact token limit"):
            validate_token_lengths(
                tokenizer,
                [{"prompt": "p" * 950, "completion": "c" * 40}],
                max_sequence_length=1024,
                reserved_tokens=64,
                minimum_completion_tokens=16,
            )

    def test_duplicate_json_keys_are_rejected_in_config_and_jsonl(self) -> None:
        with self.assertRaisesRegex(TrainingLabError, "duplicate JSON key"):
            parse_json_bytes(b'{"key":1,"key":2}', "duplicate fixture")
        original = self.config_path.read_text(encoding="utf-8")
        duplicated = original.replace(
            '"artifactRoot": "artifacts",',
            '"artifactRoot": "artifacts",\n  "artifactRoot": "shadowed",',
            1,
        )
        self.config_path.write_text(duplicated, encoding="utf-8")
        with self.assertRaisesRegex(TrainingLabError, "duplicate JSON key"):
            load_lab_config(self.config_path)
        duplicate_completion = self.root / "duplicate-completion.jsonl"
        duplicate_completion.write_bytes(b'{"prompt":"one","prompt":"two","completion":"answer"}\n')
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            read_completion_records(duplicate_completion)

    def test_artifact_root_and_intermediate_symlinks_are_rejected(self) -> None:
        alternate = self.root / "alternate"
        alternate.mkdir()
        (self.root / "artifacts").symlink_to(alternate, target_is_directory=True)
        with self.assertRaisesRegex(TrainingLabError, "symlinked path component"):
            load_lab_config(self.config_path)
        self.assertEqual(list(alternate.iterdir()), [])

        (self.root / "artifacts").unlink()
        artifacts = self.root / "artifacts"
        artifacts.mkdir()
        (artifacts / "datasets").symlink_to(alternate, target_is_directory=True)
        with self.assertRaisesRegex(TrainingLabError, "symlinked path component"):
            load_lab_config(self.config_path)
        self.assertEqual(list(alternate.iterdir()), [])

    def test_write_once_rejects_a_symlinked_parent(self) -> None:
        root = self.root / "artifacts"
        root.mkdir()
        alternate = self.root / "alternate"
        alternate.mkdir()
        (root / "datasets").symlink_to(alternate, target_is_directory=True)
        with self.assertRaisesRegex(TrainingLabError, "symlink"):
            write_once_or_verify(root / "datasets" / "file.json", b"{}\n", root)
        self.assertFalse((alternate / "file.json").exists())

    def test_stable_hash_rejects_a_file_changed_mid_read(self) -> None:
        path = self.root / "mutable.bin"
        path.write_bytes(b"stable content")
        metadata = os.stat(path)
        changed = types.SimpleNamespace(
            st_mode=metadata.st_mode,
            st_dev=metadata.st_dev,
            st_ino=metadata.st_ino,
            st_size=metadata.st_size,
            st_mtime_ns=metadata.st_mtime_ns + 1,
            st_ctime_ns=metadata.st_ctime_ns,
        )
        with patch("training.run_mlx_lora.os.fstat", side_effect=[metadata, changed]):
            with self.assertRaisesRegex(TrainingLabError, "changed while being read"):
                stable_sha256_regular_file(path)

    def test_config_directory_cannot_shadow_mlx_lm_under_isolated_mode(self) -> None:
        malicious = self.root / "mlx_lm"
        malicious.mkdir()
        marker = self.root / "shadow-executed"
        (malicious / "__init__.py").write_text(
            f"from pathlib import Path\nPath({str(marker)!r}).write_text('executed')\n",
            encoding="utf-8",
        )
        subprocess.run(
            [sys.executable, "-I", "-c", "import mlx_lm"],
            cwd=self.root,
            env=local_training_environment(),
            capture_output=True,
            check=False,
        )
        self.assertFalse(marker.exists())
        model = self.root / "model"
        model.mkdir()
        train = self.root / "train.jsonl"
        train.write_bytes(b'{"prompt":"prompt","completion":"completion long enough"}\n')
        subprocess.run(
            [
                sys.executable,
                "-I",
                str(Path("training/tokenizer_preflight.py").resolve()),
                "--model",
                str(model),
                "--train-jsonl",
                str(train),
                "--max-sequence-length",
                "1024",
                "--expected-runtime-sha256",
                "0" * 64,
                "--expected-model-identity-sha256",
                "1" * 64,
            ],
            cwd=self.root,
            env=local_training_environment(),
            capture_output=True,
            check=False,
        )
        self.assertFalse(marker.exists())

    def test_prelaunch_train_mutation_prevents_child_execution(self) -> None:
        update_training_enabled(self.config_path, True)
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)

        def mutate_after_preflight(*args: object, **kwargs: object) -> dict[str, object]:
            result = fake_preflight(config, fake_runtime_identity(), fake_model_identity()["sha256"])
            with (config.dataset_dir / "train.jsonl").open("ab") as handle:
                handle.write(b"tamper")
            return result

        with (
            patch("training.run_mlx_lora.resolve_mlx_runtime", return_value=fake_runtime_identity()),
            patch("training.run_mlx_lora.validate_local_model", return_value=fake_model_identity()),
            patch("training.run_mlx_lora.run_tokenizer_preflight", side_effect=mutate_after_preflight),
            patch("training.run_mlx_lora.subprocess.run") as child,
        ):
            returncode = execute_training(config)
        self.assertEqual(returncode, 4)
        child.assert_not_called()
        result = json.loads((config.adapter_dir / "attempts" / "attempt-0001.result.json").read_text())
        self.assertEqual(result["status"], "failed_input_integrity_before_launch")

    def test_postlaunch_train_mutation_can_never_become_a_candidate(self) -> None:
        update_training_enabled(self.config_path, True)
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)

        def mutate_during_child(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[list[str]]:
            with (config.dataset_dir / "train.jsonl").open("ab") as handle:
                handle.write(b"tamper")
            (config.adapter_dir / "adapters.safetensors").write_bytes(b"candidate")
            (config.adapter_dir / "adapter_config.json").write_text("{}", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)

        with execution_prerequisites(config), patch(
            "training.run_mlx_lora.subprocess.run", side_effect=mutate_during_child
        ):
            returncode = execute_training(config)
        self.assertEqual(returncode, 4)
        result = json.loads((config.adapter_dir / "attempts" / "attempt-0001.result.json").read_text())
        self.assertEqual(result["status"], "failed_input_integrity_during_run")
        self.assertEqual(result["artifacts"], [])

    def test_postlaunch_model_identity_change_can_never_become_a_candidate(self) -> None:
        update_training_enabled(self.config_path, True)
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)
        changed = dict(fake_model_identity())
        changed["sha256"] = "f" * 64

        def successful_child(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[list[str]]:
            (config.adapter_dir / "adapters.safetensors").write_bytes(b"candidate")
            (config.adapter_dir / "adapter_config.json").write_text("{}", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)

        with (
            patch("training.run_mlx_lora.resolve_mlx_runtime", return_value=fake_runtime_identity()),
            patch(
                "training.run_mlx_lora.validate_local_model",
                side_effect=[fake_model_identity(), fake_model_identity(), changed],
            ),
            patch(
                "training.run_mlx_lora.run_tokenizer_preflight",
                side_effect=lambda *_args: fake_preflight(
                    config, fake_runtime_identity(), fake_model_identity()["sha256"]
                ),
            ),
            patch("training.run_mlx_lora.run_candidate_postflight", return_value=fake_candidate_postflight()),
            patch("training.run_mlx_lora.subprocess.run", side_effect=successful_child),
        ):
            returncode = execute_training(config)
        self.assertEqual(returncode, 4)
        result = json.loads((config.adapter_dir / "attempts" / "attempt-0001.result.json").read_text())
        self.assertEqual(result["status"], "failed_input_integrity_during_run")
        self.assertEqual(result["artifacts"], [])

    def test_postlaunch_runtime_identity_change_can_never_become_a_candidate(self) -> None:
        update_training_enabled(self.config_path, True)
        update_local_model_path(self.config_path)
        config = load_lab_config(self.config_path)
        changed_runtime = dict(fake_runtime_identity())
        changed_runtime["sha256"] = "9" * 64

        def successful_child(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[list[str]]:
            (config.adapter_dir / "adapters.safetensors").write_bytes(b"candidate")
            (config.adapter_dir / "adapter_config.json").write_text("{}", encoding="utf-8")
            return subprocess.CompletedProcess(command, 0)

        with (
            patch(
                "training.run_mlx_lora.resolve_mlx_runtime",
                side_effect=[fake_runtime_identity(), fake_runtime_identity(), changed_runtime],
            ),
            patch("training.run_mlx_lora.validate_local_model", return_value=fake_model_identity()),
            patch(
                "training.run_mlx_lora.run_tokenizer_preflight",
                side_effect=lambda *_args: fake_preflight(
                    config, fake_runtime_identity(), fake_model_identity()["sha256"]
                ),
            ),
            patch("training.run_mlx_lora.run_candidate_postflight", return_value=fake_candidate_postflight()),
            patch("training.run_mlx_lora.subprocess.run", side_effect=successful_child),
        ):
            returncode = execute_training(config)
        self.assertEqual(returncode, 4)
        result = json.loads((config.adapter_dir / "attempts" / "attempt-0001.result.json").read_text())
        self.assertEqual(result["status"], "failed_input_integrity_during_run")
        self.assertEqual(result["artifacts"], [])

    def test_reviewed_model_lock_is_digest_bound(self) -> None:
        lock = load_model_lock_file(
            Path("training/model-locks/qwen3-1.7b-mlx-4bit-21457c6f.json").resolve()
        )
        self.assertEqual(lock["source"], "Qwen/Qwen3-1.7B-MLX-4bit")
        self.assertEqual(len(lock["files"]), 10)

        config = load_lab_config(self.config_path)
        model_dir = self.root / "toy-model"
        model_dir.mkdir()
        content = b"locked bytes"
        (model_dir / "config.json").write_bytes(content)
        toy_lock = {
            "schemaVersion": "openprojects.local-model-lock.v1",
            "source": config.mlx.model_source,
            "revision": config.mlx.model_revision,
            "files": [
                {
                    "relativePath": "config.json",
                    "sizeBytes": len(content),
                    "sha256": sha256_bytes(content),
                }
            ],
            "sha256": "a" * 64,
        }
        with patch.object(
            type(config), "local_model_dir", new_callable=PropertyMock, return_value=model_dir
        ), patch("training.run_mlx_lora.load_model_lock_file", return_value=toy_lock):
            identity = validate_local_model(config)
            self.assertEqual(identity["files"][0]["sha256"], sha256_bytes(content))
            (model_dir / "extra.json").write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(TrainingLabError, "file set differs"):
                validate_local_model(config)

    def test_runner_accepts_the_isolated_artifact_postflight_contract(self) -> None:
        config = load_lab_config(self.config_path)
        config.adapter_dir.mkdir(parents=True)
        expected = build_mlx_config(config, Path("/local/model"))
        (config.adapter_dir / "mlx-lora-config.json").write_bytes(stable_json_bytes(expected, pretty=True))
        (config.adapter_dir / "adapter_config.json").write_bytes(stable_json_bytes(expected, pretty=True))
        header = stable_json_bytes(
            {"tensor": {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}}
        )
        header += b" " * ((8 - len(header) % 8) % 8)
        (config.adapter_dir / "adapters.safetensors").write_bytes(
            struct.pack("<Q", len(header)) + header + struct.pack("<f", 1.0)
        )
        with patch("training.run_mlx_lora.resolve_mlx_runtime", return_value=fake_runtime_identity()):
            result = run_candidate_postflight(config, fake_runtime_identity())
        self.assertTrue(result["valid"])
        self.assertTrue(result["safetensors"]["allFloatingValuesFinite"])
        self.assertEqual(
            {item["fileName"] for item in result["artifacts"]},
            {"adapters.safetensors", "adapter_config.json"},
        )

        with self.assertRaisesRegex(ValueError, "exact prefix"):
            validate_token_lengths(
                PrefixMismatchTokenizer(),
                [{"prompt": "prompt", "completion": "completion long enough"}],
                max_sequence_length=1024,
                reserved_tokens=64,
                minimum_completion_tokens=16,
            )


def sft_row(identifier: str, run_id: str, prompt: str, response: str, created_at: str) -> dict[str, object]:
    return {
        "schema": "openprojects.sft.v1",
        "id": identifier,
        "prompt": prompt,
        "response": response,
        "source": {
            "feedbackId": f"feedback-{identifier}",
            "runId": run_id,
            "agentId": "openprojects",
            "agentVersion": "0.2.0",
        },
        "createdAt": created_at,
    }


def write_export(bundle: Path, rows: list[dict[str, object]]) -> dict[str, object]:
    jsonl = b"".join(stable_json_bytes(row) + b"\n" for row in rows)
    (bundle / "sft.jsonl").write_bytes(jsonl)
    core: dict[str, object] = {
        "schemaVersion": "openprojects.learning-export.v1",
        "generatedAt": "2026-08-25T08:00:05.000Z",
        "redactionVersion": "obvious-secrets-v1",
        "sourceFeedbackCount": len(rows),
        "exportedRowCount": len(rows),
        "redactionCount": 0,
        "skipped": {
            "rewardMissingResponse": 0,
            "sftMissingCorrection": 0,
            "preferenceInsufficient": 0,
            "duplicateRows": 0,
        },
        "datasets": [
            {
                "kind": "sft",
                "fileName": "sft.jsonl",
                "rowCount": len(rows),
                "sha256": sha256_bytes(jsonl),
            }
        ],
    }
    manifest = {**core, "sha256": sha256_bytes(stable_json_bytes(core))}
    (bundle / "manifest.json").write_bytes(stable_json_bytes(manifest, pretty=True))
    return manifest


def write_review(bundle: Path, manifest: dict[str, object], approved_ids: list[str]) -> None:
    dataset = manifest["datasets"][0]  # type: ignore[index]
    review = {
        "schemaVersion": "openprojects.training-review.v1",
        "decision": "approved",
        "reviewedBy": "reviewer@example.test",
        "reviewedAt": "2026-08-25T09:00:00.000Z",
        "purpose": "model_training",
        "manifestSha256": manifest["sha256"],
        "attestations": {
            "authorizationConfirmed": True,
            "privacyReviewed": True,
            "licensesReviewed": True,
            "poisoningReviewed": True,
            "holdoutPolicyAccepted": True,
        },
        "datasets": [{"kind": "sft", "sha256": dataset["sha256"], "approvedRowIds": approved_ids}],
    }
    (bundle / "review.json").write_bytes(stable_json_bytes(review, pretty=True))


def write_config(path: Path) -> None:
    config = {
        "schemaVersion": "openprojects.training-lab.v1",
        "exportBundle": "reviewed-export",
        "artifactRoot": "artifacts",
        "dataset": {
            "kind": "sft",
            "name": "unit-sft-v1",
            "splitSeed": "unit-test-seed",
            "evaluationRatio": 0.25,
            "minimumApprovedRows": 2,
            "maxPromptCharacters": 2048,
            "maxResponseCharacters": 2048,
        },
        "mlx": {
            "enabled": False,
            "model": "Qwen/Qwen3-1.7B-MLX-4bit",
            "modelSource": "Qwen/Qwen3-1.7B-MLX-4bit",
            "modelRevision": "21457c6f51ed54a7c16e988c0844db973815c137",
            "modelLock": "model-locks/qwen3-1.7b-mlx-4bit-21457c6f.json",
            "adapterName": "unit-adapter-v1",
            "fineTuneType": "lora",
            "numLayers": 4,
            "batchSize": 1,
            "gradientAccumulationSteps": 4,
            "iterations": 20,
            "learningRate": 0.00001,
            "maxSequenceLength": 1024,
            "saveEvery": 10,
            "stepsPerReport": 5,
            "stepsPerEval": 10,
            "gradientCheckpointing": True,
            "evaluateAfterTraining": False,
            "loraRank": 8,
            "loraScale": 16.0,
            "loraDropout": 0.0,
        },
    }
    path.write_bytes(stable_json_bytes(config, pretty=True))


def update_training_enabled(path: Path, enabled: bool) -> None:
    config = json.loads(path.read_text(encoding="utf-8"))
    config["mlx"]["enabled"] = enabled
    path.write_bytes(stable_json_bytes(config, pretty=True))


def update_local_model_path(path: Path) -> None:
    config = json.loads(path.read_text(encoding="utf-8"))
    config["mlx"]["model"] = "models/unit-qwen-snapshot"
    path.write_bytes(stable_json_bytes(config, pretty=True))


def fake_model_identity() -> dict[str, object]:
    core = {
        "schemaVersion": "openprojects.local-model-identity.v1",
        "reviewedSource": "Qwen/Qwen3-1.7B-MLX-4bit",
        "reviewedRevision": "21457c6f51ed54a7c16e988c0844db973815c137",
        "modelLockSha256": "c" * 64,
        "files": [{"relativePath": "model.safetensors", "sizeBytes": 7, "sha256": "a" * 64}],
    }
    return {**core, "sha256": sha256_bytes(stable_json_bytes(core)), "path": Path("/safe/local/model")}


def fake_runtime_identity() -> dict[str, object]:
    core = {
        "schemaVersion": "openprojects.mlx-runtime-identity.v1",
        "pythonExecutable": sys.executable,
        "pythonImplementation": "CPython",
        "pythonVersion": "3.12.test",
        "isolatedMode": True,
        "safePathMode": True,
        "distributions": [
            {"name": "mlx-lm", "version": "0.31.3"},
            {"name": "mlx", "version": "0.31.2"},
            {"name": "transformers", "version": "5.12.1"},
        ],
        "modules": [
            {"name": "mlx_lm", "origin": "/venv/site-packages/mlx_lm/__init__.py"},
            {"name": "mlx.core", "origin": "/venv/site-packages/mlx/core.so"},
            {"name": "transformers", "origin": "/venv/site-packages/transformers/__init__.py"},
        ],
    }
    return {**core, "sha256": sha256_bytes(stable_json_bytes(core))}


def fake_preflight(config: object, runtime: dict[str, object], model_sha256: object) -> dict[str, object]:
    train_path = config.dataset_dir / "train.jsonl"  # type: ignore[attr-defined]
    core = {
        "schemaVersion": "openprojects.tokenizer-preflight.v1",
        "trainJsonlSha256": sha256_bytes(train_path.read_bytes()),
        "modelIdentitySha256": model_sha256,
        "runtimeIdentity": runtime,
        "rows": 4,
        "maxSequenceLength": 1024,
        "reservedTokens": 64,
        "minimumObservedCompletionTokens": 16,
        "truncationAllowed": False,
    }
    return {**core, "sha256": sha256_bytes(stable_json_bytes(core))}


def fake_candidate_postflight() -> dict[str, object]:
    core = {
        "schemaVersion": "openprojects.adapter-artifact-postflight.v1",
        "valid": True,
        "adapterConfig": {"sizeBytes": 2, "sha256": "e" * 64, "matchedFields": []},
        "safetensors": {
            "sizeBytes": 1,
            "sha256": "d" * 64,
            "tensorCount": 1,
            "allFloatingValuesFinite": True,
            "exactDataCoverage": True,
        },
    }
    return {
        **core,
        "sha256": sha256_bytes(stable_json_bytes(core)),
        "artifacts": [
            {"fileName": "adapters.safetensors", "sizeBytes": 1, "sha256": "d" * 64},
            {"fileName": "adapter_config.json", "sizeBytes": 2, "sha256": "e" * 64},
        ],
    }


def execution_prerequisites(config: object):
    return _ExecutionPatches()


class _ExecutionPatches:
    def __enter__(self) -> "_ExecutionPatches":
        self.runtime = patch("training.run_mlx_lora.resolve_mlx_runtime", return_value=fake_runtime_identity())
        self.model = patch("training.run_mlx_lora.validate_local_model", return_value=fake_model_identity())
        self.preflight = patch(
            "training.run_mlx_lora.run_tokenizer_preflight",
            side_effect=lambda config, _model, runtime, model_sha: fake_preflight(config, runtime, model_sha),
        )
        self.postflight = patch(
            "training.run_mlx_lora.run_candidate_postflight", return_value=fake_candidate_postflight()
        )
        self.runtime.start()
        self.model.start()
        self.preflight.start()
        self.postflight.start()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.postflight.stop()
        self.preflight.stop()
        self.model.stop()
        self.runtime.stop()


class FakeTokenizer:
    def apply_chat_template(
        self,
        messages: list[dict[str, str]],
        add_generation_prompt: bool = False,
        return_dict: bool = False,
        *,
        tools: None,
    ) -> list[int]:
        del return_dict
        assert tools is None
        user_length = len(messages[0]["content"])
        if len(messages) == 1:
            return [0] * (user_length + (4 if add_generation_prompt else 2))
        completion_length = len(messages[1]["content"])
        return [0] * (user_length + completion_length + 4)


class PrefixMismatchTokenizer(FakeTokenizer):
    def apply_chat_template(
        self,
        messages: list[dict[str, str]],
        add_generation_prompt: bool = False,
        return_dict: bool = False,
        *,
        tools: None,
    ) -> list[int]:
        tokens = super().apply_chat_template(
            messages,
            add_generation_prompt=add_generation_prompt,
            return_dict=return_dict,
            tools=tools,
        )
        if len(messages) == 1:
            return [1, *tokens[1:]]
        return tokens


def completion_prompts(path: Path) -> set[str]:
    return {json.loads(line)["prompt"] for line in path.read_text(encoding="utf-8").splitlines()}


if __name__ == "__main__":
    unittest.main()
