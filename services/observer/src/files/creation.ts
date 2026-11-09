import type { FileReceipt } from '@weiliang0121/capix-protocol';

export interface FileCreationOperation {
  readonly contextId: string;
  readonly position: string;
}

export interface FileCreationState {
  readonly request: {
    readonly operation: FileCreationOperation;
    readonly root: string;
    readonly path: string;
    readonly bytes: number;
    readonly digest: string;
  };
  /** Missing means delivery is uncertain, never permission to create the file again. */
  readonly receipt?: FileReceipt;
}

export interface FileCreationPersistence {
  read(operation: FileCreationOperation): FileCreationState | undefined;
  create(state: FileCreationState): undefined;
  complete(state: FileCreationState): undefined;
}
