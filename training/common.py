from __future__ import annotations

import hashlib
import json
import math
import os
import re
import secrets
import stat
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable


CONFIG_SCHEMA = "openprojects.training-lab.v1"
EXPORT_SCHEMA = "openprojects.learning-export.v1"
REVIEW_SCHEMA = "openprojects.training-review.v1"
PREPARED_SCHEMA = "openprojects.mlx-dataset.v1"
RUN_SPEC_SCHEMA = "openprojects.mlx-run-spec.v1"
MODEL_LOCK_SCHEMA = "openprojects.local-model-lock.v1"

SUPPORTED_KINDS = ("rewards", "sft", "preferences")
ATTESTATIONS = (
    "authorizationConfirmed",
    "privacyReviewed",
    "licensesReviewed",
    "poisoningReviewed",
    "holdoutPolicyAccepted",
)
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$")
SAFE_MODEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,239}$")
COMMIT_REVISION = re.compile(r"^[a-f0-9]{40}$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")


class TrainingLabError(ValueError):
    """A fail-closed validation error safe to show to an operator."""


@dataclass(frozen=True)
class DatasetConfig:
    kind: str
    name: str
    split_seed: str
    evaluation_ratio: float
    minimum_approved_rows: int
    max_prompt_characters: int
    max_response_characters: int


@dataclass(frozen=True)
class MlxConfig:
    enabled: bool
    model: str
    model_source: str
    model_revision: str
    model_lock_path: Path
    adapter_name: str
    fine_tune_type: str
    num_layers: int
    batch_size: int
    gradient_accumulation_steps: int
    iterations: int
    learning_rate: float
    max_sequence_length: int
    save_every: int
    steps_per_report: int
    steps_per_eval: int
    gradient_checkpointing: bool
    evaluate_after_training: bool
    lora_rank: int
    lora_scale: float
    lora_dropout: float


@dataclass(frozen=True)
class LabConfig:
    path: Path
    export_bundle: Path
    artifact_root: Path
    dataset: DatasetConfig
    mlx: MlxConfig

    @property
    def dataset_dir(self) -> Path:
        return self.artifact_root / "datasets" / self.dataset.name

    @property
    def holdout_dir(self) -> Path:
        return self.artifact_root / "holdouts" / self.dataset.name

    @property
    def adapter_dir(self) -> Path:
        return self.artifact_root / "adapters" / self.mlx.adapter_name

    @property
    def local_model_dir(self) -> Path | None:
        relative = Path(self.mlx.model)
        if relative.is_absolute() or not relative.parts or relative.parts[0] != "models" or ".." in relative.parts:
            return None
        training_root = Path(__file__).resolve().parent
        unresolved = training_root / relative
        current = training_root
        for part in relative.parts:
            current = current / part
            if current.is_symlink():
                return None
        candidate = unresolved.resolve()
        try:
            candidate.relative_to(training_root / "models")
        except ValueError:
            return None
        return candidate


@dataclass(frozen=True)
class ValidatedExport:
    manifest: dict[str, Any]
    rows_by_kind: dict[str, list[dict[str, Any]]]
    bytes_by_kind: dict[str, bytes]


@dataclass(frozen=True)
class ApprovedRows:
    export: ValidatedExport
    review: dict[str, Any]
    review_sha256: str
    rows: list[dict[str, Any]]


