import type { Message } from '@capix/protocol';
import type { ResourcesOf } from '@capix/resources';
import { Node } from '@capix/structure';
import { ModelResource } from './model.js';
import { requireString, requireText } from './text.js';

/** Direct model processing. Its dependency and incremental output are both explicit. */
export function createAnswerNode() {
  const deps = { model: ModelResource.request() };
  return new Node<readonly Readonly<Message>[], string, ResourcesOf<typeof deps>, string>({
    name: 'answer',
    deps,
    output: { result: (value) => requireText(value, 'Model answer'), delta: (value) => requireString(value, 'Model delta') },
    run: (work) => work.resources.model.generate(work.input, { delta: (value) => work.output.emit(value) }),
  });
}
