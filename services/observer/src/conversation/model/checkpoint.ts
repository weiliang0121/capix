import { z } from 'zod';
import { checkpointCodec } from '../checkpoint.js';
import { modelOutputSchema, modelRequestSchema } from './interactions.js';
export const modelRequestCodec = checkpointCodec(modelRequestSchema);
export const modelFeedbackCodec = checkpointCodec(modelOutputSchema);
export const interactionRefSchema = z.strictObject({ id: z.string().min(1) });
export const interactionRefCodec = checkpointCodec(interactionRefSchema);
export const interactionResultCodec = checkpointCodec(z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('received'), interaction: interactionRefSchema, output: modelOutputSchema }), z.strictObject({ kind: z.literal('pending'), interaction: interactionRefSchema })]));

export const followInputCodec = checkpointCodec(interactionRefSchema.extend({ expected: z.strictObject({ request: modelRequestSchema, purpose: z.enum(['selection', 'understanding', 'answer', 'memory']) }) }));
