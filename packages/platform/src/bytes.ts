import { base64 } from '@scure/base';

/** Measure UTF-8 without allocating the encoded payload, including for over-budget inputs. */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit < 0x80) bytes++;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

/** Encode isolated UTF-16 surrogates as the Unicode replacement character on every host. */
export function encodeUtf8(value: string): Uint8Array {
  if (typeof TextEncoder === 'function') return new TextEncoder().encode(value);
  const output = new Uint8Array(utf8ByteLength(value));
  let offset = 0;
  for (let index = 0; index < value.length; index++) {
    let code = value.codePointAt(index)!;
    if (code > 0xffff) index++;
    else if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd;
    if (code < 0x80) output[offset++] = code;
    else if (code < 0x800) {
      output[offset++] = 0xc0 | (code >> 6);
      output[offset++] = 0x80 | (code & 63);
    } else if (code < 0x10000) {
      output[offset++] = 0xe0 | (code >> 12);
      output[offset++] = 0x80 | ((code >> 6) & 63);
      output[offset++] = 0x80 | (code & 63);
    } else {
      output[offset++] = 0xf0 | (code >> 18);
      output[offset++] = 0x80 | ((code >> 12) & 63);
      output[offset++] = 0x80 | ((code >> 6) & 63);
      output[offset++] = 0x80 | (code & 63);
    }
  }
  return output;
}

/** Accept canonical RFC 4648 Base64 with padding. */
export function decodeBase64(value: string): Uint8Array {
  // The codec's JS fallback expands each input character into intermediate arrays.
  // Keep those allocations bounded even for images near the 64 MiB request limit.
  const block = 16384;
  if (value.length <= block) return base64.decode(value);
  if (value.length % 4 !== 0) throw new TypeError('Invalid Base64 length');
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const result = new Uint8Array((value.length / 4) * 3 - padding);
  for (let offset = 0; offset < value.length; offset += block) {
    const chunk = value.slice(offset, offset + block);
    if (offset + block < value.length && chunk.endsWith('=')) throw new TypeError('Unexpected Base64 padding');
    result.set(base64.decode(chunk), (offset / 4) * 3);
  }
  return result;
}
