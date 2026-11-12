// 固定决策脚本，不是智能模型。每一步检查真实反馈，再决定下一步。
// 与真实 Provider 使用相同 ModelRequest / ModelReply 和 Tool 结构。
export class OfflineNotesProvider {
  requests = [];

  async complete(request) {
    this.requests.push(request);
    const sources = JSON.parse(request.messages.find((message) => message.role === 'user').content).notes;
    if (!Array.isArray(sources) || sources.length !== 2) throw new Error('Offline script requires two source notes');
    const exchanges = request.exchanges ?? [];
    const read = [];
    let written;
    for (const exchange of exchanges) {
      const call = exchange.reply.output[0];
      const feedback = exchange.feedback[0];
      if (exchange.reply.output.length !== 1 || exchange.feedback.length !== 1 || call.kind !== 'tool-call' || feedback.toolCallId !== call.id || feedback.status !== 'ok') throw new Error('Offline script received invalid or failed tool feedback');
      if (feedback.content.length !== 1 || feedback.content[0].kind !== 'text') throw new Error('Offline script requires one JSON feedback');
      const note = JSON.parse(feedback.content[0].text);
      const args = JSON.parse(call.arguments.text);
      if (call.name === 'readNote' && read.length < 2 && !written) {
        if (args.id !== sources[read.length].id || note.id !== args.id || typeof note.value?.text !== 'string') throw new Error('Offline script read feedback mismatch');
        read.push(note);
      } else if (call.name === 'writeNote' && read.length === 2 && !written) {
        const expected = deriveTodo(read);
        if (args.title !== expected.title || args.text !== expected.text || note.value?.title !== expected.title || note.value?.text !== expected.text || typeof note.id !== 'string' || sources.some((source) => source.id === note.id)) throw new Error('Offline script write feedback mismatch');
        written = note;
      } else throw new Error('Offline script received unexpected tool call');
    }
    const output = written ? [{ kind: 'text', text: `已创建便签「${written.value.title}」：\n${written.value.text}` }] : [toolCall(read.length < 2 ? `read-${read.length + 1}` : 'write-todo', read.length < 2 ? 'readNote' : 'writeNote', read.length < 2 ? { id: sources[read.length].id } : deriveTodo(read))];
    return { formatVersion: 1, id: `offline-${exchanges.length + 1}`, model: 'offline-fixed-script', output, termination: { kind: 'completed', reason: written ? 'stop' : 'tool_calls' }, usage: null, native: { format: 'chat-completions', version: 1 } };
  }
}

function toolCall(id, name, args) {
  return { kind: 'tool-call', id, name, arguments: { encoding: 'json-text', text: JSON.stringify(args) } };
}

function deriveTodo(notes) {
  const tasks = notes.flatMap((note) =>
    note.value.text
      .split(/[；;]/u)
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (!tasks.length) throw new Error('Offline script found no tasks');
  return { title: '待办', text: tasks.map((task) => `- ${task}`).join('\n') };
}
