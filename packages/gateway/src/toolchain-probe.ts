import { execFile } from 'node:child_process';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** Drop terminal colour codes from tool output. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Run a tool briefly (fixed argv) and return its trimmed output, or throw. */
export function probe(
  binary: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
  timeoutMs = 15_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      [...args],
      { timeout: timeoutMs, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const text = stripAnsi(`${stdout}
${stderr}`);
        if (error !== null) {
          reject(new Error(text.trim().split('\n').slice(-3).join(' ') || error.message));
          return;
        }
        resolve(text.trim());
      },
    );
  });
}
