import { createMaterialConversationScene } from '@capix/conversation-service/assembly';
import { createConversationRecording } from '@capix/conversation-service/recording';
import { RecordBook, Recorder } from '@weiliang0121/capix-records';
import { Node, Scene, Group } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import type { RecordingInstallation } from '@weiliang0121/capix-runtime/recording';

const scene = createMaterialConversationScene();
const recorder = new Recorder(new RecordBook());
const installation: RecordingInstallation = createConversationRecording(scene, recorder, { failure: 'isolate', invalidate: (_error: unknown) => {} });
const runner = new Runner(scene, new Resources(), undefined, { observations: [installation] });
const result: Promise<string> = runner.run('question');
runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') {
      const text: string = event.delta;
      void text;
    }
  },
});
// @ts-expect-error Recording does not widen the Scene input.
runner.run({ question: 'question' });
// @ts-expect-error The installation must receive the formal Recorder entity.
createConversationRecording(scene, new RecordBook());
// @ts-expect-error The helper describes a whole conversation Scene, not a detached Node.
createConversationRecording(new Node(), recorder);
// @ts-expect-error A Group is not the Scene entrypoint.
createConversationRecording(new Group(), recorder);
// @ts-expect-error Existing recording failure policies remain explicit.
createConversationRecording(scene, recorder, { failure: 'ignore' });

// Custom members may keep unrelated I/O; recording does not rewrite their author contract.
const custom = new Scene(new Node<number, { value: number }>({ run: (work) => ({ value: work.input }) }));
const customInstallation: RecordingInstallation = createConversationRecording(custom, recorder);
const customRunner = new Runner(custom, new Resources(), undefined, { observations: [customInstallation] });
const customResult: Promise<{ value: number }> = customRunner.run(42);
void [result, customResult];