def load_lab_config(path: str | Path) -> LabConfig:
    config_path = Path(path).expanduser().resolve()
    raw = read_json_file(config_path, "training config", 1_000_000)
    require_object(raw, "training config")
    require_exact_keys(raw, {"schemaVersion", "exportBundle", "artifactRoot", "dataset", "mlx"}, "training config")
    require_equal(raw["schemaVersion"], CONFIG_SCHEMA, "training config schemaVersion")

    export_value = require_nonempty_string(raw["exportBundle"], "exportBundle", 4096)
    export_bundle = resolve_read_path(config_path.parent, export_value, "exportBundle")

    artifact_value = require_nonempty_string(raw["artifactRoot"], "artifactRoot", 240)
    artifact_relative = Path(artifact_value)
    if artifact_relative.is_absolute() or ".." in artifact_relative.parts:
        raise TrainingLabError("artifactRoot must be a relative path without '..'")
    # Preserve the lexical path. Resolving here would erase evidence that an
    # existing artifact component is a symlink.
    artifact_root = lexical_absolute(config_path.parent / artifact_relative)
    ensure_inside(config_path.parent, artifact_root, "artifactRoot")
    reject_symlink_components(config_path.parent, artifact_root, "artifactRoot")

    dataset_raw = require_object(raw["dataset"], "dataset")
    require_exact_keys(
        dataset_raw,
        {
            "kind",
            "name",
            "splitSeed",
            "evaluationRatio",
            "minimumApprovedRows",
            "maxPromptCharacters",
            "maxResponseCharacters",
        },
        "dataset",
    )
    kind = require_nonempty_string(dataset_raw["kind"], "dataset.kind", 32)
    if kind != "sft":
        raise TrainingLabError("dataset.kind must be 'sft'; this lab does not silently reinterpret rewards or preferences")
    name = require_safe_name(dataset_raw["name"], "dataset.name")
    split_seed = require_nonempty_string(dataset_raw["splitSeed"], "dataset.splitSeed", 256)
    evaluation_ratio = require_float(dataset_raw["evaluationRatio"], "dataset.evaluationRatio", 0.05, 0.5)
    minimum_rows = require_int(dataset_raw["minimumApprovedRows"], "dataset.minimumApprovedRows", 2, 1_000_000)
    max_prompt = require_int(dataset_raw["maxPromptCharacters"], "dataset.maxPromptCharacters", 64, 1_000_000)
    max_response = require_int(dataset_raw["maxResponseCharacters"], "dataset.maxResponseCharacters", 1, 1_000_000)
    dataset = DatasetConfig(
        kind=kind,
        name=name,
        split_seed=split_seed,
        evaluation_ratio=evaluation_ratio,
        minimum_approved_rows=minimum_rows,
        max_prompt_characters=max_prompt,
        max_response_characters=max_response,
    )

    mlx_raw = require_object(raw["mlx"], "mlx")
    require_exact_keys(
        mlx_raw,
        {
            "enabled",
            "model",
            "modelSource",
            "modelRevision",
            "modelLock",
            "adapterName",
            "fineTuneType",
            "numLayers",
            "batchSize",
            "gradientAccumulationSteps",
            "iterations",
            "learningRate",
            "maxSequenceLength",
            "saveEvery",
            "stepsPerReport",
            "stepsPerEval",
            "gradientCheckpointing",
            "evaluateAfterTraining",
            "loraRank",
            "loraScale",
            "loraDropout",
        },
        "mlx",
    )
    model = require_nonempty_string(mlx_raw["model"], "mlx.model", 240)
    if not SAFE_MODEL.fullmatch(model) or ".." in Path(model).parts:
        raise TrainingLabError("mlx.model must be a simple Hugging Face ID or local relative model path")
    model_source = require_nonempty_string(mlx_raw["modelSource"], "mlx.modelSource", 240)
    if not SAFE_MODEL.fullmatch(model_source) or model_source.count("/") != 1:
        raise TrainingLabError("mlx.modelSource must be a simple owner/repository Hugging Face ID")
    model_revision = require_nonempty_string(mlx_raw["modelRevision"], "mlx.modelRevision", 40)
    if not COMMIT_REVISION.fullmatch(model_revision):
        raise TrainingLabError("mlx.modelRevision must be a lowercase 40-character commit revision")
    model_lock_value = require_nonempty_string(mlx_raw["modelLock"], "mlx.modelLock", 240)
    model_lock_relative = Path(model_lock_value)
    if (
        model_lock_relative.is_absolute()
        or not model_lock_relative.parts
        or model_lock_relative.parts[0] != "model-locks"
        or ".." in model_lock_relative.parts
    ):
        raise TrainingLabError("mlx.modelLock must be a relative model-locks/... path")
    training_root = Path(__file__).resolve().parent
    model_lock_path = lexical_absolute(training_root / model_lock_relative)
    ensure_inside(training_root / "model-locks", model_lock_path, "mlx.modelLock")
    reject_symlink_components(training_root, model_lock_path, "mlx.modelLock")
    model_lock = load_model_lock_file(model_lock_path)
    if model_lock["source"] != model_source or model_lock["revision"] != model_revision:
        raise TrainingLabError("mlx.modelSource/modelRevision must exactly match the reviewed model lock")
    fine_tune_type = require_nonempty_string(mlx_raw["fineTuneType"], "mlx.fineTuneType", 16)
    if fine_tune_type != "lora":
        raise TrainingLabError("mlx.fineTuneType must be 'lora'; full-weight and automatic preference training are out of scope")
    mlx = MlxConfig(
        enabled=require_bool(mlx_raw["enabled"], "mlx.enabled"),
        model=model,
        model_source=model_source,
        model_revision=model_revision,
        model_lock_path=model_lock_path,
        adapter_name=require_safe_name(mlx_raw["adapterName"], "mlx.adapterName"),
        fine_tune_type=fine_tune_type,
        num_layers=require_int(mlx_raw["numLayers"], "mlx.numLayers", 1, 64),
        batch_size=require_int(mlx_raw["batchSize"], "mlx.batchSize", 1, 64),
        gradient_accumulation_steps=require_int(
            mlx_raw["gradientAccumulationSteps"], "mlx.gradientAccumulationSteps", 1, 1024
        ),
        iterations=require_int(mlx_raw["iterations"], "mlx.iterations", 1, 10_000_000),
        learning_rate=require_float(mlx_raw["learningRate"], "mlx.learningRate", 1e-9, 1.0),
        max_sequence_length=require_int(mlx_raw["maxSequenceLength"], "mlx.maxSequenceLength", 64, 131_072),
        save_every=require_int(mlx_raw["saveEvery"], "mlx.saveEvery", 1, 10_000_000),
        steps_per_report=require_int(mlx_raw["stepsPerReport"], "mlx.stepsPerReport", 1, 10_000_000),
        steps_per_eval=require_int(mlx_raw["stepsPerEval"], "mlx.stepsPerEval", 1, 10_000_000),
        gradient_checkpointing=require_bool(mlx_raw["gradientCheckpointing"], "mlx.gradientCheckpointing"),
        evaluate_after_training=require_bool(mlx_raw["evaluateAfterTraining"], "mlx.evaluateAfterTraining"),
        lora_rank=require_int(mlx_raw["loraRank"], "mlx.loraRank", 1, 256),
        lora_scale=require_float(mlx_raw["loraScale"], "mlx.loraScale", 0.000001, 10_000.0),
        lora_dropout=require_float(mlx_raw["loraDropout"], "mlx.loraDropout", 0.0, 0.95),
    )
    if mlx.save_every > mlx.iterations:
        raise TrainingLabError("mlx.saveEvery must not exceed mlx.iterations")
    if mlx.evaluate_after_training:
        raise TrainingLabError("mlx.evaluateAfterTraining must be false in v1; the pilot holdout stays sealed")
    maximum_conservative_characters = 2 * mlx.max_sequence_length
    if dataset.max_prompt_characters > maximum_conservative_characters:
        raise TrainingLabError("dataset.maxPromptCharacters must not exceed 2 * mlx.maxSequenceLength")
    if dataset.max_response_characters > maximum_conservative_characters:
        raise TrainingLabError("dataset.maxResponseCharacters must not exceed 2 * mlx.maxSequenceLength")
    config = LabConfig(config_path, export_bundle, artifact_root, dataset, mlx)
    validate_artifact_layout(config)
    return config


