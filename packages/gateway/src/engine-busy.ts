export const ENGINE_BENCHMARK_RUNNING_ERROR = 'engine benchmark running';

export class EngineBusyError extends Error {
  override readonly name = 'EngineBusyError';
}
