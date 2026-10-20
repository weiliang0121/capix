import { z } from 'zod';
import type { ChildContractsOf, ChildCalls, ChildOptions, CallableInput, CallableOutput, CallableDelta, InvocationOutputReceiver, ChildCall } from '@capix/server-runtime';
import type { ConversationCapabilityName, ConversationCapabilityOffer, ConversationDecisionFeedback } from './types.js';
import { modelTextSchema } from '../model/schema.js';

// The E catalog is heterogeneous. Each adapter captures its concrete Definition,
// validates selectable arguments and constructs that child's exact input before calling.
type CapabilityContract = ChildContractsOf<'group'>;

// Heterogeneous dispatch carries only identity and start; the adapter reopens
// the exact declaration before accepting its result.
export type ConversationCapabilityCall = Pick<ChildCall<CapabilityContract>, 'ref' | 'run'>;

/** A service-local adapter between selectable arguments and the real declared child. */
export interface ConversationCapability<State> {
  readonly use: CapabilityContract;
  readonly offer: ConversationCapabilityOffer;
  available(state: State): boolean;
  validate(value: unknown): boolean;
  create(value: unknown, state: State): ConversationCapabilityCall;
  accept(child: ConversationCapabilityCall, state: State): Promise<State>;
}

/** This adapter creates one declared capability; historical lookup does not grant creation. */
interface CapabilityCalls<Definition extends CapabilityContract> extends Pick<ChildCalls, 'open' | 'facts'> {
  readonly create: (definition: Definition, input: CallableInput<Definition>, options?: ChildOptions<Definition>) => ChildCall<Definition>;
}

export function conversationCapability<Arguments, State, Definition extends CapabilityContract>(
  options: {
    readonly name: ConversationCapabilityName;
    readonly description: string;
    readonly use: Definition;
    readonly key: string;
    readonly output?: InvocationOutputReceiver<CallableOutput<Definition>, CallableDelta<Definition>>;
    readonly schema: z.ZodType<Arguments>;
    readonly available: (state: State) => boolean;
    readonly input: (arguments_: Arguments, state: State) => CallableInput<Definition>;
    readonly accept: (delivered: CallableOutput<Definition>, state: State, child: ChildCall<Definition>) => State;
  },
  children: CapabilityCalls<NoInfer<Definition>>,
): ConversationCapability<State> {
  return Object.freeze({
    use: options.use,
    offer: Object.freeze({ name: options.name, description: options.description, arguments: z.toJSONSchema(options.schema) }),
    available: options.available,
    validate: (value: unknown) => options.schema.safeParse(value).success,
    create: (value: unknown, state: State) => children.create(options.use, options.input(options.schema.parse(value), state), { key: options.key, output: options.output }),
    accept: (child: ConversationCapabilityCall, state: State) => {
      const selected = children.open(children.facts.require(options.use, child.ref).ref);
      return selected.accept((delivered) => options.accept(delivered, state, selected));
    },
  });
}

const conclusionSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('settled') }), z.strictObject({ kind: z.literal('clarify'), question: modelTextSchema }), z.strictObject({ kind: z.literal('unsupported'), explanation: modelTextSchema })]);
const proposal = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('invoke'), capability: z.string(), arguments: z.unknown() }), z.strictObject({ kind: z.literal('finish'), conclusion: conclusionSchema })]);

export type AcceptedConversationDecision = Exclude<z.infer<typeof proposal>, { readonly kind: 'invoke' }> | { readonly kind: 'invoke'; readonly capability: ConversationCapabilityName; readonly arguments: unknown } | { readonly kind: 'revise'; readonly feedback: ConversationDecisionFeedback };

/** Predictable proposal rejection is a normal delivery; child/handler failures still throw. */
export function acceptConversationDecision<State>(value: unknown, capabilities: ReadonlyMap<string, ConversationCapability<State>>, state: State, canFinish: (conclusion: z.infer<typeof conclusionSchema>) => boolean): AcceptedConversationDecision {
  const checked = proposal.safeParse(value);
  if (!checked.success) return reviseDecision('DECISION_SHAPE', '提案必须选择已公开能力并提供其参数，或按结论契约结束。');
  const decision = checked.data;
  if (decision.kind === 'finish') return canFinish(decision.conclusion) ? decision : reviseDecision('UNSETTLED', '只能根据已接纳的真实交付结束；未生成回答或尚未完成已选定的保存步骤。');
  const capability = capabilities.get(decision.capability);
  if (!capability || capability.offer.name !== decision.capability || !capability.available(state)) return reviseDecision('UNAVAILABLE_CAPABILITY', '该能力未注册或当前阶段不可使用，请根据 available 和已接纳进展重新选择。');
  if (!capability.validate(decision.arguments)) return reviseDecision('CAPABILITY_ARGUMENTS', '参数不符合所选能力的公开契约，请修正提案。');
  return { ...decision, capability: capability.offer.name };
}

export function reviseDecision(code: string, message: string): Extract<AcceptedConversationDecision, { kind: 'revise' }> {
  return { kind: 'revise', feedback: { code, message } };
}
