/**
 * Deterministic state shaping. Decision models are bounded to about 4k tokens, so state is built
 * from labelled sections ordered least to most relevant; the budget is spent from the end, and a
 * section that does not fit is cut with an explicit marker.
 */
export type KeepSide = 'head' | 'tail' | 'middle';

export interface StateSection {
  readonly label: string;
  readonly text: string;
  /** Which part survives when the section is cut. Default `tail` (most recent content). */
  readonly keep?: KeepSide;
}

/** About four characters per token for English and code; deliberately conservative. */
export const CHARS_PER_TOKEN = 4;
/** Room left in a 4k-token window for the questions and the model's own template. */
export const DEFAULT_STATE_TOKENS = 3000;
const MIN_SECTION_CHARS = 80;

function marker(dropped: number): string {
  return `…[${String(dropped)} chars truncated]…`;
}

export function cutText(text: string, maxChars: number, keep: KeepSide = 'tail'): string {
  if (text.length <= maxChars) {
    return text;
  }
  const dropped = text.length - maxChars;
  const mark = marker(dropped);
  const room = Math.max(0, maxChars - mark.length);
  if (keep === 'head') {
    return `${text.slice(0, room)}${mark}`;
  }
  if (keep === 'tail') {
    return `${mark}${text.slice(text.length - room)}`;
  }
  const head = Math.ceil(room / 2);
  return `${text.slice(0, head)}${mark}${text.slice(text.length - (room - head))}`;
}

function render(section: StateSection, text: string): string {
  return `## ${section.label}\n${text}`;
}

/** Join sections into one state string under `maxTokens`, keeping the last sections whole. */
export function buildState(
  sections: readonly StateSection[],
  maxTokens: number = DEFAULT_STATE_TOKENS,
): string {
  let budget = maxTokens * CHARS_PER_TOKEN;
  const kept: string[] = [];
  for (let i = sections.length - 1; i >= 0 && budget > 0; i--) {
    const section = sections[i];
    if (section === undefined || section.text.trim() === '') {
      continue;
    }
    const overhead = render(section, '').length + 2;
    const room = budget - overhead;
    if (room < MIN_SECTION_CHARS && section.text.length > room) {
      break;
    }
    const text = cutText(section.text, room, section.keep ?? 'tail');
    kept.unshift(render(section, text));
    budget -= overhead + text.length;
  }
  return kept.join('\n\n');
}
