export type ClientInitializationState = { readonly status: 'idle' } | { readonly status: 'running' | 'succeeded' | 'stopped'; readonly attempt: number } | { readonly status: 'failed'; readonly attempt: number; readonly error: unknown };

/** One environment initialization attempt, independent of server invocation machinery. */
export class InitializationAttempt {
  readonly promise: Promise<void>;
  private resolve!: () => void;
  private reject!: (error: unknown) => void;
  private state: ClientInitializationState;

  constructor(readonly number: number) {
    this.state = { status: 'running', attempt: number };
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  get running(): boolean {
    return this.state.status === 'running';
  }

  get snapshot(): ClientInitializationState {
    return this.state;
  }

  complete(): void {
    this.requireRunning();
    this.state = { status: 'succeeded', attempt: this.number };
    this.resolve();
  }

  fail(error: unknown): void {
    this.requireRunning();
    this.state = { status: 'failed', attempt: this.number, error };
    this.reject(error);
  }

  stop(): void {
    this.requireRunning();
    this.state = { status: 'stopped', attempt: this.number };
    this.reject(new DOMException('客户端初始化已停止。', 'AbortError'));
  }

  private requireRunning(): void {
    if (!this.running) throw new Error('客户端初始化尝试已经结束。');
  }
}
