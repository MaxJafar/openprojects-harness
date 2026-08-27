import { createHash } from 'node:crypto';

export const VISION_MEDIA_MAX_BYTES = 3 * 1024 * 1024;
export const VISION_MEDIA_MAX_WIDTH = 4_096;
export const VISION_MEDIA_MAX_HEIGHT = 4_096;
export const VISION_MEDIA_MAX_PIXELS = VISION_MEDIA_MAX_WIDTH * VISION_MEDIA_MAX_HEIGHT;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const PNG_CHUNK_TYPE = /^[A-Za-z]{4}$/u;
const ANIMATED_PNG_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);
const ALLOWED_PNG_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3,
  0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb,
  0xcd, 0xce, 0xcf,
]);

export type VisionMimeType = 'image/png' | 'image/jpeg';

export interface VisionMediaInput {
  readonly mimeType: VisionMimeType;
  /** Canonical padded base64 only. Data URLs and remote URLs are not accepted. */
  readonly base64: string;
}

export interface VisionMediaLimits {
  readonly maxBytes?: number;
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  readonly maxPixels?: number;
}

export interface ResolvedVisionMediaLimits {
  readonly maxBytes: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxPixels: number;
}

export interface VisionMediaProvenance {
  readonly mimeType: VisionMimeType;
  readonly byteLength: number;
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  /** Bare lowercase SHA-256 over the decoded media bytes. */
  readonly sha256: string;
}

export interface ValidatedVisionMedia extends VisionMediaProvenance {
  /** Ephemeral decoded bytes. Callers must not persist these in run/event state. */
  readonly bytes: Uint8Array;
  /** Ephemeral OpenAI-compatible inline image part. Remote image URLs are never produced. */
  readonly dataUrl: string;
}

export class VisionMediaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VisionMediaValidationError';
  }
}

/**
 * Validates exactly one bounded raster image without decoding pixels in the
 * harness process. The separately isolated VLM service remains responsible for
 * media decoding. PNG/APNG and JPEG/MPO structure is inspected only far enough
 * to bind the declared type, dimensions, and single-image posture. PNG
 * ancillary chunks and JPEG metadata/comment segments are rejected instead of
 * forwarded. This is header/container validation, not a full decode: PNG CRCs
 * and compressed pixel streams are intentionally not validated here.
 */
export function validateVisionMedia(
  input: VisionMediaInput,
  limits: VisionMediaLimits = {},
): ValidatedVisionMedia {
  assertPlainRecord(input, 'Vision media input');
  assertExactKeys(input, ['base64', 'mimeType'], 'Vision media input');
  const resolved = resolveVisionMediaLimits(limits);
  const mimeType = visionMimeType(input.mimeType);
  const base64 = canonicalBase64(input.base64, resolved.maxBytes);
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length === 0) throw new VisionMediaValidationError('Vision media must not be empty');
  if (bytes.length > resolved.maxBytes || bytes.length > VISION_MEDIA_MAX_BYTES) {
    throw new VisionMediaValidationError(`Vision media exceeds the ${resolved.maxBytes} byte limit`);
  }
  if (bytes.toString('base64') !== base64) {
    throw new VisionMediaValidationError('Vision media base64 must use one canonical padded encoding');
  }

  const dimensions = mimeType === 'image/png'
    ? inspectPng(bytes)
    : inspectJpeg(bytes);
  assertDimensions(dimensions, resolved);
  const pixels = dimensions.width * dimensions.height;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const media = {
    mimeType,
    byteLength: bytes.length,
    width: dimensions.width,
    height: dimensions.height,
    pixels,
    sha256,
  } as ValidatedVisionMedia;
  Object.defineProperties(media, {
    bytes: {
      value: new Uint8Array(bytes),
      enumerable: false,
      configurable: false,
      writable: false,
    },
    dataUrl: {
      value: `data:${mimeType};base64,${base64}`,
      enumerable: false,
      configurable: false,
      writable: false,
    },
  });
  return Object.freeze(media);
}

export function resolveVisionMediaLimits(
  value: VisionMediaLimits = {},
): ResolvedVisionMediaLimits {
  assertPlainRecord(value, 'Vision media limits');
  assertAllowedKeys(value, ['maxBytes', 'maxHeight', 'maxPixels', 'maxWidth'], 'Vision media limits');
  return Object.freeze({
    maxBytes: boundedInteger(
      value.maxBytes ?? VISION_MEDIA_MAX_BYTES,
      'Vision media maxBytes',
      1,
      VISION_MEDIA_MAX_BYTES,
    ),
    maxWidth: boundedInteger(
      value.maxWidth ?? VISION_MEDIA_MAX_WIDTH,
      'Vision media maxWidth',
      1,
      VISION_MEDIA_MAX_WIDTH,
    ),
    maxHeight: boundedInteger(
      value.maxHeight ?? VISION_MEDIA_MAX_HEIGHT,
      'Vision media maxHeight',
      1,
      VISION_MEDIA_MAX_HEIGHT,
    ),
    maxPixels: boundedInteger(
      value.maxPixels ?? VISION_MEDIA_MAX_PIXELS,
      'Vision media maxPixels',
      1,
      VISION_MEDIA_MAX_PIXELS,
    ),
  });
}

