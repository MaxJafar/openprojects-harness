export type StrictJsonErrorCode = 'INVALID_JSON' | 'DUPLICATE_JSON_KEY' | 'JSON_DEPTH_EXCEEDED';

export class StrictJsonError extends SyntaxError {
  constructor(
    message: string,
    readonly code: StrictJsonErrorCode,
    readonly offset: number,
  ) {
    super(`${message} at offset ${offset}`);
    this.name = 'StrictJsonError';
  }
}

/**
 * Parse JSON while rejecting duplicate object member names before native
 * JSON.parse can silently apply last-key-wins semantics. Member names are
 * compared after decoding JSON escapes, including at every nesting level.
 */
export function parseJsonRejectingDuplicateKeys(source: string): unknown {
  const parser = new StrictJsonParser(source);
  parser.parse();
  return JSON.parse(source) as unknown;
}

const MAX_JSON_DEPTH = 100;

class StrictJsonParser {
  #offset = 0;

  constructor(readonly source: string) {}

  parse(): void {
    this.skipWhitespace();
    this.parseValue(0);
    this.skipWhitespace();
    if (this.#offset !== this.source.length) this.invalid('Unexpected trailing JSON content');
  }

  private parseValue(depth: number): void {
    if (depth > MAX_JSON_DEPTH) {
      throw new StrictJsonError('JSON exceeds maximum depth', 'JSON_DEPTH_EXCEEDED', this.#offset);
    }
    const char = this.source[this.#offset];
    if (char === '{') return this.parseObject(depth);
    if (char === '[') return this.parseArray(depth);
    if (char === '"') {
      this.parseString();
      return;
    }
    if (char === '-' || (char !== undefined && char >= '0' && char <= '9')) return this.parseNumber();
    if (this.source.startsWith('true', this.#offset)) return this.consumeLiteral('true');
    if (this.source.startsWith('false', this.#offset)) return this.consumeLiteral('false');
    if (this.source.startsWith('null', this.#offset)) return this.consumeLiteral('null');
    this.invalid('Expected a JSON value');
  }

  private parseObject(depth: number): void {
    this.#offset += 1;
    this.skipWhitespace();
    if (this.source[this.#offset] === '}') {
      this.#offset += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      if (this.source[this.#offset] !== '"') this.invalid('Expected a JSON object member name');
      const keyOffset = this.#offset;
      const key = this.parseString();
      if (keys.has(key)) {
        throw new StrictJsonError(
          `Duplicate JSON object member ${safeKeyLabel(key)}`,
          'DUPLICATE_JSON_KEY',
          keyOffset,
        );
      }
      keys.add(key);
      this.skipWhitespace();
      if (this.source[this.#offset] !== ':') this.invalid('Expected a colon after JSON object member name');
      this.#offset += 1;
      this.skipWhitespace();
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.source[this.#offset];
      if (separator === '}') {
        this.#offset += 1;
        return;
      }
      if (separator !== ',') this.invalid('Expected a comma or closing brace');
      this.#offset += 1;
      this.skipWhitespace();
    }
  }

  private parseArray(depth: number): void {
    this.#offset += 1;
    this.skipWhitespace();
    if (this.source[this.#offset] === ']') {
      this.#offset += 1;
      return;
    }
    while (true) {
      this.parseValue(depth + 1);
      this.skipWhitespace();
      const separator = this.source[this.#offset];
      if (separator === ']') {
        this.#offset += 1;
        return;
      }
      if (separator !== ',') this.invalid('Expected a comma or closing bracket');
      this.#offset += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.#offset;
    this.#offset += 1;
    while (this.#offset < this.source.length) {
      const code = this.source.charCodeAt(this.#offset);
      if (code === 0x22) {
        this.#offset += 1;
        const token = this.source.slice(start, this.#offset);
        try {
          return JSON.parse(token) as string;
        } catch {
          this.invalid('Invalid JSON string');
        }
      }
      if (code < 0x20) this.invalid('Unescaped control character in JSON string');
      if (code === 0x5c) {
        this.#offset += 1;
        const escape = this.source[this.#offset];
        if (escape === 'u') {
          for (let index = 1; index <= 4; index += 1) {
            const digit = this.source[this.#offset + index];
            if (digit === undefined || !/[0-9a-f]/iu.test(digit)) this.invalid('Invalid Unicode escape');
          }
          this.#offset += 5;
          continue;
        }
        if (escape === undefined || !['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escape)) {
          this.invalid('Invalid JSON escape');
        }
      }
      this.#offset += 1;
    }
    this.invalid('Unterminated JSON string');
  }

  private parseNumber(): void {
    if (this.source[this.#offset] === '-') this.#offset += 1;
    if (this.source[this.#offset] === '0') {
      this.#offset += 1;
      if (isDigit(this.source[this.#offset])) this.invalid('JSON numbers cannot contain a leading zero');
    } else {
      if (!isDigitOneToNine(this.source[this.#offset])) this.invalid('Invalid JSON number');
      while (isDigit(this.source[this.#offset])) this.#offset += 1;
    }
    if (this.source[this.#offset] === '.') {
      this.#offset += 1;
      if (!isDigit(this.source[this.#offset])) this.invalid('JSON number fraction requires a digit');
      while (isDigit(this.source[this.#offset])) this.#offset += 1;
    }
    if (this.source[this.#offset] === 'e' || this.source[this.#offset] === 'E') {
      this.#offset += 1;
      if (this.source[this.#offset] === '+' || this.source[this.#offset] === '-') this.#offset += 1;
      if (!isDigit(this.source[this.#offset])) this.invalid('JSON number exponent requires a digit');
      while (isDigit(this.source[this.#offset])) this.#offset += 1;
    }
  }

  private consumeLiteral(literal: string): void {
    this.#offset += literal.length;
  }

  private skipWhitespace(): void {
    while (true) {
      const char = this.source[this.#offset];
      if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') return;
      this.#offset += 1;
    }
  }

  private invalid(message: string): never {
    throw new StrictJsonError(message, 'INVALID_JSON', this.#offset);
  }
}

function isDigit(value: string | undefined): boolean {
  return value !== undefined && value >= '0' && value <= '9';
}

function isDigitOneToNine(value: string | undefined): boolean {
  return value !== undefined && value >= '1' && value <= '9';
}

function safeKeyLabel(value: string): string {
  const encoded = JSON.stringify(value);
  return encoded.length <= 130 ? encoded : `${encoded.slice(0, 127)}...`;
}
