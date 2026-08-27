import { arch, cpus, platform, totalmem } from 'node:os';

import type {
  HardwareAcceleration,
  HardwareInfo,
  ModelRecommendation,
} from './types.js';

const GIBIBYTE = 1024 ** 3;
export const CORE_4G_MAX_MEMORY_GIB = 4.5;

export interface HardwareProbe {
  platform(): NodeJS.Platform;
  architecture(): string;
  logicalCpus(): readonly { model: string }[];
  totalMemoryBytes(): number;
}

const nodeHardwareProbe: HardwareProbe = {
  platform,
  architecture: arch,
  logicalCpus: cpus,
  totalMemoryBytes: totalmem,
};

/** Detects only information Node can read without commands or elevated access. */
export function detectHardware(probe: HardwareProbe = nodeHardwareProbe): HardwareInfo {
  const detectedPlatform = probe.platform();
  const architecture = probe.architecture();
  const detectedCpus = probe.logicalCpus();
  const memoryBytes = probe.totalMemoryBytes();
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) {
    throw new Error('Hardware probe returned an invalid memory size');
  }
  return {
    platform: detectedPlatform,
    architecture,
    logicalCpuCount: detectedCpus.length,
    cpuModel: detectedCpus[0]?.model.trim() || 'Unknown CPU',
    memoryBytes,
    memoryGiB: roundToTenth(memoryBytes / GIBIBYTE),
    acceleration: accelerationFor(detectedPlatform, architecture),
  };
}

/** Conservative Q4 recommendations leave memory for the OS, model server, and harness. */
export function recommendLocalModel(hardware: HardwareInfo): ModelRecommendation {
  const memoryGiB = hardware.memoryGiB;
  if (memoryGiB < 10) {
    return recommendation(
      'qwen3.5:2b',
      '2B Q4',
      6,
      8_192,
      'Sized for an 8 GB development machine; use cloud-free narrow tasks and short context.',
    );
  }
  if (memoryGiB < 20) {
    return recommendation(
      'qwen3.5:4b',
      '4B Q4',
      10,
      16_384,
      'A practical small local agent model while reserving memory for the harness.',
    );
  }
  if (memoryGiB < 72) {
    return recommendation(
      'qwen3.5:9b',
      '9B Q4',
      20,
      32_768,
      'Balanced for a 24–64 GB corporate workstation with generous operating headroom.',
    );
  }
  return recommendation(
    'qwen3.5:27b',
    '27B Q4',
    64,
    32_768,
    'Intended for a high-memory workstation or reviewed inference server.',
  );
}

/**
 * Conservative text/tool model recommendations for the official MLX-LM
 * runtime. These are not vision recommendations and are intentionally small
 * enough to leave unified memory for macOS, KV cache, and OpenProjects.
 */
export function recommendMlxModel(hardware: HardwareInfo): ModelRecommendation {
  if (hardware.acceleration !== 'apple-silicon') {
    throw new Error('The OpenProjects MLX-LM profile requires macOS on Apple Silicon');
  }
  if (hardware.memoryGiB < 14) {
    return recommendation(
      'mlx-community/Qwen3-1.7B-4bit',
      '1.7B MLX 4-bit',
      6,
      8_192,
      'Fits an 8 GB Mac with a modest KV cache; tool calling must pass the exact deployment probe.',
    );
  }
  return recommendation(
    'mlx-community/Qwen3-4B-Instruct-2507-4bit',
    '4B MLX 4-bit',
    12,
    hardware.memoryGiB < 24 ? 16_384 : 32_768,
    'The model used by the official MLX-LM tool-use example; keep one decode worker until qualified.',
  );
}

export function formatMemoryGiB(hardware: HardwareInfo): string {
  return `${hardware.memoryGiB.toFixed(1)} GiB`;
}

/** Selects the bounded harness profile; model-runtime eligibility is assessed separately. */
export function usesCore4gProfile(hardware: HardwareInfo): boolean {
  return hardware.memoryGiB <= CORE_4G_MAX_MEMORY_GIB;
}

export function modelFitsHardware(
  recommendation: ModelRecommendation,
  hardware: HardwareInfo,
): boolean {
  return recommendation.minimumMemoryGiB <= hardware.memoryGiB;
}

function accelerationFor(
  detectedPlatform: NodeJS.Platform,
  architecture: string,
): HardwareAcceleration {
  if (detectedPlatform === 'darwin' && architecture === 'arm64') return 'apple-silicon';
  if (architecture === 'x64' || architecture === 'arm64') return 'cpu';
  return 'unknown';
}

function recommendation(
  model: string,
  parameterClass: string,
  minimumMemoryGiB: number,
  contextWindow: number,
  rationale: string,
): ModelRecommendation {
  return { model, parameterClass, minimumMemoryGiB, contextWindow, rationale };
}

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
