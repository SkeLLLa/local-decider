import { parentPort, workerData } from 'node:worker_threads';

import { openLogStore } from './sqlite-log.ts';
import { runStats, type StatsJob } from './stats-job.ts';

/** Worker entry: reads through its own read-only handle, so the gateway's event loop stays free. */
function reply(message: { ok: boolean; result?: unknown; error?: string }): void {
  // worker_threads MessagePort: no targetOrigin argument exists.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  parentPort?.postMessage(message);
}

function main(): void {
  const job = workerData as StatsJob & { readonly paths: Parameters<typeof openLogStore>[0] };
  let log: ReturnType<typeof openLogStore> | undefined;
  try {
    log = openLogStore(job.paths, { readOnly: true });
    reply({ ok: true, result: runStats(log, job) });
  } catch (error) {
    reply({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    log?.close();
  }
}

main();
