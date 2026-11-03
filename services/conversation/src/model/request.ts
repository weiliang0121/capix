import type { Message } from '@capix/protocol';
import { Group } from '@capix/structure';
import { requireCompletionText } from '../completion.js';
import { requireString, requireText } from '../text.js';
import { createInteractionCompletion } from './completion.js';

/** A history answer uses the same complete request and feedback as every other model operation. */
export function createInteractionAnswer(options: { readonly waitMs?: number } = {}) {
  const completion = createInteractionCompletion(options);
  const answer = new Group<readonly Readonly<Message>[], string, {}, string>({
    name: 'interaction-answer',
    output: { result: (value) => requireText(value, 'Model answer'), delta: (value) => requireString(value, 'Model preview') },
  }).add({ completion });
  answer.run = async (work) => {
    const reply = await work.children.completion.invoke({ messages: work.input, responseFormat: 'text', stream: true }, { delta: (value) => work.output.emit(value) });
    return requireCompletionText(reply);
  };
  return answer;
}
