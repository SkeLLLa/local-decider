/** `/decide <policy> <text>`: argument parsing and the input key each default policy reads. */

export interface DecideArgs {
  readonly policy: string;
  readonly text: string;
}

export const DECIDE_USAGE =
  'Usage: /decide <policy> <text>, e.g. /decide routing add a --json flag';

export function parseDecideArgs(args: string): DecideArgs | null {
  const match = /^([a-z][a-z0-9_-]*)\s+([\s\S]+)$/.exec(args.trim());
  if (match === null) {
    return null;
  }
  const [, policy = '', text = ''] = match;
  return { policy, text: text.trim() };
}

/** Which input section a free-text decision fills, per default policy. */
const TEXT_KEY: Readonly<Record<string, string>> = {
  'turn-outcome': 'lastMessage',
  'permission': 'request',
  'routing': 'prompt',
  'command-risk': 'command',
};

export function manualInput(policy: string, text: string): Record<string, string> {
  return { [TEXT_KEY[policy] ?? 'text']: text };
}
