from __future__ import annotations

import argparse
import hashlib
import os
import platform
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import (
    RUN_SPEC_SCHEMA,
    LabConfig,
    TrainingLabError,
    ensure_inside,
    ensure_directory_tree,
    load_lab_config,
    load_model_lock_file,
    parse_json_bytes,
    reject_symlink_components,
    sha256_bytes,
    stable_json_bytes,
    validate_artifact_layout,
    write_once_or_verify,
)
from .prepare_dataset import prepare_dataset


MLX_CONFIG_FILE = "mlx-lora-config.json"
RUN_SPEC_FILE = "run-spec.json"
PREFLIGHT_FILE = "tokenizer-preflight.json"
ARTIFACT_POSTFLIGHT_FILE = "artifact-postflight.json"
PREFLIGHT_SCRIPT = Path(__file__).resolve().with_name("tokenizer_preflight.py")
RUNTIME_IDENTITY_SCRIPT = Path(__file__).resolve().with_name("runtime_identity.py")
ARTIFACT_POSTFLIGHT_SCRIPT = Path(__file__).resolve().with_name("artifact_postflight.py")
TRUSTED_RUNTIME_CWD = Path(__file__).resolve().parent
IGNORED_MODEL_DIRECTORIES = {".cache", ".git", "__pycache__"}


def build_mlx_config(config: LabConfig, local_model_dir: Path | None = None) -> dict[str, Any]:
    seed_hash = sha256_bytes(config.dataset.split_seed.encode("utf-8"))
    return {
        "model": str(local_model_dir) if local_model_dir is not None else config.mlx.model,
        "train": True,
        # v1 deliberately does not expose the sealed pilot holdout to MLX.
        "test": False,
        "fine_tune_type": config.mlx.fine_tune_type,
        "data": str(config.dataset_dir),
        "seed": int(seed_hash[:8], 16),
        "num_layers": config.mlx.num_layers,
        "batch_size": config.mlx.batch_size,
        "grad_accumulation_steps": config.mlx.gradient_accumulation_steps,
        "iters": config.mlx.iterations,
        "learning_rate": config.mlx.learning_rate,
        "max_seq_length": config.mlx.max_sequence_length,
        "adapter_path": str(config.adapter_dir),
        "save_every": config.mlx.save_every,
        "steps_per_report": config.mlx.steps_per_report,
        "steps_per_eval": config.mlx.steps_per_eval,
        "grad_checkpoint": config.mlx.gradient_checkpointing,
        "mask_prompt": True,
        "report_to": None,
        "lora_parameters": {
            "keys": ["self_attn.q_proj", "self_attn.v_proj"],
            "rank": config.mlx.lora_rank,
            "scale": config.mlx.lora_scale,
            "dropout": config.mlx.lora_dropout,
        },
    }


def build_run_spec(
    config: LabConfig,
    prepared_manifest: dict[str, Any],
    mlx_config: dict[str, Any],
    model_identity: dict[str, Any],
    tokenizer_preflight: dict[str, Any],
    runtime_identity: dict[str, Any],
    train_jsonl_sha256: str,
) -> dict[str, Any]:
    core: dict[str, Any] = {
        "schemaVersion": RUN_SPEC_SCHEMA,
        "runnerVersion": "mlx-reviewed-sft-v1-fresh-only",
        "preparedDatasetSha256": prepared_manifest["sha256"],
        "sourceExportManifestSha256": prepared_manifest["source"]["exportManifestSha256"],
        "sourceReviewSha256": prepared_manifest["source"]["reviewSha256"],
        "mlxConfigSha256": sha256_bytes(stable_json_bytes(mlx_config)),
        "tokenizerPreflightSha256": tokenizer_preflight["sha256"],
        "modelIdentitySha256": model_identity["sha256"],
        "trainJsonlSha256": train_jsonl_sha256,
        "reviewedModelLockSha256": model_identity["modelLockSha256"],
        "reviewedModelSource": config.mlx.model_source,
        "reviewedModelRevision": config.mlx.model_revision,
        "runtimeIdentity": runtime_identity,
        "adapterName": config.mlx.adapter_name,
        "resume": "unsupported-v1",
        "holdout": "sealed-not-consumed-v1",
        "promotion": "manual-only",
    }
    return {**core, "sha256": sha256_bytes(stable_json_bytes(core))}


def build_command(config: LabConfig) -> list[str]:
    return [
        sys.executable,
        "-I",
        "-m",
        "mlx_lm",
        "lora",
        "--config",
        str(config.adapter_dir / MLX_CONFIG_FILE),
    ]