def validate_approved_export(config: LabConfig) -> ApprovedRows:
    root = config.export_bundle
    if not root.is_dir() or root.is_symlink():
        raise TrainingLabError("exportBundle must be an existing, non-symlink directory")
    manifest_path = safe_bundle_file(root, "manifest.json")
    review_path = safe_bundle_file(root, "review.json")
    manifest = read_json_file(manifest_path, "learning export manifest", 5_000_000)
    validated = validate_export_manifest(root, manifest, config.dataset, config.mlx.max_sequence_length)
    review_bytes = read_regular_bytes(review_path, "training review", 5_000_000)
    review = parse_json_bytes(review_bytes, "training review")
    approved_rows = validate_review(review, validated, config.dataset.kind)
    if len(approved_rows) < config.dataset.minimum_approved_rows:
        raise TrainingLabError(
            f"review approves {len(approved_rows)} rows; dataset.minimumApprovedRows requires "
            f"{config.dataset.minimum_approved_rows}"
        )
    return ApprovedRows(
        export=validated,
        review=review,
        review_sha256=sha256_bytes(review_bytes),
        rows=approved_rows,
    )


def validate_export_manifest(
    root: Path,
    manifest: Any,
    dataset_config: DatasetConfig,
    max_sequence_length: int,
) -> ValidatedExport:
    manifest = require_object(manifest, "learning export manifest")
    require_exact_keys(
        manifest,
        {
            "schemaVersion",
            "generatedAt",
            "redactionVersion",
            "sourceFeedbackCount",
            "exportedRowCount",
            "redactionCount",
            "skipped",
            "datasets",
            "sha256",
        },
        "learning export manifest",
    )
    require_equal(manifest["schemaVersion"], EXPORT_SCHEMA, "learning export manifest schemaVersion")
    require_equal(manifest["redactionVersion"], "obvious-secrets-v1", "learning export redactionVersion")
    require_iso_timestamp(manifest["generatedAt"], "learning export generatedAt")
    for key in ("sourceFeedbackCount", "exportedRowCount", "redactionCount"):
        require_int(manifest[key], f"learning export {key}", 0, 100_000_000)
    skipped = require_object(manifest["skipped"], "learning export skipped")
    require_exact_keys(
        skipped,
        {"rewardMissingResponse", "sftMissingCorrection", "preferenceInsufficient", "duplicateRows"},
        "learning export skipped",
    )
    for key, value in skipped.items():
        require_int(value, f"learning export skipped.{key}", 0, 100_000_000)
    manifest_hash = require_sha256(manifest["sha256"], "learning export sha256")
    manifest_core = dict(manifest)
    del manifest_core["sha256"]
    if sha256_bytes(stable_json_bytes(manifest_core)) != manifest_hash:
        raise TrainingLabError("learning export manifest sha256 does not match its canonical content")

    entries = manifest["datasets"]
    if not isinstance(entries, list) or not entries:
        raise TrainingLabError("learning export datasets must be a non-empty array")
    rows_by_kind: dict[str, list[dict[str, Any]]] = {}
    bytes_by_kind: dict[str, bytes] = {}
    total_rows = 0
    for index, entry_value in enumerate(entries):
        entry = require_object(entry_value, f"learning export datasets[{index}]")
        require_exact_keys(entry, {"kind", "fileName", "rowCount", "sha256"}, f"learning export datasets[{index}]")
        kind = require_nonempty_string(entry["kind"], f"learning export datasets[{index}].kind", 32)
        if kind not in SUPPORTED_KINDS or kind in rows_by_kind:
            raise TrainingLabError(f"learning export dataset kind is unsupported or duplicated: {kind}")
        expected_name = f"{kind}.jsonl"
        require_equal(entry["fileName"], expected_name, f"learning export {kind} fileName")
        row_count = require_int(entry["rowCount"], f"learning export {kind} rowCount", 0, 100_000_000)
        expected_hash = require_sha256(entry["sha256"], f"learning export {kind} sha256")
        dataset_path = safe_bundle_file(root, expected_name)
        data = read_regular_bytes(dataset_path, f"learning export {kind}", 512 * 1024 * 1024)
        if sha256_bytes(data) != expected_hash:
            raise TrainingLabError(f"learning export {kind} sha256 mismatch")
        rows = parse_and_validate_jsonl(data, kind, dataset_config, max_sequence_length)
        if len(rows) != row_count:
            raise TrainingLabError(f"learning export {kind} rowCount mismatch")
        rows_by_kind[kind] = rows
        bytes_by_kind[kind] = data
        total_rows += len(rows)
    if total_rows != manifest["exportedRowCount"]:
        raise TrainingLabError("learning export exportedRowCount does not equal the dataset row total")
    if dataset_config.kind not in rows_by_kind:
        raise TrainingLabError(f"learning export does not contain the required {dataset_config.kind} dataset")
    return ValidatedExport(manifest, rows_by_kind, bytes_by_kind)


