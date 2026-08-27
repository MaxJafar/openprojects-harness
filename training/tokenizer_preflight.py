from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any


RUNTIME_IDENTITY_SCRIPT = Path(__file__).resolve().with_name("runtime_identity.py")


class DuplicateJsonKey(ValueError):
    pass


def strict_object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise DuplicateJsonKey(key)
        result[key] = value
    return result


def stable_json_bytes(value: Any, pretty: bool = False) -> bytes:
    if pretty:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    else:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return text.encode("utf-8")


def validate_token_lengths(
    tokenizer: Any,
    records: list[dict[str, str]],
    max_sequence_length: int,
    reserved_tokens: int,
    minimum_completion_tokens: int,
) -> dict[str, Any]:
    allowed_full_tokens = max_sequence_length - reserved_tokens
    if allowed_full_tokens <= minimum_completion_tokens:
        raise ValueError("reserved token margin leaves no usable supervised sequence")
    maximum_full = 0
    maximum_prompt = 0
    minimum_completion: int | None = None
    for index, record in enumerate(records, start=1):
        messages = [
            {"role": "user", "content": record["prompt"]},
            {"role": "assistant", "content": record["completion"]},
        ]
        full_tokens = list(tokenizer.apply_chat_template(messages, tools=None, return_dict=False))
        prompt_tokens = list(tokenizer.apply_chat_template(
            messages[:-1],
            add_generation_prompt=True,
            tools=None,
            return_dict=False,
        ))
        full_count = len(full_tokens)
        prompt_count = len(prompt_tokens)
        completion_count = full_count - prompt_count
        if full_count > allowed_full_tokens:
            raise ValueError(f"training row {index} exceeds the exact token limit")
        if prompt_count >= full_count:
            raise ValueError(f"training row {index} leaves no supervised completion tokens")
        if prompt_tokens != full_tokens[:prompt_count]:
            raise ValueError(
                f"training row {index} prompt tokens are not an exact prefix of the full sequence"
            )
        if completion_count < minimum_completion_tokens:
            raise ValueError(f"training row {index} has fewer than {minimum_completion_tokens} completion tokens")
        maximum_full = max(maximum_full, full_count)
        maximum_prompt = max(maximum_prompt, prompt_count)
        minimum_completion = completion_count if minimum_completion is None else min(minimum_completion, completion_count)
    return {
        "rows": len(records),
        "maxSequenceLength": max_sequence_length,
        "reservedTokens": reserved_tokens,
        "allowedFullTokens": allowed_full_tokens,
        "maximumObservedFullTokens": maximum_full,
        "maximumObservedPromptTokens": maximum_prompt,
        "minimumObservedCompletionTokens": minimum_completion or 0,
        "minimumRequiredCompletionTokens": minimum_completion_tokens,
        "truncationAllowed": False,
    }


def read_completion_records(path: Path) -> tuple[bytes, list[dict[str, str]]]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024 * 1024:
        raise ValueError("training JSONL must be a bounded regular file")
    data = path.read_bytes()
    if not data or not data.endswith(b"\n"):
        raise ValueError("training JSONL must be non-empty and newline terminated")
    records: list[dict[str, str]] = []
    for index, line in enumerate(data.splitlines(), start=1):
        try:
            record = json.loads(line.decode("utf-8"), object_pairs_hook=strict_object_pairs)
        except DuplicateJsonKey as error:
            raise ValueError(f"training row {index} contains a duplicate JSON key: {error}") from error
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ValueError(f"training row {index} is not UTF-8 JSON") from error
        if not isinstance(record, dict) or set(record) != {"prompt", "completion"}:
            raise ValueError(f"training row {index} is not an MLX completion record")
        if not isinstance(record["prompt"], str) or not isinstance(record["completion"], str):
            raise ValueError(f"training row {index} prompt/completion must be strings")
        records.append(record)
    return data, records


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Exact local-tokenizer preflight for a prepared MLX training split.")
    parser.add_argument("--model", required=True)
    parser.add_argument("--train-jsonl", required=True)
    parser.add_argument("--max-sequence-length", required=True, type=int)
    parser.add_argument("--reserved-tokens", type=int, default=64)
    parser.add_argument("--minimum-completion-tokens", type=int, default=16)
    parser.add_argument("--expected-runtime-sha256", required=True)
    parser.add_argument("--expected-model-identity-sha256", required=True)
    return parser


def collect_bound_runtime_identity() -> dict[str, Any]:
    spec = importlib.util.spec_from_file_location("_openprojects_runtime_identity", RUNTIME_IDENTITY_SCRIPT)
    if spec is None or spec.loader is None:
        raise ValueError("could not load the trusted runtime identity helper")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    identity = module.collect_runtime_identity()
    if not isinstance(identity, dict):
        raise ValueError("runtime identity helper returned an invalid result")
    return identity


def main(argv: list[str] | None = None) -> int:
    arguments = build_parser().parse_args(argv)
    try:
        model_path = Path(arguments.model).resolve()
        if model_path.is_symlink() or not model_path.is_dir():
            raise ValueError("model must be an existing non-symlink local directory")
        train_data, records = read_completion_records(Path(arguments.train_jsonl).resolve())
        # Import only inside the explicitly invoked preflight. Offline flags are
        # supplied by the parent runner, and the model argument is already local.
        from mlx_lm.utils import load_tokenizer

        tokenizer = load_tokenizer(
            model_path,
            {"local_files_only": True, "trust_remote_code": False},
        )
        stats = validate_token_lengths(
            tokenizer,
            records,
            arguments.max_sequence_length,
            arguments.reserved_tokens,
            arguments.minimum_completion_tokens,
        )
        runtime_identity = collect_bound_runtime_identity()
        if runtime_identity.get("sha256") != arguments.expected_runtime_sha256:
            raise ValueError("runtime identity changed between provenance check and tokenizer preflight")
        core = {
            "schemaVersion": "openprojects.tokenizer-preflight.v1",
            "trainJsonlSha256": hashlib.sha256(train_data).hexdigest(),
            "chatTemplateApplied": True,
            "promptMaskOffsetChecked": True,
            "promptPrefixExactChecked": True,
            "modelIdentitySha256": arguments.expected_model_identity_sha256,
            "runtimeIdentity": runtime_identity,
            **stats,
        }
        result = {**core, "sha256": hashlib.sha256(stable_json_bytes(core)).hexdigest()}
        sys.stdout.buffer.write(stable_json_bytes(result, pretty=True))
        return 0
    except (ImportError, OSError, ValueError) as error:
        print(f"tokenizer preflight rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