def plan_training(config: LabConfig) -> dict[str, Any]:
    prepared = prepare_dataset(config, write=True)
    blockers: list[str] = []
    local_model = config.local_model_dir
    if local_model is None or not local_model.is_dir() or local_model.is_symlink():
        blockers.append("mlx.model must be changed to an existing non-symlink directory under training/models")
    if config.adapter_dir.exists():
        blockers.append("adapter directory already exists; v1 never resumes or overwrites")
    if not config.mlx.enabled:
        blockers.append("mlx.enabled is false")
    mlx_config = build_mlx_config(config, local_model if local_model and local_model.is_dir() else None)
    return {
        "willExecute": False,
        "trainingEnabledInConfig": config.mlx.enabled,
        "platform": {
            "system": platform.system(),
            "machine": platform.machine(),
            "python": sys.executable,
        },
        "preparedDatasetSha256": prepared["sha256"],
        "adapterDirectory": str(config.adapter_dir),
        "command": build_command(config),
        "mlxConfig": mlx_config,
        "reviewedModelSource": config.mlx.model_source,
        "reviewedModelRevision": config.mlx.model_revision,
        "reviewedModelLock": str(config.mlx.model_lock_path),
        "tokenizerPreflight": "required before execute against the local model",
        "resume": "unsupported; use a fresh adapterName after any attempt",
        "holdout": "sealed artifactRoot/holdouts/.../holdout.jsonl is not exposed to MLX v1",
        "promotion": "never automatic",
        "executeBlockers": blockers,
    }


