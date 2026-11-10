import { MemoryCheckpointStore, type CheckpointStore, type CheckpointImage, type InvocationCheckpointFrame, type CheckpointCodec, type CheckpointSaveReceipt, type CheckpointFinishReceipt } from '@weiliang0121/capix-checkpoint';
import type { InvocationIdentity, CheckpointCodec as CommonCodec } from '@weiliang0121/capix-contracts';
// @ts-expect-error Runtime observations are not part of the persistence package.
import type { CheckpointFact as StoredFact } from '@weiliang0121/capix-checkpoint';
// @ts-expect-error Installation coordinates a live running host.
import type { CheckpointInstallation as StoredInstallation } from '@weiliang0121/capix-checkpoint';
// @ts-expect-error The current activity's writer requires Runtime ownership checks.
import type { CheckpointWriter as StoredWriter } from '@weiliang0121/capix-checkpoint';
// @ts-expect-error Restoration construction belongs to Runtime.
import type { CheckpointRestoration as StoredRestoration } from '@weiliang0121/capix-checkpoint';

const owner: InvocationIdentity = { contextId: 'single-call', kind: 'node' };
const frame: InvocationCheckpointFrame = { owner, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] };
const image: CheckpointImage = { id: 'saved-image', formatVersion: 6, contract: { key: 'typed-host', version: 1 }, point: 'prepared', frame, state: null, references: {} };
const store: CheckpointStore = new MemoryCheckpointStore();
const saved: CheckpointSaveReceipt = store.save(image, 0);
const head = store.read(owner.contextId)!;
const identity: InvocationIdentity = head.image.frame.owner;
const finished: CheckpointFinishReceipt = store.finish(owner.contextId, saved.revision, { status: 'failed' });
// @ts-expect-error Save acknowledgements do not expose restoration snapshots.
saved.image;
// @ts-expect-error Finish acknowledgements do not expose delivery payloads.
finished.delivery;
const codec: CheckpointCodec<string> = { encode: (value) => value, decode: (value) => String(value) };
const commonCodec: CommonCodec<string> = codec;
// @ts-expect-error Persisted identity cannot hold an arbitrary structural kind.
const wrongOwner: InvocationIdentity = { contextId: 'single-call', kind: 'tool' };
// @ts-expect-error A stored checkpoint is not an executable invocation.
saved.run();
// @ts-expect-error Stored frames are immutable values.
head.image.frame.owner = owner;
void [identity, commonCodec, wrongOwner];
