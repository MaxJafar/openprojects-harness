const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const C1_CSI = /\u009b[0-?]*[ -/]*[@-~]/gu;
const ESCAPE_STRING = /\u001b[\]P_^X][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu;
const C1_STRING = /[\u0090\u0098\u009d\u009e\u009f][\s\S]*?(?:\u0007|\u009c|$)/gu;
const SINGLE_ESCAPE = /\u001b[ -/]*[@-~]/gu;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const FORMAT_CHARACTERS = /\p{Cf}/gu;

export const APPROVAL_ARGUMENT_PAGE_SIZE = 160;

/**
 * Converts untrusted model/database content to inert terminal text. Complete
 * OSC/DCS/APC/PM/SOS and CSI sequences are removed before their introducers,
 * preventing dangerous payloads from surviving as misleading visible text.
 */
export function sanitizeTerminalText(value: unknown, maximum = 4_000): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const inert = text
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u2028\u2029]/gu, ' ')
    .replace(ESCAPE_STRING, '')
    .replace(C1_STRING, '')
    .replace(ANSI_CSI, '')
    .replace(C1_CSI, '')
    .replace(SINGLE_ESCAPE, '')
    .replace(CONTROL_CHARACTERS, '')
    .replace(FORMAT_CHARACTERS, '');
  return Array.from(inert).slice(0, Math.max(0, maximum)).join('');
}

export function approvalArgumentPages(value: unknown): string[] {
  // Approval text is never silently shortened: the user must be able to page
  // through the complete stored invocation before a decision is accepted.
  // Unlike ordinary content, unsafe code points are rendered as visible
  // Unicode escapes instead of being discarded, preserving the invocation's
  // complete meaning without allowing it to control the terminal.
  const characters = Array.from(escapeForTerminalInspection(value));
  if (!characters.length) return [''];
  const pages: string[] = [];
  for (let offset = 0; offset < characters.length; offset += APPROVAL_ARGUMENT_PAGE_SIZE) {
    pages.push(characters.slice(offset, offset + APPROVAL_ARGUMENT_PAGE_SIZE).join(''));
  }
  return pages;
}

function escapeForTerminalInspection(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value ?? '');
  let result = '';
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029
      || /\p{Cf}/u.test(character)
    ) {
      result += codePoint <= 0xffff
        ? `\\u${codePoint.toString(16).toUpperCase().padStart(4, '0')}`
        : `\\u{${codePoint.toString(16).toUpperCase()}}`;
    } else {
      result += character;
    }
  }
  return result;
}