def execute_training(config: LabConfig) -> int:
    if not config.mlx.enabled:
        raise TrainingLabError("mlx.enabled is false; edit the reviewed config and rerun with --execute")
    validate_artifact_layout(config)
    runtime_identity = resolve_mlx_runtime()
    prepared = prepare_dataset(config, write=True)
    train_jsonl_sha256 = next(
        item["sha256"] for item in prepared["files"] if item["fileName"] == "train.jsonl"
    )
    if stable_sha256_regular_file(config.dataset_dir / "train.jsonl") != train_jsonl_sha256:
        raise TrainingLabError("prepared training file does not match its bound manifest")
    local_model = validate_local_model(config)
    reject_existing_adapter_state(config)
    tokenizer_preflight = run_tokenizer_preflight(
        config,
        local_model["path"],
        runtime_identity,
        local_model["sha256"],
    )
    mlx_config = build_mlx_config(config, local_model["path"])
    model_identity = dict(local_model)
    del model_identity["path"]
    run_spec = build_run_spec(
        config,
        prepared,
        mlx_config,
        model_identity,
        tokenizer_preflight,
        runtime_identity,
        train_jsonl_sha256,
    )

    adapter_dir = config.adapter_dir
    validate_artifact_layout(config)
    ensure_inside(config.artifact_root, adapter_dir, "adapter directory")
    ensure_directory_tree(config.artifact_root, adapter_dir.parent, "adapter parent directory")
    reject_symlink_components(config.artifact_root, adapter_dir.parent, "adapter parent directory")
    try:
        adapter_dir.mkdir(exist_ok=False)
    except FileExistsError as error:
        raise TrainingLabError("adapter directory appeared concurrently; refusing to overwrite or resume") from error
    reject_symlink_components(config.artifact_root, adapter_dir, "adapter directory")
    # A v1 attempt is immutable and fresh-only. Any interruption requires a new
    # adapterName; MLX's weights-only warm start is not optimizer-state resume.
    write_once_or_verify(
        adapter_dir / RUN_SPEC_FILE, stable_json_bytes(run_spec, pretty=True), config.artifact_root
    )
    write_once_or_verify(
        adapter_dir / MLX_CONFIG_FILE, stable_json_bytes(mlx_config, pretty=True), config.artifact_root
    )
    write_once_or_verify(
        adapter_dir / PREFLIGHT_FILE, stable_json_bytes(tokenizer_preflight, pretty=True), config.artifact_root
    )

    attempts = adapter_dir / "attempts"
    ensure_directory_tree(config.artifact_root, attempts, "attempt directory")
    sequence = 1
    timestamp = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    command = build_command(config)
    started = {
        "schemaVersion": "openprojects.mlx-attempt.v1",
        "attempt": sequence,
        "startedAt": timestamp,
        "runSpecSha256": run_spec["sha256"],
        "commandSha256": sha256_bytes(stable_json_bytes(command)),
        "resume": False,
    }
    prefix = f"attempt-{sequence:04d}"
    write_once_or_verify(
        attempts / f"{prefix}.started.json", stable_json_bytes(started, pretty=True), config.artifact_root
    )
    expected_inputs = {
        "modelIdentitySha256": model_identity["sha256"],
        "trainJsonlSha256": train_jsonl_sha256,
        "runtimeIdentitySha256": runtime_identity["sha256"],
    }
    try:
        pre_launch_inputs = capture_bound_input_identity(config)
        require_bound_input_identity(expected_inputs, pre_launch_inputs)
    except TrainingLabError as error:
        result = {
            "schemaVersion": "openprojects.mlx-attempt-result.v1",
            "attempt": sequence,
            "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "runSpecSha256": run_spec["sha256"],
            "status": "failed_input_integrity_before_launch",
            "inputIntegrity": {"verified": False, "error": str(error)},
            "artifacts": [],
            "qualified": False,
            "promotion": "not-authorized",
        }
        write_once_or_verify(
            attempts / f"{prefix}.result.json", stable_json_bytes(result, pretty=True), config.artifact_root
        )
        return 4
    try:
        completed = subprocess.run(
            command,
            cwd=TRUSTED_RUNTIME_CWD,
            env=local_training_environment(),
            shell=False,
            check=False,
        )
        artifacts: list[dict[str, Any]] = []
        candidate_postflight_sha256: str | None = None
        effective_returncode = completed.returncode
        status = "failed"
        post_launch_inputs: dict[str, Any] | None = None
        input_integrity_error: str | None = None
        try:
            post_launch_inputs = capture_bound_input_identity(config)
            require_bound_input_identity(expected_inputs, post_launch_inputs)
        except TrainingLabError as error:
            input_integrity_error = str(error)
            effective_returncode = 4
            status = "failed_input_integrity_during_run"
        if completed.returncode == 0 and input_integrity_error is None:
            try:
                candidate_postflight = run_candidate_postflight(config, runtime_identity)
                artifacts = candidate_postflight["artifacts"]
                candidate_postflight_sha256 = candidate_postflight["sha256"]
                persisted_postflight = {
                    key: value for key, value in candidate_postflight.items() if key != "artifacts"
                }
                write_once_or_verify(
                    adapter_dir / ARTIFACT_POSTFLIGHT_FILE,
                    stable_json_bytes(persisted_postflight, pretty=True),
                    config.artifact_root,
                )
                status = "candidate_unverified"
            except TrainingLabError:
                effective_returncode = 3
                status = "failed_artifact_validation"
        result = {
            "schemaVersion": "openprojects.mlx-attempt-result.v1",
            "attempt": sequence,
            "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "runSpecSha256": run_spec["sha256"],
            "processExitCode": completed.returncode,
            "status": status,
            "artifacts": artifacts,
            "candidatePostflightSha256": candidate_postflight_sha256,
            "inputIntegrity": {
                "verified": input_integrity_error is None,
                "expected": expected_inputs,
                "preLaunch": pre_launch_inputs,
                "postLaunch": post_launch_inputs,
                **({"error": input_integrity_error} if input_integrity_error is not None else {}),
            },
            "qualified": False,
            "promotion": "not-authorized",
        }
        write_once_or_verify(
            attempts / f"{prefix}.result.json", stable_json_bytes(result, pretty=True), config.artifact_root
        )
        return effective_returncode
    except BaseException as error:
        result = {
            "schemaVersion": "openprojects.mlx-attempt-result.v1",
            "attempt": sequence,
            "finishedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "runSpecSha256": run_spec["sha256"],
            "status": "interrupted_unresumable_v1",
            "errorType": type(error).__name__,
            "qualified": False,
            "promotion": "not-authorized",
        }
        write_once_or_verify(
            attempts / f"{prefix}.result.json", stable_json_bytes(result, pretty=True), config.artifact_root
        )
        raise


