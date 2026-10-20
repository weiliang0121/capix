import { isEqual } from 'es-toolkit/predicate';
import { preflightInputCodec, preflightCodec, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { Group, checkpointPoint, childReference, type GroupWork, type ChildCall } from '@capix/server-runtime';
import { invocationRecording } from '@capix/server-runtime/recording';
import { FileResources, type FileInspector } from '../../../files/index.js';
import { InspectFileTask } from '../../node/files/check.js';
import type { FilePreflightInput, FilePreflightOutput } from './types.js';

type PreflightWork = GroupWork<FilePreflightInput, FilePreflightOutput, object>;

export class CheckFileTask extends Group<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }> {
  readonly inspectFile;

  static readonly requires = Object.freeze({ inspector: FileResources.inspect.request() });
  readonly inspecting;
  readonly result;

  constructor() {
    super();

    this.inspectFile = new InspectFileTask();
    this.add(this.inspectFile);
    this.inspecting = checkpointPoint<'group', FilePreflightInput, FilePreflightOutput>()({
      name: 'inspecting',
      state: emptyCheckpointState,
      references: { child: childReference(this.inspectFile) },
      check: (_state, facts) => {
        originalCheckpoint(facts);
        const child = waitingChild(facts, facts.references.child, 'inspect');
        if (facts.children.values().length !== 1 || !isEqual(child.input, facts.input.task)) throw new Error('Preflight checkpoint changed task');
      },
      resume: { uses: this.members, execute: (work, _state, saved) => this.receive(work, work.children.resume(saved.child)) },
    });
    this.result = checkpointPoint<'group', FilePreflightInput, FilePreflightOutput>()({
      name: 'result',
      state: preflightCodec,
      references: {},
      check: (output, facts) => {
        originalCheckpoint(facts);
        const child = acceptedChild(facts.children.requireUnique(this.inspectFile, { parentRound: 1 }));
        if (facts.children.values().length !== 1 || child.key !== 'inspect' || !isEqual(child.reception.value, output)) throw new Error('Preflight checkpoint differs from accepted inspection');
      },
      resume: { execute: (_work, output) => output },
    });

    this.setDefinition({ name: 'checkFileTask', label: '预检文件任务', source: 'services/observer/src/conversation/group/preflight/check.ts · CheckFileTask', observation: [invocationRecording()], checkpoint: { key: 'observer.file-preflight', version: 2, input: preflightInputCodec, output: preflightCodec, points: [this.inspecting, this.result] }, run: { requires: CheckFileTask.requires, uses: this.members, execute: this.execute.bind(this) } });
  }

  private async execute(work: PreflightWork): Promise<FilePreflightOutput> {
    const child = work.children.create(this.inspectFile, work.input.task, { key: 'inspect' });
    work.checkpoint?.save(this.inspecting, null, { child: child.ref });
    return this.receive(work, child);
  }
  private async receive(work: PreflightWork, child: ChildCall<InspectFileTask>): Promise<FilePreflightOutput> {
    await child.run();
    const output = await child.accept((result) => (result.kind === 'ready' ? Object.freeze({ ...result, instruction: work.input.instruction }) : result));
    work.checkpoint?.save(this.result, output, {});
    return output;
  }
}
