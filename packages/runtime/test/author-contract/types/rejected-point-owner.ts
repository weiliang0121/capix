/** Deliberately fails: a standalone point cannot infer its owner from a later use. */
import type { CheckpointCodec } from '@weiliang0121/capix-runtime';
import { checkpointPoint, defineGroup } from '@weiliang0121/capix-runtime';

declare const stringCodec: CheckpointCodec<string>;
declare const numberCodec: CheckpointCodec<number>;

const unowned = checkpointPoint()({
  name: 'unowned',
  state: numberCodec,
  references: {},
  resume: {
    run(work) {
      const input: string = work.input;
      return input;
    },
  },
});

defineGroup<string, string>()({ name: 'later-owner', label: 'Owner', source: 'test', run: (work) => work.input, checkpoint: { key: 'later', version: 1, input: stringCodec, output: stringCodec, points: [unowned] } });
