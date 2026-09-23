import type { InvocationLifecycle } from '../invocation/lifecycle.js';
import { RuntimeContext } from '../context/context.js';
import { ExecutionContext, type ExecutionOptions } from '../context/execution.js';
import { OperationContext } from '../context/operation.js';
import { AttemptContext, type AttemptPhase } from '../context/attempt.js';
import type { Operation } from '../operations/operation.js';
import type { RuntimeRecorder } from '../records/recorder.js';

interface Scope {
  parent?: RuntimeContext;
  children: Set<RuntimeContext>;
}

/** Owns live scope boundaries. Record state and record identities never decide work outcomes. */
export class Runtime {
  readonly #scopes = new WeakMap<RuntimeContext, Scope>();

  constructor(readonly recorder?: RuntimeRecorder) {}

  execution<I, O>(request: ExecutionOptions & { input: I }, started?: (context: ExecutionContext<I, O>) => void): InvocationLifecycle<ExecutionContext<I, O>, O> {
    return this.lifecycle<I, O, ExecutionContext<I, O>>(
      () => new ExecutionContext(request.input, request),
      undefined,
      (context) => {
        started?.(context);
        this.recorder?.beginExecution(context);
      },
    );
  }

  operation<I, B, C, O>(execution: ExecutionContext, operation: Operation<I, B, C, O>, input: I, parent?: OperationContext): InvocationLifecycle<OperationContext<I, O>, O> {
    return this.lifecycle<I, O, OperationContext<I, O>>(
      () => {
        this.requireActive(execution);
        if (parent && parent.executionId !== execution.id) throw new Error('Parent operation belongs to another execution');
        return new OperationContext<I, O>(execution.id, input);
      },
      parent ?? execution,
      (context) => this.recorder?.beginOperation(context, operation, parent),
    );
  }

  attempt<I, O>(operation: OperationContext, phase: AttemptPhase, input: I, source: string, callee: string): InvocationLifecycle<AttemptContext<I, O>, O> {
    return this.lifecycle<I, O, AttemptContext<I, O>>(
      () => new AttemptContext<I, O>(operation.id, phase, input),
      operation,
      (context) => this.recorder?.beginAttempt(context, source, callee),
    );
  }

  /** Resolve ownership from registered live scopes, never from records. Reads remain valid after completion. */
  getExecutionContext(context: RuntimeContext): ExecutionContext {
    let current = context;
    while (true) {
      const scope = this.scope(current);
      if (current instanceof ExecutionContext) return current;
      if (!scope.parent) throw new Error('Execution context does not exist');
      current = scope.parent;
    }
  }

  getOperationContext(context: AttemptContext): OperationContext {
    const parent = this.scope(context).parent;
    if (!(parent instanceof OperationContext) || parent.id !== context.operationId) throw new Error('Operation context does not exist');
    return parent;
  }

  private lifecycle<I, O, C extends RuntimeContext<I, O>>(create: () => C, parent: RuntimeContext | undefined, recordStart: (context: C) => void): InvocationLifecycle<C, O> {
    return {
      begin: () => {
        if (parent) this.requireActive(parent);
        const context = create();
        this.#scopes.set(context, { parent, children: new Set() });
        if (parent) this.scope(parent).children.add(context);
        try {
          recordStart(context);
        } catch (error) {
          context.fail(error);
          this.detach(context);
          throw error;
        }
        return context;
      },
      succeed: (context, output) => {
        this.requireFinishable(context);
        context.complete(output);
        this.detach(context);
        this.recorder?.finish(context);
      },
      fail: (context, error) => {
        this.requireFinishable(context);
        context.fail(error);
        this.detach(context);
        this.recorder?.finish(context);
      },
    };
  }

  private scope(context: RuntimeContext): Scope {
    const scope = this.#scopes.get(context);
    if (!scope) throw new Error('Context does not belong to this Runtime');
    return scope;
  }

  private requireActive(context: RuntimeContext): void {
    this.scope(context);
    context.requireRunning();
  }

  private requireFinishable(context: RuntimeContext): void {
    this.requireActive(context);
    if (this.scope(context).children.size) throw new Error('Cannot end a context with active child contexts');
  }

  private detach(context: RuntimeContext): void {
    const parent = this.scope(context).parent;
    if (parent) this.scope(parent).children.delete(context);
  }
}
