from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path
from typing import Any

from .common import (
    PREPARED_SCHEMA,
    LabConfig,
    TrainingLabError,
    completion_jsonl,
    deterministic_split,
    ensure_inside,
    load_lab_config,
    sha256_bytes,
    stable_json_bytes,
    validate_artifact_layout,
    validate_approved_export,
    write_once_or_verify,
)


EXPECTED_TRAINING_FILES = {"train.jsonl", "prepared-manifest.json"}
EXPECTED_HOLDOUT_FILES = {"holdout.jsonl", "holdout-manifest.json"}


def prepare_dataset(config: LabConfig, write: bool = True) -> dict[str, Any]:
    approved = validate_approved_export(config)
    training_rows, holdout_rows = deterministic_split(
        approved.rows,
        config.dataset.split_seed,
        config.dataset.evaluation_ratio,
    )
    minimum_holdout_rows = math.ceil(
        config.dataset.minimum_approved_rows * config.dataset.evaluation_ratio
    )
    minimum_training_rows = config.dataset.minimum_approved_rows - minimum_holdout_rows
    if len(training_rows) < minimum_training_rows or len(holdout_rows) < minimum_holdout_rows:
        raise TrainingLabError(
            "source grouping cannot satisfy the configured minimum training/holdout row counts "
            f"({minimum_training_rows}/{minimum_holdout_rows})"
        )
    train_bytes = completion_jsonl(training_rows)
    holdout_bytes = completion_jsonl(holdout_rows)
    dataset_entry = next(
        entry for entry in approved.export.manifest["datasets"] if entry["kind"] == config.dataset.kind
    )
    approved_ids = sorted(row["id"] for row in approved.rows)
    dataset_config_core = {
        "kind": config.dataset.kind,
        "name": config.dataset.name,
        "evaluationRatio": config.dataset.evaluation_ratio,
        "minimumApprovedRows": config.dataset.minimum_approved_rows,
        "maxPromptCharacters": config.dataset.max_prompt_characters,
        "maxResponseCharacters": config.dataset.max_response_characters,
        "maxSequenceLength": config.mlx.max_sequence_length,
        "combinedCharacterAndUtf8ByteLimit": 2 * config.mlx.max_sequence_length,
    }
    holdout_core: dict[str, Any] = {
        "schemaVersion": "openprojects.sealed-holdout.v1",
        "sourceGeneratedAt": approved.export.manifest["generatedAt"],
        "sourceExportManifestSha256": approved.export.manifest["sha256"],
        "sourceReviewSha256": approved.review_sha256,
        "splitAlgorithm": "sha256-source-run-prompt-component-v1",
        "splitSeedSha256": sha256_bytes(config.dataset.split_seed.encode("utf-8")),
        "sealed": True,
        "burnAfterAccess": True,
        "file": {
            "fileName": "holdout.jsonl",
            "rowCount": len(holdout_rows),
            "sha256": sha256_bytes(holdout_bytes),
        },
    }
    holdout_manifest = {**holdout_core, "sha256": sha256_bytes(stable_json_bytes(holdout_core))}
    holdout_manifest_bytes = stable_json_bytes(holdout_manifest, pretty=True)

    manifest_core: dict[str, Any] = {
        "schemaVersion": PREPARED_SCHEMA,
        "sourceGeneratedAt": approved.export.manifest["generatedAt"],
        "source": {
            "exportManifestSha256": approved.export.manifest["sha256"],
            "datasetKind": config.dataset.kind,
            "datasetSha256": dataset_entry["sha256"],
            "reviewSha256": approved.review_sha256,
            "reviewedAt": approved.review["reviewedAt"],
            "approvedRowIdsSha256": sha256_bytes(stable_json_bytes(approved_ids)),
        },
        "format": "mlx-lm.completions.v1",
        "split": {
            "algorithm": "sha256-source-run-prompt-component-v1",
            "seedSha256": sha256_bytes(config.dataset.split_seed.encode("utf-8")),
            "evaluationRatio": config.dataset.evaluation_ratio,
            "approvedRows": len(approved.rows),
            "trainingRows": len(training_rows),
            "sealedHoldoutRows": len(holdout_rows),
            "minimumTrainingRows": minimum_training_rows,
            "minimumHoldoutRows": minimum_holdout_rows,
            "holdoutIsSealedFromMlxV1": True,
        },
        "sealedHoldout": {
            "relativeDirectory": f"holdouts/{config.dataset.name}",
            "manifestSha256": holdout_manifest["sha256"],
            "burnAfterAccess": True,
        },
        "datasetConfigSha256": sha256_bytes(stable_json_bytes(dataset_config_core)),
        "files": [
            {"fileName": "train.jsonl", "rowCount": len(training_rows), "sha256": sha256_bytes(train_bytes)},
        ],
    }
    manifest = {**manifest_core, "sha256": sha256_bytes(stable_json_bytes(manifest_core))}
    manifest_bytes = stable_json_bytes(manifest, pretty=True)

    if write:
        validate_artifact_layout(config)
        output = config.dataset_dir
        holdout_output = config.holdout_dir
        ensure_inside(config.artifact_root, output, "prepared dataset directory")
        ensure_inside(config.artifact_root, holdout_output, "sealed holdout directory")
        if output.exists() and (output.is_symlink() or not output.is_dir()):
            raise TrainingLabError("prepared dataset path must be a non-symlink directory")
        if holdout_output.exists() and (holdout_output.is_symlink() or not holdout_output.is_dir()):
            raise TrainingLabError("sealed holdout path must be a non-symlink directory")
        if output.exists():
            unexpected = sorted(path.name for path in output.iterdir() if path.name not in EXPECTED_TRAINING_FILES)
            if unexpected:
                raise TrainingLabError(f"prepared dataset directory contains unexpected files: {unexpected}")
            existing_manifest = output / "prepared-manifest.json"
            if existing_manifest.exists() and existing_manifest.read_bytes() != manifest_bytes:
                raise TrainingLabError("refusing to replace a prepared dataset with different provenance or settings")
        if holdout_output.exists():
            unexpected = sorted(path.name for path in holdout_output.iterdir() if path.name not in EXPECTED_HOLDOUT_FILES)
            if unexpected:
                raise TrainingLabError(f"sealed holdout directory contains unexpected files: {unexpected}")
            existing_manifest = holdout_output / "holdout-manifest.json"
            if existing_manifest.exists() and existing_manifest.read_bytes() != holdout_manifest_bytes:
                raise TrainingLabError("refusing to replace a sealed holdout with different provenance or settings")
        # Seal the holdout in a directory MLX never receives before committing
        # the training manifest that references it.
        write_once_or_verify(holdout_output / "holdout.jsonl", holdout_bytes, config.artifact_root)
        write_once_or_verify(
            holdout_output / "holdout-manifest.json", holdout_manifest_bytes, config.artifact_root
        )
        write_once_or_verify(output / "train.jsonl", train_bytes, config.artifact_root)
        # The manifest is committed last, so its presence means both content-addressed files exist.
        write_once_or_verify(output / "prepared-manifest.json", manifest_bytes, config.artifact_root)
    return manifest


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Validate a reviewed OpenProjects learning export and prepare a deterministic MLX SFT split."
    )
    parser.add_argument("--config", required=True, help="Path to an openprojects.training-lab.v1 JSON config")
    parser.add_argument("--check", action="store_true", help="Validate and print the expected manifest without writing")
    return parser


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        config = load_lab_config(Path(arguments.config))
        manifest = prepare_dataset(config, write=not arguments.check)
        sys.stdout.buffer.write(stable_json_bytes(manifest, pretty=True))
        return 0
    except TrainingLabError as error:
        print(f"training dataset rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
