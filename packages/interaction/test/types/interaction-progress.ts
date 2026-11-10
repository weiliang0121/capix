import { Interactions, type InteractionContract, type InteractionChannel, type InteractionCursor } from '@weiliang0121/capix-interaction';

const contract: InteractionContract<string, { answer: string }, string> = {
  key: 'typed.progress',
  request: String,
  reply: (value) => ({ answer: String(value) }),
  progress: String,
};
const interactions = new Interactions().register(contract, {
  send(request, progress) {
    const text: string = request;
    progress.publish(text);
    // @ts-expect-error Process data must match the registered delta contract.
    progress.publish(42);
    return { answer: text };
  },
});
// @ts-expect-error The final reply remains distinct from process data.
new Interactions().register(contract, { send: () => 'wrong reply' });
const channel = interactions.bind(contract);
const ref = channel.start('input');
const reader = channel.openProgress(ref);
const position: InteractionCursor = reader.position;
channel.openProgress(ref, position);
// @ts-expect-error A sequence alone does not identify its interaction.
channel.openProgress(ref, 3);
// @ts-expect-error Reader positions are immutable values.
reader.position = position;
reader.next({ waitMs: 1 }).then((item) => {
  if (item.kind === 'item') {
    const text: string = item.value;
    // @ts-expect-error A string delta is not a final reply object.
    item.value.answer;
    void text;
  }
});
const plain: InteractionContract<string, string> = { key: 'plain', request: String, reply: String };
new Interactions().register(plain, {
  send(request, progress) {
    // @ts-expect-error A request/reply-only registration has no delta data type.
    progress.publish('not declared');
    return request;
  },
});
