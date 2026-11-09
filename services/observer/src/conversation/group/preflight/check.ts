import { isEqual } from 'es-toolkit/predicate';
import { preflightInputCodec, preflightCodec, emptyCheckpointState, originalCheckpoint, waitingChild, acceptedChild } from '../checkpoint.js';
import { Group, checkpointPoint, childReference, type GroupWork, type ChildCall } from '@weiliang0121/capix-structure';
import { FileResources, type FileInspector } from '../../../files/index.js';
import { InspectFileTask } from '../../node/files/check.js';
import type { FilePreflightInput, FilePreflightOutput } from './types.js';

type PreflightWork = GroupWork<FilePreflightInput, FilePreflightOutput, object>;

export class CheckFileTask extends Group<FilePreflightInput, FilePreflightOutput, { readonly inspector: FileInspector }> {
  readonly inspectFile;

  static readonly deps = Object.freeze({ inspector: FileResources.inspect.request() });
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
      resume: { uses: this.members, run: (work, _state, saved) => this.receive(work, work.children.resume(saved.child)) },
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
      resume: { run: (_work, output) => output },
    });

    this.name = 'checkFileTask';
    this.label = '预检文件任务';
    this.source = 'services/observer/src/conversation/group/preflight/check.ts · CheckFileTask';
    this.checkpoint = { key: 'observer.file-preflight', version: 2, input: preflightInputCodec, output: preflightCodec, points: [this.inspecting, this.result] };
    this.deps = CheckFileTask.deps;
    this.run = this.execute.bind(this);
  }

  private async execute(work: PreflightWork): Promise<FilePreflightOutput> {
    const child = work.children.create(this.inspectFile, work.input.task, { key: 'inspect' });
    work.checkpoint?.({ point: this.inspecting, state: null, refs: { child: child.ref } });
    return this.receive(work, child);
  }
  private async receive(work: PreflightWork, child: ChildCall<InspectFileTask>): Promise<FilePreflightOutput> {
    const output = await child.invoke({ result: { succeeded: (result) => (result.kind === 'ready' ? Object.freeze({ ...result, instruction: work.input.instruction }) : result) } });
    work.checkpoint?.({ point: this.result, state: output, refs: {} });
    return output;
  }
}
