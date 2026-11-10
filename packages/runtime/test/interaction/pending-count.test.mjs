import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Interactions } from '@weiliang0121/capix-interaction';
import { ResourceOffer } from '@weiliang0121/capix-resources';
import { Node, Resources, Runner, Scene } from '@weiliang0121/capix-runtime';

const contract = (key = 'pending-count.echo') => ({ key, request: (value) => value, reply: (value) => value });

test('a completed invocation leaves its independent pending interaction counted until late feedback settles', async () => {
  const boundary = contract();
  const late = Promise.withResolvers();
  const interactions = new Interactions().register(boundary, { send: () => late.promise });
  const offer = new ResourceOffer({ methods: { start: (channel, input) => channel.start(input) } });
  const start = new Node({ deps: { exchange: offer.request() }, run: (work) => work.resources.exchange.start(work.input) });
  const runner = new Runner(new Scene(start), new Resources().registerInteraction(offer, boundary), interactions).build();
  const ref = await runner.run('question');
  assert.equal(runner.isRunning, false);
  assert.equal(interactions.pendingCount, 1);
  assert.equal(interactions.bind(boundary).read(ref).kind, 'pending');
  late.resolve('answer');
  await interactions.settled();
  assert.equal(interactions.pendingCount, 0);
  assert.equal(interactions.bind(boundary).read(ref).feedback.payload, 'answer');
  interactions.close();
});
