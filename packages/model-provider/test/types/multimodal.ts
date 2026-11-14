import type { ModelImageInput, ModelInputContent, ModelMessage, ModelOutput, ToolResult } from '@weiliang0121/capix-model-provider';

const image: ModelImageInput = { kind: 'image', mimeType: 'image/png', data: 'fixed-base64' };
const content: readonly ModelInputContent[] = [{ kind: 'text', text: 'Look' }, image];
const user: ModelMessage = { role: 'user', content };
const system: ModelMessage = { role: 'system', content: [{ kind: 'text', text: 'Instructions' }] };
// @ts-expect-error Portable system messages cannot introduce image input.
const invalidSystem: ModelMessage = { role: 'system', content };
const assistant: ModelMessage = { role: 'assistant', content: [{ kind: 'text', text: 'Answer' }] };
const result: ToolResult = { status: 'ok', content };
// @ts-expect-error Assistant messages cannot introduce image input.
const invalidAssistant: ModelMessage = { role: 'assistant', content: [image] };
// @ts-expect-error Image input is not model output.
const output: ModelOutput = image;
// @ts-expect-error Mutable remote URL is not fixed image material.
const remote: ModelImageInput = { kind: 'image', mimeType: 'image/png', url: 'https://example.test/image.png' };
// @ts-expect-error SVG is outside the image input domain.
const svg: ModelImageInput = { kind: 'image', mimeType: 'image/svg+xml', data: 'fixed-base64' };
void [user, system, assistant, result, invalidAssistant, output, remote, svg];
