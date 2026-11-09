import type { GenerationOutput, MessageLocator } from '@weiliang0121/capix-protocol';
import type { InvocationOutputEvent, OutputDeclaration } from '@weiliang0121/capix-structure';
import { answerOutputContract } from './output.js';

export interface AnswerTextDelta {
  readonly text: string;
}
export type AnswerGenerationEvent = InvocationOutputEvent<GenerationOutput, AnswerTextDelta>;
export interface AnswerSource {
  readonly contextId: string;
  readonly round: number;
}
export type AnswerProgress = { readonly kind: 'generation'; readonly event: AnswerGenerationEvent } | { readonly kind: 'committed'; readonly source: AnswerSource; readonly message: MessageLocator; readonly content: string };

export const answerStream: OutputDeclaration<GenerationOutput, AnswerTextDelta> = {
  result(value) {
    answerOutputContract.accept(value);
    return value as GenerationOutput;
  },
  delta(value) {
    if (!value || typeof value !== 'object' || !('text' in value) || typeof value.text !== 'string' || !value.text.length) throw new TypeError('Answer delta requires text');
    return value as AnswerTextDelta;
  },
};

/** A narrow provisional decoder for the declared string-valued answer object.
 * Full JSON/schema acceptance remains authoritative. Failure only stops this preview.
 */
export class AnswerTextDecoder {
  private phase: 'open' | 'key' | 'keyString' | 'colon' | 'value' | 'valueString' | 'comma' | 'end' = 'open';
  private key = '';
  private token = '';
  private escape = false;
  private unicode: string | undefined;
  private high = '';
  private readonly keys = new Set<string>();
  private disabled = false;

  push(text: string): string {
    if (this.disabled) return '';
    let output = '';
    try {
      for (const char of text) {
        if (this.phase === 'keyString' || this.phase === 'valueString') {
          let decoded: string | undefined;
          if (this.unicode !== undefined) {
            if (!/^[0-9a-f]$/i.test(char)) throw new Error('Invalid unicode escape');
            this.unicode += char;
            if (this.unicode.length < 4) continue;
            decoded = String.fromCharCode(parseInt(this.unicode, 16));
            this.unicode = undefined;
          } else if (this.escape) {
            this.escape = false;
            if (char === 'u') {
              this.unicode = '';
              continue;
            }
            const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
            decoded = escapes[char];
            if (decoded === undefined) throw new Error('Invalid string escape');
          } else if (char === '\\') {
            this.escape = true;
            continue;
          } else if (char === '"') {
            if (this.high) throw new Error('Unpaired surrogate');
            if (this.phase === 'keyString') {
              this.key = this.token;
              if (this.keys.has(this.key) || (this.key !== 'content' && this.key !== 'kind')) throw new Error('Unexpected or duplicate field');
              this.keys.add(this.key);
              this.phase = 'colon';
            } else this.phase = 'comma';
            this.token = '';
            continue;
          } else {
            if (char.charCodeAt(0) < 32) throw new Error('Unescaped control character');
            decoded = char;
          }
          if (this.phase === 'keyString') this.token += decoded;
          else if (this.key === 'content') {
            const code = decoded.charCodeAt(0);
            if (this.high) {
              if (code < 0xdc00 || code > 0xdfff) throw new Error('Unpaired surrogate');
              output += this.high + decoded;
              this.high = '';
            } else if (decoded.length === 1 && code >= 0xd800 && code <= 0xdbff) this.high = decoded;
            else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Unpaired surrogate');
            else output += decoded;
          }
          continue;
        }
        if (/\s/.test(char)) continue;
        if (this.phase === 'open' && char === '{') this.phase = 'key';
        else if (this.phase === 'key' && char === '"') this.phase = 'keyString';
        else if (this.phase === 'colon' && char === ':') this.phase = 'value';
        else if (this.phase === 'value' && char === '"') this.phase = 'valueString';
        else if (this.phase === 'comma' && char === ',') this.phase = 'key';
        else if (this.phase === 'comma' && char === '}') this.phase = 'end';
        else throw new Error('Unexpected answer JSON');
      }
    } catch {
      this.disabled = true;
    }
    return output;
  }
}
