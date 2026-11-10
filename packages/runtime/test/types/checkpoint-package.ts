import { MemoryCheckpointStore } from '@weiliang0121/capix-checkpoint';
import type { CheckpointInstallation, CheckpointFact, CheckpointWriter, CheckpointRestoration } from '@weiliang0121/capix-runtime';
// @ts-expect-error Runtime no longer reexports persistent frame types.
import type { InvocationCheckpointFrame as RuntimeFrame } from '@weiliang0121/capix-runtime';

const installation: CheckpointInstallation = { store: new MemoryCheckpointStore() };
declare const fact: CheckpointFact;
declare const writer: CheckpointWriter;
declare const restoration: CheckpointRestoration;
void [installation, fact, writer, restoration];
