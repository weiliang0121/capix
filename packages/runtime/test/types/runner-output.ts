import { Runner, Resources } from '@weiliang0121/capix-runtime';
import { Scene } from '@weiliang0121/capix-structure';
import type { InvocationOutputReceiver } from '@weiliang0121/capix-contracts';

interface Answer {
  readonly text: string;
}
interface Chunk {
  readonly token: string;
}

function isAnswer(value: unknown): value is Answer {
  return typeof value === 'object' && value !== null && 'text' in value && typeof value.text === 'string';
}

function isChunk(value: unknown): value is Chunk {
  return typeof value === 'object' && value !== null && 'token' in value && typeof value.token === 'string';
}

const scene = new Scene<string, Answer, {}, Chunk>({
  output: {
    result(value) {
      if (!isAnswer(value)) throw new TypeError('Expected an answer');
      return value;
    },
    delta(value) {
      if (!isChunk(value)) throw new TypeError('Expected a chunk');
      return value;
    },
  },
  run(work) {
    work.output.emit({ token: work.input });
    return { text: work.input };
  },
});
const runner = new Runner(scene, new Resources()).build();
const unsubscribe: () => void = runner.output.subscribe({
  receive(event) {
    const contextId: string = event.contextId;
    const sequence: number = event.sequence;
    if (event.kind === 'delta') {
      const delta: Chunk = event.delta;
      // @ts-expect-error A chunk is not the final answer.
      const result: Answer = event.delta;
      // @ts-expect-error Subscribers cannot modify an output event.
      event.delta = { token: 'replacement' };
      void [delta, result];
    }
    if (event.kind === 'completed') {
      const result: Answer = event.result;
      const discarded: boolean = event.discarded;
      // @ts-expect-error The final answer is not a chunk.
      const delta: Chunk = event.result;
      void [result, discarded, delta];
    }
    void [contextId, sequence];
    return undefined;
  },
});
unsubscribe();
runner.cancel();
runner.cancel(new Error('Stopped by host'));
const result: Promise<Answer> = runner.run('question');
// @ts-expect-error Subscribing does not widen the Scene input.
runner.run(123);
// @ts-expect-error Host consumers cannot publish output.
runner.output.emit({ token: 'forged' });
// @ts-expect-error Publication is not part of the subscription port.
runner.output.publish({ kind: 'sealed' });
// @ts-expect-error The Runner owns its output port.
runner.output = runner.output;

const incompatible: InvocationOutputReceiver<number, boolean> = { receive: () => undefined };
// @ts-expect-error A receiver cannot change the Scene's result or delta contract.
runner.output.subscribe(incompatible);
const broad: InvocationOutputReceiver<unknown, unknown> = { receive: () => undefined };
runner.output.subscribe(broad);
// @ts-expect-error A broader consumer does not widen the producer's result.
const widenedResult: Promise<number> = runner.run('question');

const plain = new Runner(new Scene<string, string>({ run: (work) => work.input }), new Resources()).build();
plain.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      // No delta declaration means no value can inhabit this producer contract.
      const delta: never = event.delta;
      void delta;
    }
    if (event.kind === 'completed') {
      const value: string = event.result;
      // @ts-expect-error A plain Scene still retains its final result type.
      const wrong: number = event.result;
      void [value, wrong];
    }
    return undefined;
  },
});

void [result, widenedResult];
