import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const MAX_LINE_LENGTH = 500;

/** Drop engine output that may contain request state or unusually large payloads. */
export function filterEngineLine(line: string): string | undefined {
  return line.length > MAX_LINE_LENGTH || line.includes('"state"') || line.includes('"questions"')
    ? undefined
    : line;
}

/** Convert arbitrary stdout/stderr chunks into filtered, newline terminated log lines. */
export function createEngineLogFilter(): Transform {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;

  function addSegment(segment: string): void {
    if (dropping) {
      return;
    }
    if (pending.length + segment.length > MAX_LINE_LENGTH) {
      pending = '';
      dropping = true;
      return;
    }
    pending += segment;
  }

  function writeLine(stream: Transform): void {
    const line = dropping ? undefined : filterEngineLine(pending);
    if (line !== undefined) {
      stream.push(`${line}\n`);
    }
    pending = '';
    dropping = false;
  }

  function process(stream: Transform, text: string): void {
    for (const segment of text.split('\n').slice(0, -1)) {
      addSegment(segment);
      writeLine(stream);
    }
    const tail = text.slice(text.lastIndexOf('\n') + 1);
    addSegment(tail);
  }

  return new Transform({
    transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
      process(this, decoder.write(chunk));
      callback();
    },
    flush(callback: TransformCallback) {
      process(this, decoder.end());
      if (pending !== '' || dropping) {
        writeLine(this);
      }
      callback();
    },
  });
}
