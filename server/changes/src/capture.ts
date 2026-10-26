/** Accept a completed immutable fact synchronously, or throw before accepting it.
 * Implementations must not invoke downstream consumers or reenter the source.
 * Sources fix their own payloads; capture does not clone or interpret business content.
 */
export interface ChangeCapture<Event> {
  readonly capture: (event: Event) => void;
}
