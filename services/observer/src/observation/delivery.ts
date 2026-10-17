/** Source integrity is independent of any one delivery connection. */
export class SourceIncomplete extends Error {
  readonly code = 'SOURCE_INCOMPLETE';
  constructor(
    readonly sourceId: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface SourceBaseline<BaselineValue> {
  readonly sourceId: string;
  readonly revision: number;
  readonly value: BaselineValue;
}
export interface SourceReceiver<Change> {
  change(change: { readonly revision: number; readonly value: Change }): void;
  incomplete(error: SourceIncomplete): void;
  /** The source owner ended its lifetime; this is not evidence of missing facts. */
  closed?(): void;
}
export interface ObservationSource<BaselineValue, Change> {
  /** A consistent baseline handoff; a failed opening leaves no subscription. */
  open(receiver: SourceReceiver<Change>): { readonly baseline: SourceBaseline<BaselineValue>; close(): void };
}
export interface DeliveryConnection {
  readonly closed: boolean;
  close(): void;
}
export interface DeliverySink<Change> extends DeliveryConnection {
  enqueue(change: Change): void;
}
export interface DeliveryOptions<BaselineValue, Change, Frame> {
  baseline(baseline: SourceBaseline<BaselineValue>): Frame;
  delta(changes: readonly Change[]): Frame;
  incomplete(error: SourceIncomplete): Frame;
  error(error: unknown): Frame;
  send(frame: Frame): void;
  /** Supplementary sources keep their own handoff positions; this does not invent a shared revision. */
  attach?(sink: DeliverySink<Change>): (() => void) | void;
  closed?(connection: DeliveryConnection): void;
}

/** Queue-only source callbacks; projection and delivery belong to the consuming connection. */
export function bindDelivery<BaselineValue, Change, Frame>(source: ObservationSource<BaselineValue, Change>, options: DeliveryOptions<BaselineValue, Change, Frame>): DeliveryConnection {
  let closed = false;
  let scheduled = false;
  let incomplete: SourceIncomplete | undefined;
  let pending: Change[] = [];
  let closeSource = () => {};
  let closeAdditional = () => {};
  const connection: DeliverySink<Change> = {
    get closed() {
      return closed;
    },
    close() {
      if (closed) return;
      closed = true;
      pending = [];
      // Closing one connection must release every subscription even when one cleanup fails.
      for (const release of [closeSource, closeAdditional, () => options.closed?.(connection)]) {
        try {
          release();
        } catch {
          /* Cleanup failure is local to this connection. */
        }
      }
    },
    enqueue(change) {
      if (closed || incomplete) return;
      pending.push(change);
      schedule();
    },
  };
  const deliver = (frame: Frame) => {
    if (closed) return;
    try {
      options.send(frame);
    } catch {
      connection.close();
    }
  };
  const terminate = (project: () => Frame) => {
    pending = [];
    try {
      deliver(project());
    } catch {
      /* An unusable control frame can only close this connection. */
    } finally {
      connection.close();
    }
  };
  const fail = () => terminate(() => options.incomplete(incomplete!));
  const flush = () => {
    scheduled = false;
    if (closed) return;
    if (incomplete) {
      fail();
      return;
    }
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    try {
      const frame = options.delta(batch);
      // Projection itself may synchronously reveal a gap. It cannot publish a healthy suffix afterward.
      if (incomplete) fail();
      else deliver(frame);
    } catch (error) {
      if (incomplete) fail();
      else terminate(() => options.error(error));
    }
  };
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = true;
    queueMicrotask(flush);
  };
  try {
    const opened = source.open({
      change: ({ value }) => connection.enqueue(value),
      closed: () => connection.close(),
      incomplete: (error) => {
        if (closed || incomplete) return;
        incomplete = error;
        pending = [];
        schedule();
      },
    });
    closeSource = opened.close;
    if (closed) {
      try {
        closeSource();
      } catch {
        /* A late release follows the same isolation rule as connection.close(). */
      }
    }
    if (!closed && !incomplete) {
      const detach = options.attach?.(connection);
      if (closed) detach?.();
      else if (detach) closeAdditional = detach;
    }
    if (!closed && !incomplete) {
      const frame = options.baseline(opened.baseline);
      if (!closed && !incomplete) deliver(frame);
    }
  } catch (error) {
    connection.close();
    throw error;
  }
  return connection;
}
