import { createConversationRunner } from '@capix/conversation-service';
import { Transcript } from '@capix/transcript';

const transcript = new Transcript();
const model = {
  async generate(messages, { emit }) {
    // Replace this local model with the host's provider. Emit only during this operation.
    const answer = `收到：${messages.at(-1).content}`;
    for (const chunk of ['收到：', messages.at(-1).content]) emit(chunk);
    return answer;
  },
};
const runner = createConversationRunner(transcript, model);
const unsubscribe = runner.output.subscribe({
  receive(event) {
    if (event.kind === 'delta') process.stdout.write(event.delta);
  },
});

const answer = await runner.run('你好');
unsubscribe();
console.log('\n正式回答：', answer);
console.log('正式消息数：', transcript.length); // Chunks never become transcript messages.