def validate_review(review_value: Any, validated: ValidatedExport, requested_kind: str) -> list[dict[str, Any]]:
    review = require_object(review_value, "training review")
    require_exact_keys(
        review,
        {
            "schemaVersion",
            "decision",
            "reviewedBy",
            "reviewedAt",
            "purpose",
            "manifestSha256",
            "attestations",
            "datasets",
        },
        "training review",
    )
    require_equal(review["schemaVersion"], REVIEW_SCHEMA, "training review schemaVersion")
    require_equal(review["decision"], "approved", "training review decision")
    require_nonempty_string(review["reviewedBy"], "training review reviewedBy", 256)
    require_iso_timestamp(review["reviewedAt"], "training review reviewedAt")
    if parsed_iso_timestamp(review["reviewedAt"]) < parsed_iso_timestamp(validated.manifest["generatedAt"]):
        raise TrainingLabError("training review reviewedAt cannot precede the bound export")
    require_equal(review["purpose"], "model_training", "training review purpose")
    review_manifest_hash = require_sha256(review["manifestSha256"], "training review manifestSha256")
    if review_manifest_hash != validated.manifest["sha256"]:
        raise TrainingLabError("training review is not bound to this learning export manifest")
    attestations = require_object(review["attestations"], "training review attestations")
    require_exact_keys(attestations, set(ATTESTATIONS), "training review attestations")
    for name in ATTESTATIONS:
        if require_bool(attestations[name], f"training review attestations.{name}") is not True:
            raise TrainingLabError(f"training review attestation must be true: {name}")

    entries = review["datasets"]
    if not isinstance(entries, list) or not entries:
        raise TrainingLabError("training review datasets must be a non-empty array")
    reviewed_kinds: set[str] = set()
    approved_for_requested: list[str] | None = None
    for index, entry_value in enumerate(entries):
        entry = require_object(entry_value, f"training review datasets[{index}]")
        require_exact_keys(entry, {"kind", "sha256", "approvedRowIds"}, f"training review datasets[{index}]")
        kind = require_nonempty_string(entry["kind"], f"training review datasets[{index}].kind", 32)
        if kind in reviewed_kinds or kind not in validated.rows_by_kind:
            raise TrainingLabError(f"training review dataset kind is missing from export or duplicated: {kind}")
        reviewed_kinds.add(kind)
        manifest_entry = next(item for item in validated.manifest["datasets"] if item["kind"] == kind)
        if require_sha256(entry["sha256"], f"training review {kind} sha256") != manifest_entry["sha256"]:
            raise TrainingLabError(f"training review {kind} digest is not bound to the exported dataset")
        ids_value = entry["approvedRowIds"]
        if not isinstance(ids_value, list) or not ids_value:
            raise TrainingLabError(f"training review {kind} approvedRowIds must be non-empty")
        ids = [require_nonempty_string(value, f"training review {kind} approvedRowIds", 256) for value in ids_value]
        if len(ids) != len(set(ids)):
            raise TrainingLabError(f"training review {kind} approvedRowIds contains duplicates")
        available = {row["id"] for row in validated.rows_by_kind[kind]}
        unknown = sorted(set(ids) - available)
        if unknown:
            raise TrainingLabError(f"training review {kind} contains unknown approved row IDs")
        if kind == requested_kind:
            approved_for_requested = ids
    if approved_for_requested is None:
        raise TrainingLabError(f"training review does not approve the required {requested_kind} dataset")
    approved = set(approved_for_requested)
    return [row for row in validated.rows_by_kind[requested_kind] if row["id"] in approved]