def resolve_mlx_runtime() -> dict[str, Any]:
    command = [sys.executable, "-I", str(RUNTIME_IDENTITY_SCRIPT)]
    try:
        completed = subprocess.run(
            command,
            cwd=TRUSTED_RUNTIME_CWD,
            env=local_training_environment(),
            shell=False,
            check=False,
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TrainingLabError("could not verify the isolated MLX runtime") from error
    if completed.returncode != 0 or len(completed.stdout) > 1_000_000:
        raise TrainingLabError(
            "pinned mlx-lm/mlx/transformers are not available in the current isolated interpreter"
        )
    identity = parse_json_bytes(completed.stdout, "MLX runtime identity")
    if not isinstance(identity, dict) or identity.get("schemaVersion") != "openprojects.mlx-runtime-identity.v1":
        raise TrainingLabError("isolated MLX runtime returned an unsupported identity")
    core = dict(identity)
    digest = core.pop("sha256", None)
    if not isinstance(digest, str) or sha256_bytes(stable_json_bytes(core)) != digest:
        raise TrainingLabError("isolated MLX runtime identity digest mismatch")
    if identity.get("isolatedMode") is not True or identity.get("safePathMode") is not True:
        raise TrainingLabError("MLX runtime identity was not collected under isolated safe-path mode")
    return identity


def capture_bound_input_identity(config: LabConfig) -> dict[str, str]:
    validate_artifact_layout(config)
    train_path = config.dataset_dir / "train.jsonl"
    reject_symlink_components(config.artifact_root, train_path, "prepared training file")
    local_model = validate_local_model(config)
    return {
        "modelIdentitySha256": local_model["sha256"],
        "trainJsonlSha256": stable_sha256_regular_file(train_path),
        "runtimeIdentitySha256": resolve_mlx_runtime()["sha256"],
    }


def require_bound_input_identity(expected: dict[str, str], actual: dict[str, str]) -> None:
    if actual != expected:
        raise TrainingLabError("model or prepared training bytes changed after review/preflight binding")


def validate_local_model(config: LabConfig) -> dict[str, Any]:
    model_dir = config.local_model_dir
    if model_dir is None:
        raise TrainingLabError(
            "--execute requires mlx.model to be a relative models/... directory under training/models; Hub IDs are plan-only"
        )
    if model_dir.is_symlink() or not model_dir.is_dir():
        raise TrainingLabError("--execute requires an existing non-symlink local model directory")
    model_lock = load_model_lock_file(config.mlx.model_lock_path)
    if model_lock["source"] != config.mlx.model_source or model_lock["revision"] != config.mlx.model_revision:
        raise TrainingLabError("reviewed model lock no longer matches the configured source and revision")
    expected = {entry["relativePath"]: entry for entry in model_lock["files"]}
    discovered: set[str] = set()
    for directory, directory_names, file_names in os.walk(model_dir, followlinks=False):
        current = Path(directory)
        for name in list(directory_names):
            path = current / name
            if name in IGNORED_MODEL_DIRECTORIES:
                directory_names.remove(name)
            elif path.is_symlink():
                raise TrainingLabError("local model directory must not contain symlinked directories")
        for name in sorted(file_names):
            path = current / name
            if path.is_symlink() or not path.is_file():
                raise TrainingLabError("local model directory must contain only regular files")
            relative = path.relative_to(model_dir).as_posix()
            discovered.add(relative)
            if len(discovered) > 10_000:
                raise TrainingLabError("local model contains too many files")
    missing = sorted(set(expected) - discovered)
    extra = sorted(discovered - set(expected))
    if missing or extra:
        raise TrainingLabError(f"local model file set differs from the reviewed lock (missing={missing}, extra={extra})")
    identities: list[dict[str, Any]] = []
    for relative, locked in sorted(expected.items()):
        path = model_dir / relative
        metadata = os.lstat(path)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
            raise TrainingLabError(f"locked local model file is not regular: {relative}")
        if metadata.st_size != locked["sizeBytes"]:
            raise TrainingLabError(f"locked local model file size mismatch: {relative}")
        digest = stable_sha256_regular_file(path)
        if digest != locked["sha256"]:
            raise TrainingLabError(f"locked local model file sha256 mismatch: {relative}")
        identities.append({"relativePath": relative, "sizeBytes": metadata.st_size, "sha256": digest})
    core: dict[str, Any] = {
        "schemaVersion": "openprojects.local-model-identity.v1",
        "reviewedSource": config.mlx.model_source,
        "reviewedRevision": config.mlx.model_revision,
        "modelLockSha256": model_lock["sha256"],
        "files": identities,
    }
    return {**core, "sha256": sha256_bytes(stable_json_bytes(core)), "path": model_dir}


def reject_existing_adapter_state(config: LabConfig) -> None:
    adapter_dir = config.adapter_dir
    if not adapter_dir.exists():
        return
    if adapter_dir.is_symlink() or not adapter_dir.is_dir():
        raise TrainingLabError("adapter path must be a non-symlink directory")
    if any(adapter_dir.iterdir()):
        raise TrainingLabError(
            "adapter directory is not empty; v1 never resumes or overwrites weights/attempts—use a fresh adapterName"
        )
    # An empty stale directory is also rejected to make creation atomic below.
    raise TrainingLabError("adapter directory already exists; use a fresh adapterName")


def run_tokenizer_preflight(
    config: LabConfig,
    model_dir: Path,
    runtime_identity: dict[str, Any],
    model_identity_sha256: str,
) -> dict[str, Any]:
    command = [
        sys.executable,
        "-I",
        str(PREFLIGHT_SCRIPT),
        "--model",
        str(model_dir),
        "--train-jsonl",
        str(config.dataset_dir / "train.jsonl"),
        "--max-sequence-length",
        str(config.mlx.max_sequence_length),
        "--reserved-tokens",
        "64",
        "--minimum-completion-tokens",
        "16",
        "--expected-runtime-sha256",
        runtime_identity["sha256"],
        "--expected-model-identity-sha256",
        model_identity_sha256,
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=TRUSTED_RUNTIME_CWD,
            env=local_training_environment(),
            shell=False,
            check=False,
            capture_output=True,
            text=True,
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TrainingLabError("exact tokenizer preflight could not complete") from error
    if completed.returncode != 0:
        raise TrainingLabError("exact tokenizer preflight rejected the prepared training split")
    if len(completed.stdout.encode("utf-8")) > 1_000_000:
        raise TrainingLabError("tokenizer preflight output exceeded its bound")
    try:
        result = parse_json_bytes(completed.stdout.encode("utf-8"), "tokenizer preflight output")
    except TrainingLabError as error:
        raise TrainingLabError("tokenizer preflight returned invalid JSON") from error
    if not isinstance(result, dict) or result.get("schemaVersion") != "openprojects.tokenizer-preflight.v1":
        raise TrainingLabError("tokenizer preflight returned an unsupported result")
    core = dict(result)
    digest = core.pop("sha256", None)
    if not isinstance(digest, str) or sha256_bytes(stable_json_bytes(core)) != digest:
        raise TrainingLabError("tokenizer preflight result digest mismatch")
    expected_train_sha = sha256_file(config.dataset_dir / "train.jsonl")
    numeric_requirements = {
        "maxSequenceLength": config.mlx.max_sequence_length,
        "reservedTokens": 64,
        "allowedFullTokens": config.mlx.max_sequence_length - 64,
        "minimumRequiredCompletionTokens": 16,
    }
    if any(result.get(key) != value for key, value in numeric_requirements.items()):
        raise TrainingLabError("tokenizer preflight did not apply the required token limits")
    if result.get("trainJsonlSha256") != expected_train_sha:
        raise TrainingLabError("tokenizer preflight was not run against the prepared training file")
    if result.get("modelIdentitySha256") != model_identity_sha256:
        raise TrainingLabError("tokenizer preflight was not bound to the reviewed local model identity")
    if result.get("runtimeIdentity") != runtime_identity:
        raise TrainingLabError("tokenizer preflight runtime differs from the bound MLX runtime")
    if (
        result.get("chatTemplateApplied") is not True
        or result.get("promptMaskOffsetChecked") is not True
        or result.get("promptPrefixExactChecked") is not True
    ):
        raise TrainingLabError("tokenizer preflight did not reproduce MLX completion formatting")
    if result.get("truncationAllowed") is not False:
        raise TrainingLabError("tokenizer preflight must forbid truncation")
    max_observed = result.get("maximumObservedFullTokens")
    min_completion = result.get("minimumObservedCompletionTokens")
    if isinstance(max_observed, bool) or not isinstance(max_observed, int) or max_observed > config.mlx.max_sequence_length - 64:
        raise TrainingLabError("tokenizer preflight observed an overlength sequence")
    if isinstance(min_completion, bool) or not isinstance(min_completion, int) or min_completion < 16:
        raise TrainingLabError("tokenizer preflight observed an undersized completion")
    return result


def run_candidate_postflight(config: LabConfig, runtime_identity: dict[str, Any]) -> dict[str, Any]:
    if resolve_mlx_runtime()["sha256"] != runtime_identity["sha256"]:
        raise TrainingLabError("MLX runtime changed before candidate artifact postflight")
    command = [
        sys.executable,
        "-I",
        str(ARTIFACT_POSTFLIGHT_SCRIPT),
        "--adapter-dir",
        str(config.adapter_dir),
        "--expected-config",
        str(config.adapter_dir / MLX_CONFIG_FILE),
    ]
    try:
        completed = subprocess.run(
            command,
            cwd=TRUSTED_RUNTIME_CWD,
            env=local_training_environment(),
            shell=False,
            check=False,
            capture_output=True,
            timeout=180,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise TrainingLabError("candidate artifact postflight could not complete") from error
    if completed.returncode != 0 or len(completed.stdout) > 1_000_000:
        raise TrainingLabError("candidate artifact failed structural/config/finite-tensor postflight")
    result = parse_json_bytes(completed.stdout, "candidate artifact postflight")
    if not isinstance(result, dict) or result.get("schemaVersion") != "openprojects.adapter-artifact-postflight.v1":
        raise TrainingLabError("candidate artifact postflight returned an unsupported result")
    core = dict(result)
    digest = core.pop("sha256", None)
    if not isinstance(digest, str) or sha256_bytes(stable_json_bytes(core)) != digest:
        raise TrainingLabError("candidate artifact postflight result digest mismatch")
    if result.get("valid") is not True:
        raise TrainingLabError("candidate artifact postflight rejected the artifacts")
    stats = result.get("safetensors")
    if (
        not isinstance(stats, dict)
        or stats.get("allFloatingValuesFinite") is not True
        or stats.get("exactDataCoverage") is not True
        or stats.get("tensorCount", 0) < 1
    ):
        raise TrainingLabError("candidate artifact postflight did not prove finite numeric tensors")
    adapter_config = result.get("adapterConfig")
    if not isinstance(adapter_config, dict):
        raise TrainingLabError("candidate artifact postflight omitted adapter config identity")
    if resolve_mlx_runtime()["sha256"] != runtime_identity["sha256"]:
        raise TrainingLabError("MLX runtime changed during candidate artifact postflight")
    artifacts = [
        {"fileName": "adapters.safetensors", "sizeBytes": stats["sizeBytes"], "sha256": stats["sha256"]},
        {
            "fileName": "adapter_config.json",
            "sizeBytes": adapter_config["sizeBytes"],
            "sha256": adapter_config["sha256"],
        },
    ]
    return {**result, "artifacts": artifacts}


def stable_sha256_regular_file(path: Path) -> str:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as error:
        raise TrainingLabError(f"could not open a stable regular file for hashing: {path.name}") from error
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise TrainingLabError(f"hash input is not a regular file: {path.name}")
        digest = hashlib.sha256()
        bytes_read = 0
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            bytes_read += len(chunk)
            digest.update(chunk)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    try:
        named = os.lstat(path)
    except FileNotFoundError as error:
        raise TrainingLabError(f"hash input disappeared while being read: {path.name}") from error
    stable_fields = ("st_dev", "st_ino", "st_size", "st_mtime_ns", "st_ctime_ns")
    if (
        bytes_read != before.st_size
        or any(getattr(before, field) != getattr(after, field) for field in stable_fields)
        or before.st_dev != named.st_dev
        or before.st_ino != named.st_ino
        or stat.S_ISLNK(named.st_mode)
    ):
        raise TrainingLabError(f"hash input changed while being read: {path.name}")
    return digest.hexdigest()


def sha256_file(path: Path) -> str:
    """Backward-compatible internal alias for stable no-follow hashing."""
    return stable_sha256_regular_file(path)


def local_training_environment() -> dict[str, str]:
    allowed = {
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "PYTHONUTF8",
        "HF_HOME",
        "HUGGINGFACE_HUB_CACHE",
        "TRANSFORMERS_CACHE",
        "XDG_CACHE_HOME",
        "MLX_METAL_CACHE_DIR",
    }
    environment = {key: value for key, value in os.environ.items() if key in allowed}
    environment.update({
        "WANDB_MODE": "disabled",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1",
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "true",
        "PYTHONSAFEPATH": "1",
        "PYTHONNOUSERSITE": "1",
    })
    return environment


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Plan or explicitly execute a fresh reviewed-data-only MLX LoRA attempt. It never promotes a candidate."
    )
    parser.add_argument("--config", required=True, help="Path to an openprojects.training-lab.v1 JSON config")
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Start one fresh local attempt; also requires mlx.enabled=true and a pinned local model snapshot",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        config = load_lab_config(Path(arguments.config))
        if not arguments.execute:
            sys.stdout.buffer.write(stable_json_bytes(plan_training(config), pretty=True))
            return 0
        returncode = execute_training(config)
        return 0 if returncode == 0 else 1
    except TrainingLabError as error:
        print(f"training refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
