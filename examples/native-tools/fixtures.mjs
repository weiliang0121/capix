/** Small static protocol fixtures: no API keys or network requests. */
export function toolReply(calls = [{ id: 'call-read', name: 'read_text', arguments: '{"path":"notes.md"}' }], { id = 'reply-tools', content = '先读取材料。', reasoning = '需要读取原文。' } = {}) {
  return { id, model: 'offline-deepseek', choices: [{ index: 0, message: { role: 'assistant', content, reasoning_content: reasoning, tool_calls: calls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
}

export function finalReply(text = '已完成。', id = 'reply-final') {
  return { id, model: 'offline-deepseek', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 10, total_tokens: 40 } };
}

/** Calls alternate fragments; usage arrives after termination, before [DONE]. */
export function toolStream(raw) {
  const message = raw.choices[0].message;
  const chunks = [];
  const add = (delta, finish_reason = null) => chunks.push({ id: raw.id, model: raw.model, choices: [{ index: 0, delta, finish_reason }] });
  add({ role: 'assistant' });
  if (message.reasoning_content !== undefined) add({ reasoning_content: message.reasoning_content });
  if (message.content !== null) add({ content: message.content });
  const calls = message.tool_calls ?? [];
  calls.forEach((call, index) => add({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.function.name, arguments: '' } }] }));
  const length = Math.max(0, ...calls.map((call) => call.function.arguments.length));
  for (let position = 0; position < length; position += 3) {
    calls.forEach((call, index) => {
      const fragment = call.function.arguments.slice(position, position + 3);
      if (fragment) add({ tool_calls: [{ index, function: { arguments: fragment } }] });
    });
  }
  add({}, raw.choices[0].finish_reason);
  chunks.push({ id: raw.id, model: raw.model, choices: [], usage: raw.usage });
  return Buffer.from(chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n');
}