def deterministic_split(
    rows: Iterable[dict[str, Any]], seed: str, evaluation_ratio: float
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    # Source runs and normalized prompts form connected components. This keeps
    # both repeated corrections from one run and repeated prompts from different
    # runs on exactly one side of the holdout boundary.
    parents: dict[str, str] = {}

    def find(label: str) -> str:
        parents.setdefault(label, label)
        while parents[label] != label:
            parents[label] = parents[parents[label]]
            label = parents[label]
        return label

    def union(left: str, right: str) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root == right_root:
            return
        lower, higher = sorted((left_root, right_root))
        parents[higher] = lower

    labeled_rows: list[tuple[dict[str, Any], str]] = []
    for row in rows:
        normalized_prompt = " ".join(str(row.get("prompt", "")).split()).casefold()
        prompt_key = f"prompt:{sha256_bytes(normalized_prompt.encode('utf-8'))}"
        source = row.get("source")
        run_id = source.get("runId") if isinstance(source, dict) else None
        primary_key = prompt_key
        if isinstance(run_id, str) and run_id:
            run_key = f"run:{run_id}"
            union(run_key, prompt_key)
            primary_key = run_key
        else:
            find(prompt_key)
        labeled_rows.append((row, primary_key))

    grouped: dict[str, list[dict[str, Any]]] = {}
    for row, primary_key in labeled_rows:
        grouped.setdefault(find(primary_key), []).append(row)
    if len(grouped) < 2:
        raise TrainingLabError("at least two independent source run/prompt components are required for a held-out split")
    ranked_groups = sorted(
        grouped.items(),
        key=lambda item: (hashlib.sha256(f"{seed}\0{item[0]}".encode("utf-8")).hexdigest(), item[0]),
    )
    target_evaluation_rows = max(1, math.ceil(sum(len(group) for _, group in ranked_groups) * evaluation_ratio))
    evaluation_group_keys: set[str] = set()
    evaluation_rows = 0
    for group_key, group in ranked_groups:
        if len(evaluation_group_keys) == len(ranked_groups) - 1:
            break
        if evaluation_rows >= target_evaluation_rows:
            break
        evaluation_group_keys.add(group_key)
        evaluation_rows += len(group)
    training = [row for key, group in ranked_groups if key not in evaluation_group_keys for row in group]
    evaluation = [row for key, group in ranked_groups if key in evaluation_group_keys for row in group]
    if not training or not evaluation:
        raise TrainingLabError("the source-group split must leave both training and held-out rows")
    return training, evaluation


def completion_jsonl(rows: Iterable[dict[str, Any]]) -> bytes:
    records = [{"prompt": row["prompt"], "completion": row["response"]} for row in rows]
    return b"".join(stable_json_bytes(record) + b"\n" for record in records)


def stable_json_bytes(value: Any, pretty: bool = False) -> bytes:
    if pretty:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return text.encode("utf-8")


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def write_once_or_verify(path: Path, value: bytes, allowed_root: Path | None = None) -> None:
    if allowed_root is not None:
        ensure_directory_tree(allowed_root, path.parent, f"artifact parent for {path.name}")
        reject_symlink_components(allowed_root, path.parent, f"artifact parent for {path.name}")
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_file():
            raise TrainingLabError(f"refusing non-regular existing artifact: {path.name}")
        if path.read_bytes() != value:
            raise TrainingLabError(f"refusing to overwrite mismatched artifact: {path.name}")
        return
    temporary = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(8)}"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(value)
                handle.flush()
                os.fsync(handle.fileno())
        except BaseException:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise
        try:
            os.link(temporary, path)
        except FileExistsError:
            if path.is_symlink() or not path.is_file() or path.read_bytes() != value:
                raise TrainingLabError(f"artifact appeared with different content: {path.name}")
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def safe_bundle_file(root: Path, name: str) -> Path:
    path = root / name
    ensure_inside(root, path.resolve(strict=False), name)
    if path.is_symlink():
        raise TrainingLabError(f"bundle file must not be a symlink: {name}")
    return path


