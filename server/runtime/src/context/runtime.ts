import { RuntimeError } from '../errors/error.js';

/** Runtime's live occupancy only. Referenced entities have independent owners. */
export class RuntimeContext {
  #running = false;
  get running(): boolean {
    return this.#running;
  }
  async reserve<O>(work: () => O | Promise<O>): Promise<O> {
    if (this.#running) throw new RuntimeError('RUNTIME_BUSY', '当前环境正在执行，请等待本次调用结束。');
    this.#running = true;
    try {
      return await work();
    } finally {
      this.#running = false;
    }
  }
}
