import { isEqual } from 'es-toolkit';
import type { AnswerPreviewSnapshot, AnswerPreviewChange, MessageLocator, TranscriptRangeLocator } from '@weiliang0121/capix-protocol';

export interface AnswerPreviewState {
  readonly snapshot?: AnswerPreviewSnapshot;
  readonly status: 'live' | 'interrupted' | 'failed';
  readonly error?: unknown;
}

class PreviewGap extends Error {
  constructor(
    message: string,
    readonly generation: number,
    readonly revision: number,
  ) {
    super(message);
  }
}
const maximumTextLength = 2_000_000;

/** A submission-local candidate replica. Preview failures never invalidate formal service facts. */
export class AnswerPreviewReceiver {
  private state?: AnswerPreviewState;

  get snapshot(): AnswerPreviewState | undefined {
    return this.state;
  }

  associate(input: TranscriptRangeLocator | undefined, answer: MessageLocator | undefined, finalized = false): void {
    const message = this.state?.snapshot?.message;
    if (!message || this.state?.status === 'failed') return;
    // Preview and formal facts can share a publication batch; their frames arrive separately.
    if (!input && !finalized) return;
    if (!input || (finalized && !answer)) {
      this.state = Object.freeze({ ...this.state, status: 'failed', error: new Error('已结束提交缺少回答预览对应的正式输入或回答位置。') });
      return;
    }
    if (message.transcriptId !== input.transcriptId || message.index < input.end || (answer && !isEqual(message, answer))) this.state = Object.freeze({ ...this.state, status: 'failed', error: new Error('回答预览接纳位置与正式提交不一致。') });
  }

  baseline(next: AnswerPreviewSnapshot | undefined): void {
    if (this.state?.status === 'failed') return;
    // A concurrent query may have captured its baseline before preview started.
    if (next === undefined && this.state) return;
    this.accept(() => {
      const previous = this.state?.snapshot;
      if (next === undefined) return undefined;
      validateSnapshot(next);
      if (previous) {
        if (next.generation < previous.generation || (next.generation === previous.generation && next.revision < previous.revision)) return previous;
        if (next.generation === previous.generation) {
          if (next.revision === previous.revision) {
            if (!isEqual(next, previous)) throw new Error('相同预览修订包含不同内容。');
            return previous;
          }
          if (!next.text.startsWith(previous.text) || (previous.state !== 'streaming' && next.text !== previous.text) || !canAdvance(previous.state, next.state)) throw new Error('回答预览的已接纳内容发生回退。');
          if (previous.state === 'committed' || previous.state === 'discarded') {
            if (!isEqual(next, previous)) throw new Error('已结束的回答预览不能改写。');
          }
        } else if (previous.state === 'committed') throw new Error('正式回答接纳后不能创建新的预览候选。');
      }
      return copySnapshot(next);
    });
  }

  receive(change: AnswerPreviewChange): void {
    if (this.state?.status === 'failed' || this.state?.status === 'interrupted') return;
    this.accept(() => {
      validateChange(change);
      const previous = this.state?.snapshot;
      if (previous && change.generation < previous.generation) return previous;
      if (change.kind === 'started') {
        if (previous && change.generation === previous.generation) return previous;
        if (previous && previous.state !== 'discarded') throw new Error('前一回答候选未结束，不能启动新的预览。');
        if (change.revision !== 1 || change.generation !== (previous?.generation ?? 0) + 1) throw new PreviewGap('回答预览缺少生成基线。', change.generation, change.revision);
        return Object.freeze({ generation: change.generation, revision: 1, text: '', state: 'streaming' as const });
      }
      if (!previous || change.generation !== previous.generation) throw new PreviewGap('回答预览缺少生成基线。', change.generation, change.revision);
      if (change.revision <= previous.revision) {
        if (change.kind === 'appended') {
          if (change.offset + change.text.length > previous.text.length || previous.text.slice(change.offset, change.offset + change.text.length) !== change.text) throw new Error('重复预览片段与已接纳正文冲突。');
        } else if (change.kind === 'committed' && (previous.state !== 'committed' || !isEqual(previous.message, change.message) || previous.consistency !== change.consistency)) throw new Error('重复预览接纳事实冲突。');
        else if (change.kind === 'discarded' && (previous.state !== 'discarded' || previous.reason !== change.reason)) throw new Error('重复预览结束事实冲突。');
        else if (change.kind === 'received' && previous.state === 'streaming') throw new Error('重复预览完成事实冲突。');
        return previous;
      }
      if (change.revision !== previous.revision + 1) throw new PreviewGap('回答预览修订不连续。', change.generation, change.revision);
      if (previous.state === 'committed' || previous.state === 'discarded') throw new Error('已结束的回答预览不能继续变化。');
      if (change.kind === 'appended') {
        if (previous.state !== 'streaming') throw new Error('模型返回之后不能追加预览。');
        if (change.offset > previous.text.length) throw new PreviewGap('回答预览正文存在缺口。', change.generation, change.revision);
        if (change.offset !== previous.text.length) throw new Error('新的预览片段覆盖了已接纳正文。');
        if (previous.text.length + change.text.length > maximumTextLength) throw new Error('回答预览超过接收上限。');
        return Object.freeze({ ...previous, revision: change.revision, text: previous.text + change.text });
      }
      if (change.kind === 'received') {
        if (previous.state !== 'streaming') throw new Error('回答预览不能重复结束接收。');
        return Object.freeze({ ...previous, revision: change.revision, state: 'received' as const });
      }
      if (change.kind === 'committed') {
        if (previous.state !== 'received') throw new Error('回答预览接收结束后才能正式接纳。');
        return Object.freeze({ ...previous, revision: change.revision, state: 'committed' as const, message: Object.freeze({ ...change.message }), consistency: change.consistency });
      }
      return Object.freeze({ ...previous, revision: change.revision, state: 'discarded' as const, reason: change.reason });
    });
  }