def read_regular_bytes(path: Path, label: str, maximum_bytes: int) -> bytes:
    if not path.is_file() or path.is_symlink():
        raise TrainingLabError(f"{label} must be an existing regular file")
    size = path.stat().st_size
    if size > maximum_bytes:
        raise TrainingLabError(f"{label} exceeds the {maximum_bytes}-byte limit")
    return path.read_bytes()


def read_json_file(path: Path, label: str, maximum_bytes: int) -> Any:
    data = read_regular_bytes(path, label, maximum_bytes)
    return parse_json_bytes(data, label)


class _DuplicateJsonKey(ValueError):
    pass


def _strict_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise _DuplicateJsonKey(key)
        result[key] = value
    return result


def parse_json_bytes(data: bytes, label: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=_strict_object_pairs)
    except _DuplicateJsonKey as error:
        raise TrainingLabError(f"{label} contains a duplicate JSON key: {error}") from error
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TrainingLabError(f"{label} is not valid UTF-8 JSON") from error


def parse_and_validate_jsonl(
    data: bytes,
    kind: str,
    dataset_config: DatasetConfig,
    max_sequence_length: int,
) -> list[dict[str, Any]]:
    if not data:
        return []
    if not data.endswith(b"\n"):
        raise TrainingLabError(f"learning export {kind} must end with a newline")
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for index, raw_line in enumerate(data.splitlines()):
        if not raw_line:
            raise TrainingLabError(f"learning export {kind} contains a blank line")
        row = parse_json_bytes(raw_line, f"learning export {kind} row {index + 1}")
        row = validate_dataset_row(row, kind, dataset_config, max_sequence_length, index)
        if stable_json_bytes(row) != raw_line:
            raise TrainingLabError(f"learning export {kind} row {index + 1} is not canonically serialized")
        if row["id"] in seen:
            raise TrainingLabError(f"learning export {kind} contains a duplicate row ID")
        seen.add(row["id"])
        rows.append(row)
    expected_order = sorted(rows, key=lambda row: (row["createdAt"], row["id"]))
    if [row["id"] for row in rows] != [row["id"] for row in expected_order]:
        raise TrainingLabError(f"learning export {kind} rows are not in deterministic order")
    return rows


def validate_dataset_row(
    value: Any,
    kind: str,
    config: DatasetConfig,
    max_sequence_length: int,
    index: int,
) -> dict[str, Any]:
    row = require_object(value, f"{kind} row {index + 1}")
    common_text = (("prompt", config.max_prompt_characters),)
    if kind == "sft":
        require_exact_keys(row, {"schema", "id", "prompt", "response", "source", "createdAt"}, f"sft row {index + 1}")
        require_equal(row["schema"], "openprojects.sft.v1", "sft schema")
        require_training_text(row["prompt"], "sft prompt", config.max_prompt_characters, 1)
        require_training_text(row["response"], "sft response", config.max_response_characters, 8)
        combined_limit = 2 * max_sequence_length
        if len(row["prompt"]) + len(row["response"]) > combined_limit:
            raise TrainingLabError(f"sft prompt and response exceed the conservative {combined_limit}-character limit")
        if len(row["prompt"].encode("utf-8")) + len(row["response"].encode("utf-8")) > combined_limit:
            raise TrainingLabError(f"sft prompt and response exceed the conservative {combined_limit}-byte UTF-8 limit")
        validate_source(row["source"], "sft source")
    elif kind == "preferences":
        require_exact_keys(
            row, {"schema", "id", "prompt", "chosen", "rejected", "source", "createdAt"}, f"preference row {index + 1}"
        )
        require_equal(row["schema"], "openprojects.preference.v1", "preference schema")
        for key, limit in (*common_text, ("chosen", config.max_response_characters), ("rejected", config.max_response_characters)):
            require_nonempty_string(row[key], f"preference {key}", limit)
        if " ".join(row["chosen"].split()).casefold() == " ".join(row["rejected"].split()).casefold():
            raise TrainingLabError("preference chosen and rejected responses must differ")
        validate_source(row["source"], "preference source")
    elif kind == "rewards":
        required = {"schema", "id", "prompt", "response", "reward", "dimensions", "run", "feedbackId", "createdAt"}
        optional = {"reaction", "comment", "correction"}
        require_allowed_keys(row, required, optional, f"reward row {index + 1}")
        require_equal(row["schema"], "openprojects.reward.v1", "reward schema")
        for key, limit in (*common_text, ("response", config.max_response_characters)):
            require_nonempty_string(row[key], f"reward {key}", limit)
        require_float(row["reward"], "reward reward", -1.0, 1.0)
        dimensions = require_object(row["dimensions"], "reward dimensions")
        for key, score in dimensions.items():
            if not isinstance(key, str) or not key or len(key) > 64:
                raise TrainingLabError("reward dimension keys must be non-empty strings of at most 64 characters")
            require_float(score, f"reward dimension {key}", -1_000_000.0, 1_000_000.0)
        run = require_object(row["run"], "reward run")
        require_exact_keys(run, {"id", "agentId", "agentVersion"}, "reward run")
        for key in ("id", "agentId", "agentVersion"):
            require_nonempty_string(run[key], f"reward run.{key}", 256)
        require_nonempty_string(row["feedbackId"], "reward feedbackId", 256)
        for key in optional:
            if key in row:
                require_nonempty_string(row[key], f"reward {key}", config.max_response_characters)
    else:
        raise TrainingLabError(f"unsupported learning dataset kind: {kind}")
    require_nonempty_string(row["id"], f"{kind} id", 256)
    require_iso_timestamp(row["createdAt"], f"{kind} createdAt")
    return row


