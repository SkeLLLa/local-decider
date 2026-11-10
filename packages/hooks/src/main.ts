/**
 * Hook entry point: `node dist/hook.mjs <claude|codex> <Event>`. Reads the hook JSON from stdin,
 * runs it, writes the harness answer to stdout and exits 0. Everything else lives in `run.ts`.
 */
import { run, timeoutOf } from './run.ts';

/** Hook payloads are small; anything larger is not worth parsing inside the time budget. */
const MAX_STDIN_BYTES = 4 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_STDIN_BYTES) {
      return '';
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function finish(stdout: string): void {
  if (stdout === '') {
    process.exit(0);
  }
  process.stdout.write(stdout, () => process.exit(0));
}

async function main(): Promise<void> {
  const env = process.env;
  // Last-resort fail-open: never outlive the gateway budget by much, whatever hangs.
  setTimeout(() => process.exit(0), timeoutOf(env) + 1000).unref();
  const [harness = '', event = ''] = process.argv.slice(2);
  const result = await run(harness, event, await readStdin(), env);
  finish(result.stdout);
}

main().catch(() => process.exit(0));
