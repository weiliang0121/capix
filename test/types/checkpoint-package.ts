import { MemoryCheckpointStore, type CheckpointStore, type CheckpointImage, type InvocationCheckpointFrame, type CheckpointCodec } from '@capix/checkpoint';
import type { InvocationIdentity, CheckpointCodec as CommonCodec } from '@capix/contracts';
import type { CheckpointInstallation, CheckpointFact, CheckpointWriter, CheckpointRestoration } from '@capix/server-runtime';
// @ts-expect-error Runtime observations are not part of the persistence package.
import type { CheckpointFact as StoredFact } from '@capix/checkpoint';
// @ts-expect-error Installation coordinates a live running host.
import type { CheckpointInstallation as StoredInstallation } from '@capix/checkpoint';
// @ts-expect-error The current activity's writer requires Runtime ownership checks.
import type { CheckpointWriter as StoredWriter } from '@capix/checkpoint';
// @ts-expect-error Restoration construction belongs to Runtime.
import type { CheckpointRestoration as StoredRestoration } from '@capix/checkpoint';
// @ts-expect-error Runtime no longer reexports persistent frame types.
import type { InvocationCheckpointFrame as RuntimeFrame } from '@capix/server-runtime';

const owner: InvocationIdentity = { contextId: 'single-call', kind: 'node' };
const frame: InvocationCheckpointFrame = { owner, round: 1, phase: 'execute', input: null, currentInput: null, nextChildOrder: 0, children: [] };
const image: CheckpointImage = { id: 'saved-image', formatVersion: 5, contract: { key: 'typed-host', version: 1 }, point: 'prepared', frame, state: null, references: {} };
const store: CheckpointStore = new MemoryCheckpointStore();
const installation: CheckpointInstallation = { store };
const saved = store.save(image, 0);
const identity: InvocationIdentity = saved.image.frame.owner;
const codec: CheckpointCodec<string> = { encode: (value) => value, decode: (value) => String(value) };
const commonCodec: CommonCodec<string> = codec;
// @ts-expect-error Persisted identity cannot hold an arbitrary structural kind.
const wrongOwner: InvocationIdentity = { contextId: 'single-call', kind: 'tool' };
// @ts-expect-error A stored checkpoint is not an executable invocation.
saved.run();
// @ts-expect-error Stored frames are immutable values.
saved.image.frame.owner = owner;
declare const fact: CheckpointFact;
declare const writer: CheckpointWriter;
declare const restoration: CheckpointRestoration;
void [installation, identity, commonCodec, wrongOwner, fact, writer, restoration];
