/** Passive publication result; the producer decides whether a consumer failure is fatal. */
export interface EventConsumer<Event> {
  publish(event: Event): unknown | undefined;
}
