import type { InvocationLifecycle } from '../invocation/lifecycle.js';
import { RuntimeContext } from '../context/context.js';
import { ExecutionContext, type ExecutionOptions } from '../context/execution.js';
import { OperationContext, type OperationDeclaration } from '../context/operation.js';
import { AttemptContext, type AttemptDeclaration } from '../context/attempt.js';
import type { RuntimeRecorder } from '../records/recorder.js';

interface Scope {
  parent?: RuntimeContext;
  children: Set<RuntimeContext>;
}

/** Owns live scope boundaries. Record state and record identities never decide work outcomes. */
export class Runtime {
  readonly #scopes = new WeakMap<RuntimeContext, Scope>();

  constructor(readonly recorder?: RuntimeRecorder) {}

  execution<I, O>(request: ExecutionOptions & { input: I }): InvocationLifecycle<ExecutionContext<I, O>, O> {
    return this.lifecycle<I, O, ExecutionContext<I, O>>(
      () => new ExecutionContext(request.input, request),
      undefined,
      (context) => this.recorder?.beginExecution(context),
    );
  }

  operation<I, O>(execution: ExecutionContext, declaration: OperationDeclaration, input: I, parent?: OperationContext): InvocationLifecycle<OperationContext<I, O>, O> {
    return this.lifecycle<I, O, OperationContext<I, O>>(
      () => {
        this.requireActive(execution);
        if (parent && parent.executionId !== execution.id) throw new Error('Parent operation belongs to another execution');
        return new OperationContext(execution.id, declaration, input, parent?.id);
      },
      parent ?? execution,
      (context) => this.recorder?.beginOperation(context),
    );
  }

  attempt<I, O>(operation: OperationContext, declaration: AttemptDeclaration, input: I): InvocationLifecycle<AttemptContext<I, O>, O> {
    return this.lifecycle<I, O, AttemptContext<I, O>>(
      () => new AttemptContext(operation.id, declaration, input),
      operation,
      (context) => this.recorder?.beginAttempt(context),
    );
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
