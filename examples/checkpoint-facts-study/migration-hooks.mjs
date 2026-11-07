// Experimental automatic-boundary insertion into freshly built modules, in memory only.
// Every replacement must match exactly; source drift aborts the probe, never silently skips it.
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url).href;
const values = new URL('./migration-values.mjs', import.meta.url).href;
const patches = new Map([
  ['server/runtime/dist/construction/calls.js', [['const prepared = scope.prepare(structure, input, !!restore, parent?.context.resources.supply, signal);', 'input = __stableOwn(input, "input:before-capture");\n    const prepared = scope.prepare(structure, input, !!restore, parent?.context.resources.supply, signal);']]],
  ['server/runtime/dist/construction/invocation.js', [['const selected = supplied.select(request.supply ?? deps).refine(input, request.refinements ?? []);', 'input = __stableOwn(input, "input:before-refine");\n        const selected = supplied.select(request.supply ?? deps).refine(input, request.refinements ?? []);']]],
  [
    'server/invocation/dist/context/context.js',
    [
      ['this.input = input;', 'this.input = input = __stableOwn(input, "input:context");'],
      ["this.#progress = Object.freeze({ round: frame.round, input: frame.currentInput, phase: 'execute' });", 'this.#progress = Object.freeze({ round: frame.round, input: __stableOwn(frame.currentInput, "restore:current-input"), phase: \'execute\' });'],
      ['this.#progress = Object.freeze({ round: frame.round, input: frame.currentInput, phase: frame.phase });', 'this.#progress = Object.freeze({ round: frame.round, input: this.currentInput, phase: frame.phase });', 2],
      ["this.#state = Object.freeze({ status: 'succeeded', output });", 'this.#state = Object.freeze({ status: \'succeeded\', output: __stableOwn(output, "output:context") });'],
    ],
  ],
  ['server/invocation/dist/invocation/execution.js', [["body = { status: 'succeeded', value: await (resume ? resume() : this.work.execute()) };", 'body = { status: \'succeeded\', value: __stableOwn(await (resume ? resume() : this.work.execute()), "output:before-settle-close") };']]],
  ['server/invocation/dist/invocation/relation.js', [['const value = await work(delivered);', 'const value = __stableOwn(await work(delivered), "reception:before-check");']]],
  ['server/invocation/dist/operation/failure.js', [['if (current instanceof InvocationStopped', 'if (__stableBoundaryFailure(current) || current instanceof InvocationStopped']]],
  ['server/invocation/dist/checkpoint/target.js', [["const output = child.state.kind === 'returned' ? (binding ? binding.output.decode(child.state.output) : child.state.output) : undefined;", 'const output = __stableOwn(child.state.kind === \'returned\' ? (binding ? binding.output.decode(child.state.output) : child.state.output) : undefined, "restore:child-output");']]],
  [
    'server/invocation/dist/checkpoint/facts.js',
    [
      ['return saved;', 'return __stableReception(saved);', 2],
      ['const output = binding.codec.decode(saved.output);', 'const output = __stableOwn(binding.codec.decode(saved.output), "decode:typed-reception");', 2],
      ['const input = target ? target.input.decode(child.input) : child.input;', 'const input = __stableOwn(target ? target.input.decode(child.input) : child.input, "decode:child-input");'],
      ['currentInput: target ? target.input.decode(saved.progress.currentInput) : saved.progress.currentInput', 'currentInput: __stableOwn(target ? target.input.decode(saved.progress.currentInput) : saved.progress.currentInput, "decode:child-current-input")'],
      ['output: target ? target.output.decode(saved.output) : saved.output', 'output: __stableOwn(target ? target.output.decode(saved.output) : saved.output, "decode:child-output")'],
      ['return Object.freeze({ ...frame, input: binding.input.decode(frame.input), currentInput: binding.input.decode(frame.currentInput), children: Object.freeze(decoded) });', 'return Object.freeze({ ...frame, input: __stableOwn(binding.input.decode(frame.input), "decode:input"), currentInput: __stableOwn(binding.input.decode(frame.currentInput), "decode:current-input"), children: Object.freeze(decoded) });'],
    ],
  ],
]);

// Optional second probe: real entity producers join the same value authority.
// It intentionally does not patch resource endpoints, entity instances, or arbitrary snapshots.
if (process.env.CAPIX_STABLE_STUDY_ENTITIES === '1') {
  patches.set('server/memory/dist/memory.js', [['return Object.freeze({ topic, content: text, sourceIndexes, ...(sourceResults ? { sourceResults } : {}) });', 'return __stableOwn({ topic, content: text, sourceIndexes, ...(sourceResults ? { sourceResults } : {}) }, "entity:memory-content");']]);
  patches.set('server/transcript/dist/transcript.js', [['return Object.freeze({ role: message.role, content: message.content });', 'return __stableOwn({ role: message.role, content: message.content }, "entity:message");']]);
}

registerHooks({
  load(url, context, next) {
    const result = next(url, context);
    const path = url.startsWith(root) ? url.slice(root.length) : '';
    const changes = patches.get(path);
    if (!changes) return result;
    let source = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString();
    for (const [before, after, expected = 1] of changes) {
      const pieces = source.split(before);
      if (pieces.length - 1 !== expected) throw new Error(`Stable migration probe is stale: ${path}, expected ${expected} replacement(s), got ${pieces.length - 1}: ${before}`);
      source = pieces.join(after);
    }
    const header = `import { fixed as __stableOwn, fixedReception as __stableReception, protectedFailure as __stableBoundaryFailure, loaded as __stableLoaded } from ${JSON.stringify(values)};\n__stableLoaded(${JSON.stringify(path)});\n`;
    return { ...result, source: header + source };
  },
});

// A discoverable entry point for the census, not an author-facing feature switch.
export const studyRoot = fileURLToPath(root);
