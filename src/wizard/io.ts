import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';

import { sanitizeTerminalText } from '../tui/sanitize.js';
import type {
  ConfirmPrompt,
  InputPrompt,
  SelectPrompt,
  WizardIO,
} from './types.js';

export interface ReadlineWizardIO extends WizardIO {
  close(): void;
}

export interface ReadlineWizardIOOptions {
  input?: Readable;
  output?: Writable;
  environment?: NodeJS.ProcessEnv;
}

/**
 * Readline installer renderer. Interactive color is decorative only; NO_COLOR,
 * TERM=dumb, and non-TTY streams receive the same line-oriented prompts with
 * no ANSI sequences or cursor-control protocol.
 */
export function createReadlineWizardIO(options: ReadlineWizardIOOptions = {}): ReadlineWizardIO {
  const input = options.input ?? stdin;
  const output = options.output ?? stdout;
  const interactiveTerminal = streamIsTty(input) && streamIsTty(output);
  const environment = options.environment ?? process.env;
  const styled = interactiveTerminal && environment.NO_COLOR === undefined && environment.TERM !== 'dumb';
  const readline = createInterface({ input, output, terminal: interactiveTerminal });
  const color = (value: string, code: string, bold = false): string => {
    const inert = sanitizeTerminalText(value, 20_000).replace(/[\n\t]+/gu, ' ');
    return styled ? `\u001b[${bold ? '1;' : ''}${code}m${inert}\u001b[0m` : inert;
  };
  const promptMark = styled ? color('◇', '38;2;91;192;235', true) : '>';
  return {
    async select(prompt: SelectPrompt): Promise<string> {
      writeLine(output, `\n${promptMark} ${color(prompt.message, '38;2;226;232;236', true)}`);
      prompt.choices.forEach((choice, index) => {
        const marker = choice.recommended
          ? ` ${color('[recommended]', '38;2;92;211;123', true)}`
          : '';
        writeLine(
          output,
          `  ${color(String(index + 1).padStart(2), '38;2;45;212;191', true)}  ${color(choice.label, '38;2;226;232;236', true)}${marker}`,
        );
        writeLine(output, `      ${color(choice.description, '38;2;128;148;160')}`);
      });
      const answer = (
        await readline.question(`${color('  Choose', '38;2;91;192;235', true)} [${prompt.defaultValue}]: `)
      ).trim();
      if (!answer) return prompt.defaultValue;
      const index = Number(answer);
      if (Number.isInteger(index) && index >= 1 && index <= prompt.choices.length) {
        return prompt.choices[index - 1]!.value;
      }
      return answer;
    },
    async input(prompt: InputPrompt): Promise<string> {
      writeLine(output, `\n${promptMark} ${color(prompt.message, '38;2;226;232;236', true)}`);
      if (prompt.hint) writeLine(output, `  ${color(prompt.hint, '38;2;128;148;160')}`);
      const visibleDefault = prompt.defaultValue === undefined
        ? undefined
        : sanitizeTerminalText(prompt.defaultValue, 20_000).replace(/[\n\t]+/gu, ' ');
      const suffix = visibleDefault === undefined ? ': ' : ` [${visibleDefault}]: `;
      const answer = (await readline.question(`${color('  Value', '38;2;91;192;235', true)}${suffix}`)).trim();
      return answer || prompt.defaultValue || '';
    },
    async confirm(prompt: ConfirmPrompt): Promise<boolean> {
      writeLine(output, `\n${color('◆', '38;2;245;178;66', true)} ${color(prompt.message, '38;2;226;232;236', true)}`);
      const marker = prompt.defaultValue ? 'Y/n' : 'y/N';
      const answer = (await readline.question(`${color('  Confirm', '38;2;245;178;66', true)} [${marker}]: `)).trim().toLowerCase();
      if (!answer) return prompt.defaultValue;
      if (answer === 'y' || answer === 'yes') return true;
      if (answer === 'n' || answer === 'no') return false;
      return false;
    },
    write(message: string): void {
      if (message === 'OpenProjects private installation wizard') {
        writeLine(output, '');
        writeLine(output, color('◆  OPENPROJECTS  /  PRIVATE SETUP', '38;2;45;212;191', true));
        writeLine(output, color('   Local intelligence. Customer-controlled data.', '38;2;128;148;160'));
        writeLine(output, color('────────────────────────────────────────────────', '38;2;45;68;78'));
        return;
      }
      const tone = message.startsWith('Warning:')
        ? '38;2;245;178;66'
        : message.startsWith('Next ') || message.startsWith('Configuration written')
          ? '38;2;92;211;123'
          : message.startsWith('Recommended local model:')
            ? '38;2;45;212;191'
            : '38;2;128;148;160';
      const bold = message.startsWith('Warning:') || message.startsWith('Next ');
      writeLine(output, color(message, tone, bold));
    },
    close(): void {
      readline.close();
    },
  };
}

function writeLine(output: Writable, message: string): void {
  output.write(`${message}\n`);
}

function streamIsTty(stream: Readable | Writable): boolean {
  return (stream as Readable & { isTTY?: boolean }).isTTY === true;
}
