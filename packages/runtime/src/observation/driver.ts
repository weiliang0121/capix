/** Host entry ownership is distinct from any one invocation's lifecycle. */
export type DriverFact = Readonly<
  {
    driverId: string;
    sequence: number;
    occurredAt: string;
  } & ({ kind: 'established' } | ({ boundId: string } & ({ kind: 'acquired' } | { kind: 'released' } | { kind: 'rejected'; reason: 'busy'; error: unknown } | { kind: 'entry-failed'; error: unknown })))
>;

export interface DriverObserver {
  observe(fact: DriverFact): undefined;
  available?(): boolean;
}