function canonicalBase64(value: unknown, maxBytes: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new VisionMediaValidationError('Vision media base64 must be a non-empty string');
  }
  const maximumEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maximumEncodedLength) {
    throw new VisionMediaValidationError(`Vision media exceeds the ${maxBytes} byte limit`);
  }
  if (value.length % 4 !== 0 || !BASE64.test(value)) {
    throw new VisionMediaValidationError('Vision media base64 must use one canonical padded encoding');
  }
  return value;
}

function visionMimeType(value: unknown): VisionMimeType {
  if (value !== 'image/png' && value !== 'image/jpeg') {
    throw new VisionMediaValidationError('Vision media MIME type must be exactly image/png or image/jpeg');
  }
  return value;
}

function inspectPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 45 || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new VisionMediaValidationError('Vision media MIME type does not match PNG magic bytes');
  }
  let offset = PNG_SIGNATURE.length;
  let dimensions: { width: number; height: number } | undefined;
  let sawImageData = false;
  let sawEnd = false;
  let sawPalette = false;
  let colorType: number | undefined;
  let bitDepth: number | undefined;
  let chunkIndex = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) {
      throw new VisionMediaValidationError('PNG contains a truncated chunk');
    }
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    if (!PNG_CHUNK_TYPE.test(type)) {
      throw new VisionMediaValidationError('PNG contains an invalid chunk type');
    }
    const chunkEnd = offset + 12 + length;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > bytes.length) {
      throw new VisionMediaValidationError('PNG contains an invalid chunk length');
    }
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) {
      throw new VisionMediaValidationError('PNG must begin with one 13-byte IHDR chunk');
    }
    if (ANIMATED_PNG_CHUNKS.has(type)) {
      throw new VisionMediaValidationError('Animated PNG media is not supported');
    }
    if (!ALLOWED_PNG_CHUNKS.has(type)) {
      throw new VisionMediaValidationError('PNG ancillary metadata and unknown chunks are not supported');
    }
    if (type === 'IHDR') {
      if (dimensions || chunkIndex !== 0 || length !== 13) {
        throw new VisionMediaValidationError('PNG must contain exactly one leading IHDR chunk');
      }
      dimensions = {
        width: bytes.readUInt32BE(offset + 8),
        height: bytes.readUInt32BE(offset + 12),
      };
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      assertPngHeader(bitDepth, colorType, bytes.subarray(offset + 18, offset + 21));
    } else if (type === 'PLTE') {
      if (
        sawPalette
        || sawImageData
        || colorType !== 3
        || bitDepth === undefined
        || length < 3
        || length > 3 * (2 ** bitDepth)
        || length % 3 !== 0
      ) {
        throw new VisionMediaValidationError('PNG contains an invalid or non-required palette chunk');
      }
      sawPalette = true;
    } else if (type === 'IDAT') {
      sawImageData = true;
    } else if (type === 'IEND') {
      if (length !== 0 || sawEnd) throw new VisionMediaValidationError('PNG contains an invalid IEND chunk');
      sawEnd = true;
      if (chunkEnd !== bytes.length) {
        throw new VisionMediaValidationError('PNG must contain exactly one image without trailing bytes');
      }
    }
    offset = chunkEnd;
    chunkIndex += 1;
    if (sawEnd) break;
  }
  if (!dimensions || !sawImageData || !sawEnd || (colorType === 3 && !sawPalette)) {
    throw new VisionMediaValidationError('PNG is missing required image structure');
  }
  return dimensions;
}

function assertPngHeader(
  bitDepth: number | undefined,
  colorType: number | undefined,
  methods: Buffer,
): void {
  const allowedDepths = colorType === 0
    ? new Set([1, 2, 4, 8, 16])
    : colorType === 2
      ? new Set([8, 16])
      : colorType === 3
        ? new Set([1, 2, 4, 8])
        : colorType === 4 || colorType === 6
          ? new Set([8, 16])
          : undefined;
  if (
    bitDepth === undefined
    || !allowedDepths?.has(bitDepth)
    || methods.length !== 3
    || methods[0] !== 0
    || methods[1] !== 0
    || (methods[2] !== 0 && methods[2] !== 1)
  ) {
    throw new VisionMediaValidationError('PNG IHDR uses unsupported decoding parameters');
  }
}

