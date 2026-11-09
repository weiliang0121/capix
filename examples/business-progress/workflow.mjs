import { Resource, ResourceOffer } from '@weiliang0121/capix-resources';
import { Group, Node, Scene } from '@weiliang0121/capix-structure';
import { Resources, Runner } from '@weiliang0121/capix-runtime';
import { publicationOperation } from './progress.mjs';

const progressAccess = new ResourceOffer({
  methods: {
    read: (entity) => entity.read(),
    attach: (entity, change) => entity.attach(change),
    accept: (entity, change) => entity.accept(change),
  },
});
const generationAccess = new ResourceOffer({
  methods: {
    establish: (gateway, operation) => gateway.establish(operation),
    read: (gateway, reference) => gateway.read(reference),
  },
});
const publicationAccess = new ResourceOffer({
  methods: {
    confirm: (archive, operation) => archive.confirm(operation),
    publish: (archive, operation) => archive.publish(operation),
  },
});

// 每次建立独立结构和 Runner；共享的是业务资源，绝不是 Node 或 Invocation。
export function createPublicationRunner({ progress, gateway, archive }) {
  const generate = new Node({
    deps: { generation: generationAccess.request() },
    run: (work) => work.resources.generation.establish(work.input),
  });
  const publish = new Node({
    deps: { publications: publicationAccess.request() },
    async run(work) {
      const effect = await work.resources.publications.confirm(work.input);
      if (effect.status === 'unknown') return effect;
      const receipt = effect.status === 'confirmed' ? effect.receipt : await work.resources.publications.publish(work.input);
      return { status: 'confirmed', receipt };
    },
  });
  const advance = new Group({ deps: { progress: progressAccess.request(), generation: generationAccess.request() } }).add({ generate, publish });
  advance.run = async (work) => {
    let state = await work.resources.progress.read();
    let item = state.items.find((entry) => !entry.acceptance);
    if (!item) return { status: 'complete' };

    if (!item.reference) {
      // 这里仍有两次提交。若 attach 失败，下次 establish 按操作索引找回同一引用。
      const reference = await work.children.generate.invoke(item.generation);
      state = await work.resources.progress.attach({ itemId: item.id, expectedRevision: state.revision, reference });
      item = state.items.find((entry) => entry.id === item.id);
    }
    const reply = await work.resources.generation.read(item.reference);
    if (reply.kind === 'pending') return { status: 'pending', itemId: item.id };
    if (reply.kind === 'unavailable') return { status: 'unavailable', itemId: item.id };

    return work.children.publish.invoke(publicationOperation(item, reply.feedback), {
      result: {
        async succeeded(effect) {
          if (effect.status === 'unknown') return { status: 'unknown', itemId: item.id };
          // 子返回成功 ≠ 业务接纳。下列提交失败时，目标效果已经存在，下次只确认它。
          await work.resources.progress.accept({ itemId: item.id, expectedRevision: state.revision, changeId: item.acceptanceId, receipt: effect.receipt });
          return { status: 'accepted', itemId: item.id, receipt: effect.receipt };
        },
      },
    });
  };
  const resources = new Resources().register(new Resource(progress), progressAccess).register(new Resource(gateway), generationAccess).register(new Resource(archive), publicationAccess);
  return new Runner(new Scene(advance), resources).build();
}
