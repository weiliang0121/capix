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

export interface SourceBaseline<S> {
  readonly sourceId: string;
  readonly revision: number;
  readonly value: S;
}
export interface SourceReceiver<D> {
  change(change: { readonly revision: number; readonly value: D }): void;
  incomplete(error: SourceIncomplete): void;
}
export interface ObservationSource<S, D> {
  /** A consistent baseline handoff; a failed opening leaves no subscription. */
  open(receiver: SourceReceiver<D>): { readonly baseline: SourceBaseline<S>; close(): void };
}
export interface DeliveryConnection {
  readonly closed: boolean;
  close(): void;
}
export interface DeliverySink<D> extends DeliveryConnection {
  enqueue(change: D): void;
}
export interface DeliveryOptions<S, D, F> {
  baseline(baseline: SourceBaseline<S>): F;
  delta(changes: readonly D[]): F;
  incomplete(error: SourceIncomplete): F;
  error(error: unknown): F;
  send(frame: F): void;
  /** Supplementary sources keep their own handoff positions; this does not invent a shared revision. */
  attach?(sink: DeliverySink<D>): (() => void) | void;
  closed?(connection: DeliveryConnection): void;
}

/** Queue-only source callbacks; projection and delivery belong to the consuming connection. */
export function bindDelivery<S, D, F>(source: ObservationSource<S, D>, options: DeliveryOptions<S, D, F>): DeliveryConnection {
  let closed = false;
  let scheduled = false;
  let incomplete: SourceIncomplete | undefined;
  let pending: D[] = [];
  let closeSource = () => {};
  let closeAdditional = () => {};
  const connection: DeliverySink<D> = {
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
  const deliver = (frame: F) => {
    if (closed) return;
    try {
      options.send(frame);
    } catch {
      connection.close();
    }
  };
  const terminate = (project: () => F) => {
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
      incomplete: (error) => {
        if (closed || incomplete) return;
        incomplete = error;
        pending = [];
        schedule();
      },
    });
    closeSource = opened.close;
    if (!incomplete) {
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
