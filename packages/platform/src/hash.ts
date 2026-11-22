import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeUtf8 } from './bytes.js';

export interface Sha256 {
  update(text: string): Sha256;
  copy(): Sha256;
  digestHex(): string;
}

function cursor(state: ReturnType<typeof sha256.create>): Sha256 {
  let finalized = false;
  return {
    update(text) {
      state.update(encodeUtf8(text));
      return this;
    },
    copy() {
      if (finalized) throw new Error('Cannot copy a finalized SHA-256 digest');
      return cursor(state.clone());
    },
    digestHex() {
      finalized = true;
      return bytesToHex(state.digest());
    },
  };
}

/** A synchronous SHA-256 cursor. Each update encodes its text as a separate UTF-8 chunk. */
export function createSha256(): Sha256 {
  return cursor(sha256.create());
}