def validate_source(value: Any, label: str) -> None:
    source = require_object(value, label)
    require_exact_keys(source, {"feedbackId", "runId", "agentId", "agentVersion"}, label)
    for key in ("feedbackId", "runId", "agentId", "agentVersion"):
        require_nonempty_string(source[key], f"{label}.{key}", 256)


def resolve_read_path(parent: Path, value: str, label: str) -> Path:
    candidate = Path(value).expanduser()
    result = candidate.resolve() if candidate.is_absolute() else (parent / candidate).resolve()
    if result == Path(result.anchor):
        raise TrainingLabError(f"{label} must not be a filesystem root")
    return result


def lexical_absolute(path: Path) -> Path:
    return Path(os.path.abspath(os.fspath(path)))


def ensure_inside(root: Path, path: Path, label: str) -> None:
    root_absolute = lexical_absolute(root)
    path_absolute = lexical_absolute(path)
    try:
        path_absolute.relative_to(root_absolute)
    except ValueError as error:
        raise TrainingLabError(f"{label} escapes its allowed directory") from error


def reject_symlink_components(root: Path, path: Path, label: str) -> None:
    root_absolute = lexical_absolute(root)
    path_absolute = lexical_absolute(path)
    ensure_inside(root_absolute, path_absolute, label)
    relative = path_absolute.relative_to(root_absolute)
    current = root_absolute
    components = [current, *(root_absolute.joinpath(*relative.parts[:index]) for index in range(1, len(relative.parts) + 1))]
    for component in components:
        try:
            metadata = os.lstat(component)
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise TrainingLabError(f"{label} contains a symlinked path component: {component.name}")
        if component != path_absolute and not stat.S_ISDIR(metadata.st_mode):
            raise TrainingLabError(f"{label} contains a non-directory path component: {component.name}")


def ensure_directory_tree(root: Path, target: Path, label: str) -> None:
    root_absolute = lexical_absolute(root)
    target_absolute = lexical_absolute(target)
    ensure_inside(root_absolute, target_absolute, label)
    # Walk and create one lexical component at a time, checking with lstat so
    # mkdir(parents=True) cannot silently traverse a pre-existing symlink.
    root_parent = root_absolute.parent
    relative_from_parent = target_absolute.relative_to(root_parent)
    current = root_parent
    for part in relative_from_parent.parts:
        current = current / part
        try:
            metadata = os.lstat(current)
        except FileNotFoundError:
            try:
                current.mkdir()
            except FileExistsError:
                pass
            metadata = os.lstat(current)
        if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISDIR(metadata.st_mode):
            raise TrainingLabError(f"{label} contains a symlink or non-directory component: {current.name}")
    reject_symlink_components(root_absolute, target_absolute, label)


def validate_artifact_layout(config: LabConfig) -> None:
    root = lexical_absolute(config.artifact_root)
    ensure_inside(config.path.parent, root, "artifactRoot")
    reject_symlink_components(config.path.parent, root, "artifactRoot")
    expected = {
        "prepared dataset directory": root / "datasets" / config.dataset.name,
        "sealed holdout directory": root / "holdouts" / config.dataset.name,
        "adapter directory": root / "adapters" / config.mlx.adapter_name,
    }
    actual = {
        "prepared dataset directory": lexical_absolute(config.dataset_dir),
        "sealed holdout directory": lexical_absolute(config.holdout_dir),
        "adapter directory": lexical_absolute(config.adapter_dir),
    }
    for label, expected_path in expected.items():
        if actual[label] != expected_path:
            raise TrainingLabError(f"{label} is not in its expected artifact subtree")
        ensure_inside(root, actual[label], label)
        reject_symlink_components(root, actual[label], label)
    resolved = [path.resolve(strict=False) for path in actual.values()]
    if len(set(resolved)) != len(resolved):
        raise TrainingLabError("dataset, holdout, and adapter directories must remain distinct")