function inspectJpeg(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 16 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new VisionMediaValidationError('Vision media MIME type does not match JPEG magic bytes');
  }
  let offset = 2;
  let dimensions: { width: number; height: number } | undefined;
  let sawScan = false;
  let sawEnd = false;
  let sawJfif = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) throw new VisionMediaValidationError('JPEG contains invalid marker framing');
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) throw new VisionMediaValidationError('JPEG ends inside a marker');
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0x00) throw new VisionMediaValidationError('JPEG contains an escaped byte outside scan data');
    if (marker === 0xd8) throw new VisionMediaValidationError('JPEG contains more than one image');
    if (marker === 0xd9) {
      sawEnd = true;
      if (offset !== bytes.length) {
        throw new VisionMediaValidationError('JPEG must contain exactly one image without trailing bytes');
      }
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) throw new VisionMediaValidationError('JPEG contains a truncated segment');
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      throw new VisionMediaValidationError('JPEG contains an invalid segment length');
    }
    const payloadStart = offset + 2;
    const segmentEnd = offset + segmentLength;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (dimensions || segmentLength < 8) {
        throw new VisionMediaValidationError('JPEG must contain exactly one valid frame header');
      }
      dimensions = {
        height: bytes.readUInt16BE(payloadStart + 1),
        width: bytes.readUInt16BE(payloadStart + 3),
      };
    }
    if (marker === 0xe2 && bytes.subarray(payloadStart, payloadStart + 4).toString('ascii') === 'MPF\0') {
      throw new VisionMediaValidationError('Multi-picture JPEG media is not supported');
    }
    if (marker >= 0xe0 && marker <= 0xef) {
      if (marker !== 0xe0 || sawJfif || !isMinimalJfif(bytes, payloadStart, segmentLength)) {
        throw new VisionMediaValidationError('JPEG APP metadata and embedded thumbnails are not supported');
      }
      sawJfif = true;
    }
    if (marker === 0xfe) {
      throw new VisionMediaValidationError('JPEG comment metadata is not supported');
    }
    offset = segmentEnd;
    if (marker === 0xda) {
      sawScan = true;
      offset = scanJpegEntropy(bytes, offset);
    }
  }
  if (!dimensions || !sawScan || !sawEnd) {
    throw new VisionMediaValidationError('JPEG is missing required single-image structure');
  }
  return dimensions;
}

function isMinimalJfif(bytes: Buffer, payloadStart: number, segmentLength: number): boolean {
  if (segmentLength !== 16) return false;
  if (bytes.subarray(payloadStart, payloadStart + 5).toString('ascii') !== 'JFIF\0') return false;
  const majorVersion = bytes[payloadStart + 5];
  const minorVersion = bytes[payloadStart + 6];
  const densityUnits = bytes[payloadStart + 7];
  const horizontalDensity = bytes.readUInt16BE(payloadStart + 8);
  const verticalDensity = bytes.readUInt16BE(payloadStart + 10);
  const thumbnailWidth = bytes[payloadStart + 12];
  const thumbnailHeight = bytes[payloadStart + 13];
  return majorVersion === 1
    && minorVersion !== undefined
    && minorVersion <= 2
    && densityUnits !== undefined
    && densityUnits <= 2
    && horizontalDensity > 0
    && verticalDensity > 0
    && thumbnailWidth === 0
    && thumbnailHeight === 0;
}

function scanJpegEntropy(bytes: Buffer, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    if (offset + 1 >= bytes.length) throw new VisionMediaValidationError('JPEG ends inside scan data');
    const marker = bytes[offset + 1]!;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    return offset;
  }
  throw new VisionMediaValidationError('JPEG scan data has no end marker');
}

function assertDimensions(
  dimensions: { width: number; height: number },
  limits: ResolvedVisionMediaLimits,
): void {
  const { width, height } = dimensions;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new VisionMediaValidationError('Vision media dimensions must be positive integers');
  }
  if (width > limits.maxWidth || height > limits.maxHeight) {
    throw new VisionMediaValidationError(
      `Vision media dimensions ${width}x${height} exceed the ${limits.maxWidth}x${limits.maxHeight} limit`,
    );
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) {
    throw new VisionMediaValidationError(
      `Vision media contains ${pixels} pixels; maximum is ${limits.maxPixels}`,
    );
  }
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new VisionMediaValidationError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return Number(value);
}

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new VisionMediaValidationError(`${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new VisionMediaValidationError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new VisionMediaValidationError(`${label} contains missing or unknown fields`);
  }
}

function assertAllowedKeys(value: object, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unknown) throw new VisionMediaValidationError(`${label} contains unknown field ${unknown}`);
}