  private accept(read: () => AnswerPreviewSnapshot | undefined): void {
    try {
      const snapshot = read();
      const gap = this.state?.error;
      if (snapshot && this.state?.status === 'interrupted' && gap instanceof PreviewGap && (snapshot.generation < gap.generation || (snapshot.generation === gap.generation && snapshot.revision < gap.revision))) {
        if (snapshot !== this.state.snapshot) this.state = Object.freeze({ ...this.state, snapshot });
        return;
      }
      if (snapshot === this.state?.snapshot && this.state?.status === 'live') return;
      this.state = snapshot ? Object.freeze({ status: 'live', snapshot }) : undefined;
    } catch (error) {
      this.state = Object.freeze({ ...this.state, status: error instanceof PreviewGap ? 'interrupted' : 'failed', error });
    }
  }
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validateChange(value: AnswerPreviewChange): void {
  if (!value || !positive(value.generation) || !positive(value.revision) || !['started', 'appended', 'received', 'committed', 'discarded'].includes(value.kind)) throw new Error('回答预览变化无效。');
  if (value.kind === 'started' && value.revision !== 1) throw new Error('回答预览开始修订必须为 1。');
  if (value.kind === 'appended' && (!Number.isSafeInteger(value.offset) || value.offset < 0 || typeof value.text !== 'string' || !value.text.length || value.text.length > maximumTextLength)) throw new Error('回答预览片段无效。');
  if (value.kind === 'committed' && (!value.message || typeof value.message.transcriptId !== 'string' || !value.message.transcriptId || !Number.isSafeInteger(value.message.index) || value.message.index < 0 || !['complete', 'prefix', 'mismatch'].includes(value.consistency))) throw new Error('回答预览接纳位置无效。');
  if (value.kind === 'discarded' && !['rejected', 'failed', 'cancelled'].includes(value.reason)) throw new Error('回答预览结束原因无效。');
}

function validateSnapshot(value: AnswerPreviewSnapshot): void {
  if (!value || !positive(value.generation) || !positive(value.revision) || typeof value.text !== 'string' || value.text.length > maximumTextLength || !['streaming', 'received', 'committed', 'discarded'].includes(value.state)) throw new Error('回答预览基线无效。');
  if (value.state === 'committed') validateChange({ ...value, kind: 'committed', message: value.message!, consistency: value.consistency! });
  else if (value.message !== undefined || value.consistency !== undefined) throw new Error('未接纳预览不能带正式消息位置。');
  if (value.state === 'discarded') validateChange({ ...value, kind: 'discarded', reason: value.reason! });
  else if (value.reason !== undefined) throw new Error('未丢弃预览不能带结束原因。');
}

function canAdvance(before: AnswerPreviewSnapshot['state'], after: AnswerPreviewSnapshot['state']): boolean {
  return before === after || before === 'streaming' || (before === 'received' && (after === 'committed' || after === 'discarded'));
}

function copySnapshot(value: AnswerPreviewSnapshot): AnswerPreviewSnapshot {
  return Object.freeze({ generation: value.generation, revision: value.revision, text: value.text, state: value.state, ...(value.message ? { message: Object.freeze({ ...value.message }) } : {}), ...(value.consistency ? { consistency: value.consistency } : {}), ...(value.reason ? { reason: value.reason } : {}) });
}