def load_model_lock_file(path: Path) -> dict[str, Any]:
    value = read_json_file(path, "reviewed model lock", 5_000_000)
    lock = require_object(value, "reviewed model lock")
    require_exact_keys(lock, {"schemaVersion", "source", "revision", "files", "sha256"}, "reviewed model lock")
    require_equal(lock["schemaVersion"], MODEL_LOCK_SCHEMA, "reviewed model lock schemaVersion")
    require_nonempty_string(lock["source"], "reviewed model lock source", 240)
    revision = require_nonempty_string(lock["revision"], "reviewed model lock revision", 40)
    if not COMMIT_REVISION.fullmatch(revision):
        raise TrainingLabError("reviewed model lock revision must be a 40-character commit")
    files = lock["files"]
    if not isinstance(files, list) or not files:
        raise TrainingLabError("reviewed model lock files must be a non-empty array")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, raw_entry in enumerate(files):
        entry = require_object(raw_entry, f"reviewed model lock files[{index}]")
        require_exact_keys(entry, {"relativePath", "sizeBytes", "sha256"}, f"reviewed model lock files[{index}]")
        relative_text = require_nonempty_string(
            entry["relativePath"], f"reviewed model lock files[{index}].relativePath", 1024
        )
        relative = Path(relative_text)
        if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != relative_text:
            raise TrainingLabError("reviewed model lock contains an unsafe relative file path")
        if relative_text in seen:
            raise TrainingLabError("reviewed model lock contains duplicate file paths")
        seen.add(relative_text)
        normalized.append({
            "relativePath": relative_text,
            "sizeBytes": require_int(entry["sizeBytes"], "reviewed model lock file sizeBytes", 1, 100_000_000_000),
            "sha256": require_sha256(entry["sha256"], "reviewed model lock file sha256"),
        })
    if normalized != sorted(normalized, key=lambda entry: entry["relativePath"]):
        raise TrainingLabError("reviewed model lock files must be sorted by relativePath")
    core = dict(lock)
    digest = require_sha256(core.pop("sha256"), "reviewed model lock sha256")
    if sha256_bytes(stable_json_bytes(core)) != digest:
        raise TrainingLabError("reviewed model lock sha256 does not match its canonical content")
    return lock


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TrainingLabError(f"{label} must be an object")
    return value


def require_exact_keys(value: dict[str, Any], expected: set[str], label: str) -> None:
    actual = set(value)
    if actual != expected:
        raise TrainingLabError(f"{label} has unexpected or missing fields: {sorted(actual ^ expected)}")


def require_allowed_keys(value: dict[str, Any], required: set[str], optional: set[str], label: str) -> None:
    actual = set(value)
    if not required.issubset(actual) or not actual.issubset(required | optional):
        raise TrainingLabError(f"{label} has unexpected or missing fields")


def require_equal(value: Any, expected: Any, label: str) -> None:
    if value != expected:
        raise TrainingLabError(f"{label} must be {expected!r}")


def require_nonempty_string(value: Any, label: str, maximum: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > maximum or "\x00" in value:
        raise TrainingLabError(f"{label} must be a non-empty string of at most {maximum} characters")
    return value


def require_training_text(value: Any, label: str, maximum: int, minimum_non_whitespace: int) -> str:
    text = require_nonempty_string(value, label, maximum)
    if len(text.strip()) < minimum_non_whitespace:
        raise TrainingLabError(f"{label} must contain at least {minimum_non_whitespace} non-whitespace characters")
    if len(text.encode("utf-8")) > maximum:
        raise TrainingLabError(f"{label} UTF-8 encoding must not exceed {maximum} bytes")
    return text


def require_safe_name(value: Any, label: str) -> str:
    text = require_nonempty_string(value, label, 80)
    if not SAFE_NAME.fullmatch(text):
        raise TrainingLabError(f"{label} contains unsafe path characters")
    return text


def require_bool(value: Any, label: str) -> bool:
    if not isinstance(value, bool):
        raise TrainingLabError(f"{label} must be a boolean")
    return value


def require_int(value: Any, label: str, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        raise TrainingLabError(f"{label} must be an integer from {minimum} to {maximum}")
    return value


def require_float(value: Any, label: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise TrainingLabError(f"{label} must be a finite number")
    result = float(value)
    if not minimum <= result <= maximum:
        raise TrainingLabError(f"{label} must be from {minimum} to {maximum}")
    return result


def require_sha256(value: Any, label: str) -> str:
    text = require_nonempty_string(value, label, 64)
    if not SHA256.fullmatch(text):
        raise TrainingLabError(f"{label} must be a lowercase SHA-256 digest")
    return text


def require_iso_timestamp(value: Any, label: str) -> str:
    text = require_nonempty_string(value, label, 64)
    try:
        parsed = parsed_iso_timestamp(text)
    except ValueError as error:
        raise TrainingLabError(f"{label} must be an ISO-8601 timestamp") from error
    if parsed.tzinfo is None:
        raise TrainingLabError(f"{label} must include a timezone")
    return text


def parsed_iso_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))
