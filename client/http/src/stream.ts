import { HttpTransportError } from './errors.js';

/** Chunk boundaries are independent of UTF-8 characters and JSON line boundaries. */
export async function* readLines(stream: ReadableStream<Uint8Array>, maxLineBytes = 16 * 1024 * 1024): AsyncGenerator<string> {
  if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes <= 0) throw new TypeError('流式帧字节预算必须是正安全整数。');
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let fragments: string[] = [];
  let blocks: string[] = [];
  let bytes = 0;
  let ended = false;
  const append = (fragment: string) => {
    if (!fragment) return;
    bytes += encoder.encode(fragment).byteLength;
    if (bytes > maxLineBytes) throw new HttpTransportError('contract', '流式帧超过单行字节预算。', 'FRAME_TOO_LARGE');
    fragments.push(fragment);
    // Compact only newly received fragments; completed blocks are joined once at the line boundary.
    if (fragments.length >= 256) {
      blocks.push(fragments.join(''));
      fragments = [];
    }
  };
  const take = () => {
    if (fragments.length) blocks.push(fragments.join(''));
    const line = blocks.join('');
    fragments = [];
    blocks = [];
    bytes = 0;
    return line;
  };
  try {
    while (!ended) {
      const { done, value } = await reader.read();
      ended = done;
      const chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      let offset = 0;
      let newline: number;
      while ((newline = chunk.indexOf('\n', offset)) >= 0) {
        append(chunk.slice(offset, newline));
        const line = take();
        offset = newline + 1;
        if (line.trim()) yield line;
      }
      if (offset < chunk.length) append(chunk.slice(offset));
    }
    const line = take();
    if (line.trim()) yield line;
  } finally {
    if (!ended) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
