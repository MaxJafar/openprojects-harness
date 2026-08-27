# Third-party notices

OpenProjects' original source code and documentation are licensed under the
[MIT License](./LICENSE). That license does not relicense dependencies, model
weights, runtimes, services, or other third-party material. Those components
remain subject to their own terms.

This file describes the reviewed v0.6 source distribution. The lockfiles and
the license files shipped by each upstream package remain authoritative.

## Node.js packages

The npm package does not bundle `node_modules`; installation obtains each
package separately with its own license. The production dependency closure in
the current `package-lock.json` is:

| Package | Version | License |
| --- | ---: | --- |
| `@modelcontextprotocol/client` | 2.0.0 | MIT |
| `@modelcontextprotocol/core` | 2.0.0 | MIT |
| `ajv` | 8.20.0 | MIT |
| `commander` | 14.0.3 | MIT |
| `cross-spawn` | 7.0.6 | MIT |
| `eventsource` | 3.0.7 | MIT |
| `eventsource-parser` | 3.1.1 | MIT |
| `fast-deep-equal` | 3.1.3 | MIT |
| `fast-uri` | 3.1.6 | BSD-3-Clause |
| `isexe` | 2.0.0 | ISC |
| `jose` | 6.2.10 | MIT |
| `json-schema-traverse` | 1.0.0 | MIT |
| `path-key` | 3.1.1 | MIT |
| `pkce-challenge` | 5.0.1 | MIT |
| `require-from-string` | 2.0.2 | MIT |
| `shebang-command` | 2.0.0 | MIT |
| `shebang-regex` | 3.0.0 | MIT |
| `which` | 2.0.2 | ISC |
| `yaml` | 2.9.0 | ISC |
| `zod` | 4.4.3 | MIT |

The reviewed MCP client is the MIT-licensed
`@modelcontextprotocol/client` package. Its locked production closure is
listed above, including `@modelcontextprotocol/core`; none of those packages
relicenses an MCP server, provider service, or content obtained through one.

Development dependencies and their transitive closure are also permissively
licensed in the reviewed lock: MIT, ISC, BSD-3-Clause, and Apache-2.0. Notably,
TypeScript is Apache-2.0; Vitest, tsx, and the Node.js type definitions are MIT.

## Optional local-AI and training components

These components are integrations or separately installed prerequisites. They
are not copied into the Git or npm source distribution:

| Component | Upstream license or terms |
| --- | --- |
| [MLX](https://github.com/ml-explore/mlx), [MLX-LM](https://github.com/ml-explore/mlx-lm), and optional [MLX-VLM](https://github.com/Blaizzy/mlx-vlm) | MIT |
| [Transformers](https://github.com/huggingface/transformers) and [FreeToken](https://github.com/FlashML-org/FreeToken) | Apache-2.0 |
| [Ollama](https://github.com/ollama/ollama), [llama.cpp](https://github.com/ggml-org/llama.cpp), and [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | MIT |
| [FFmpeg](https://ffmpeg.org/legal.html) | Depends on the exact build; commonly LGPL-2.1-or-later, or GPL when GPL components are enabled |
| Telegram Bot API and hosted model providers | Their service terms and privacy policies apply |

An appliance, container, installer, or Python environment that redistributes
any of these components needs its own complete dependency inventory, license
texts, notices, and source-offer analysis. This repository's notice is not a
substitute for that distribution-specific review.

## Model artifacts

No model weight is licensed by the OpenProjects MIT license, and model files
are intentionally excluded from source and npm packages.

- Qwen model artifacts referenced by the examples are distributed under
  Apache-2.0 by their upstream publishers.
- BGE-M3 is distributed under the MIT license by its upstream publisher.
- Whisper code and published model weights are distributed under the MIT
  license by OpenAI.
- Gemma artifacts use separate Gemma terms and require an independent review.
- Quantized or repackaged artifacts can add metadata or terms from their
  publisher; review the exact artifact, revision, and accompanying files.

Operators must retain the upstream license and notice files alongside every
staged model or runtime. A hash or qualification manifest proves identity; it
does not grant a license.

The two embedded qualification images are original, programmatically generated
solid-color PNG fixtures. They contain no third-party artwork or metadata.
The versioned vision-evaluation PNGs are also original deterministic fixtures,
generated from the checked-in script without third-party images, fonts, or
customer data and distributed under the repository's MIT license.

`docs/assets/openprojects-cover.png` is original project artwork generated with
OpenAI's built-in image-generation service on 2026-08-27 from a contributor-authored
prompt, without reference images or customer data. It is distributed with this
repository under MIT. Its embedded provenance/content-credential metadata is
retained where present; it is not a claim of endorsement by OpenAI.

## No endorsement

Third-party names and trademarks identify compatible software, services, or
model artifacts only. No affiliation with or endorsement by their owners is
implied.

## Updating this notice

Any change to a dependency, bundled asset, model recommendation, copied code,
or release format must include a fresh license review. Run
`npm run check:opensource` before release and inspect the generated package
contents rather than publishing a working directory.
