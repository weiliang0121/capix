type Initialization<T> = { status: 'idle' } | { status: 'creating' } | { status: 'ready'; value: T } | { status: 'failed'; error: unknown };

/** One synchronous initialization owned by its assembly site; failure is retained, not retried implicitly. */
export class Initializer<T> {
  #state: Initialization<T> = { status: 'idle' };

  constructor(private readonly create: () => T) {}

  get initialized(): boolean {
    return this.#state.status === 'ready';
  }

  get(): T {
    const state = this.#state;
    if (state.status === 'ready') return state.value;
    if (state.status === 'failed') throw state.error;
    if (state.status === 'creating') throw new Error('Recursive initialization');
    this.#state = { status: 'creating' };
    try {
      const value = this.create();
      this.#state = { status: 'ready', value };
      return value;
    } catch (error) {
      this.#state = { status: 'failed', error };
      throw error;
    }
  }
}
