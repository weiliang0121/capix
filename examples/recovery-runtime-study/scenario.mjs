import { Node, Group, Scene, checkpointPoint, childReference, reception } from '@capix/structure';
import { Resource, ResourceOffer } from '@capix/resources';
import { TranscriptResource } from '@capix/transcript';
import { Resources, Runner } from '@capix/server-runtime';
import { isDeepStrictEqual } from 'node:util';
import { keys } from './store.mjs';

const codec = { encode: (value) => value, decode: (value) => value };
const output = { result: (value) => value, delta: (value) => value };

// This is an author-level experiment using the existing points, state, refs and
// Runner.resume. Reentry is explicitly opted into by the Group's resume handlers.
export function buildScenario(study, mode, options, cut) {
  const { event } = study;
  const heldEndpoints = [];
  const materials = new ResourceOffer({
    name: 'study.material',
    methods: {
      read(origin, _input, operation) {
        event('material-read', { material: origin });
        operation.onClose(() => {
          event('material-cleanup');
        });
        return origin;
      },
    },
  });
  const generate = new ResourceOffer({
    name: 'study.generate',
    methods: {
      generate(_origin, input, operation) {
        event('resource-body', { input });
        operation.onClose(() => {
          event('resource-cleanup');
          if (options.fault === 'resource-close') throw new Error('resource close failed');
        });
        const value = { text: `${input.query}: ${input.material.text}` };
        event('resource-candidate', { value });
        return value;
      },
    },
  });
  const nodeDone = checkpointPoint()({
    name: 'completed',
    state: codec,
    references: {},
    check(state, facts) {
      if (!isDeepStrictEqual(state, { text: `${facts.initialInput.query}: ${facts.initialInput.material.text}` }) || facts.children.values().length !== 0) throw new Error('Node output differs from fixed source');
    },
    resume: {
      run(_work, state) {
        event('node-resume');
        return state;
      },
    },
  });
  const node = new Node({
    checkpoint: { key: keys.node, version: 1, input: codec, output: codec, points: [nodeDone] },
    deps: { generator: generate.request() },
    async run(work) {
      event('node-body', { input: work.input });
      heldEndpoints.push(work.resources.generator);
      const value = await work.resources.generator.generate(work.input);
      work.checkpoint({ point: nodeDone, state: value, refs: {} });
      return value;
    },
  });
  const receivedNode = reception(node, { ...codec, check: () => undefined });
  const groupDeps = { material: materials.request(), messages: TranscriptResource.append.request() };
  const checkGroupMaterial = (state, facts) => {
    const child = facts.references.child;
    if (facts.children.values().length !== 1 || !isDeepStrictEqual(state.material, facts.initialInput.material) || !isDeepStrictEqual(child.input, { query: facts.initialInput.query, material: facts.initialInput.material })) throw new Error('Group material differs from fixed input');
  };

  async function receiveNode(work, handle, material) {
    const value = await handle.invoke({
      reception: receivedNode,
      result: {
        succeeded(returned) {
          event('mapping', { returned });
          const receipt = work.resources.messages.applyFixed({ position: 'answer', messages: [{ role: 'assistant', content: returned.text }] });
          event('entity-applied', { receipt });
          cut('entity-applied');
          return { text: returned.text, receipt };
        },
        failed(error) {
          event('fallback', { message: error?.message });
          return { text: 'fallback', receipt: null };
        },
      },
    });
    work.checkpoint({ point: groupAccepted, state: { material, value }, refs: { child: handle.ref } });
    cut('group-accepted');
    return value;
  }

  function pendingChild(work, ref) {
    const fact = work.children.facts.get(ref);
    // A restored returned fact is opened; a waiting relation resumes the exact
    // original child. Neither branch creates a replacement child invocation.
    return fact.returned ? work.children.open(ref) : work.children.resume(ref);
  }

  async function coordinate(port) {
    event('coordinator-body', { phase: port.phase });
    const material = await port.material();
    return port.child(material);
  }

  function savedPort(work, phase, state, refs) {
    return {
      phase,
      material() {
        event('replay-material', { material: state.material });
        return state.material;
      },
      child(material) {
        if (phase === 'accepted') {
          event('replay-accepted');
          return work.children.facts.accepted(refs.child, receivedNode);
        }
        event('replay-pending');
        return receiveNode(work, pendingChild(work, refs.child), material);
      },
    };
  }

  const groupWaiting = checkpointPoint()({
    name: 'waiting',
    state: codec,
    references: { child: childReference(node) },
    check: checkGroupMaterial,
    resume: {
      deps: groupDeps,
      uses: [node],
      run(work, state, refs) {
        event('group-resume', { point: 'waiting', mode });
        heldEndpoints.push(work.resources.material);
        return mode === 'replay' ? coordinate(savedPort(work, 'waiting', state, refs)) : receiveNode(work, pendingChild(work, refs.child), state.material);
      },
    },
  });
  const groupAccepted = checkpointPoint()({
    name: 'accepted',
    state: codec,
    references: { child: childReference(node) },
    resume: {
      run(work, state, refs) {
        event('group-resume', { point: 'accepted', mode });
        return mode === 'replay' ? coordinate(savedPort(work, 'accepted', state, refs)) : work.children.facts.accepted(refs.child, receivedNode);
      },
    },
    check(state, facts) {
      checkGroupMaterial(state, facts);
      if (!isDeepStrictEqual(facts.children.accepted(facts.references.child.ref, receivedNode), state.value)) throw new Error('Accepted group state changed');
    },
  });
  const group = new Group({
    checkpoint: { key: keys.group, version: 1, input: codec, output: codec, points: [groupWaiting, groupAccepted], receptions: [receivedNode] },
    deps: groupDeps,
    run(work) {
      event('group-body');
      heldEndpoints.push(work.resources.material);
      return coordinate({
        phase: 'initial',
        material: () => work.resources.material.read(null),
        child(material) {
          const handle = work.children.create(node, { query: work.input.query, material });
          work.checkpoint({ point: groupWaiting, state: { material }, refs: { child: handle.ref } });
          cut('group-waiting');
          return receiveNode(work, handle, material);
        },
      });
    },
  }).add(node);
  const receivedGroup = reception(group, { ...codec, check: () => undefined });
  const checkRootInput = (_state, facts) => {
    if (facts.children.values().length !== 1 || !isDeepStrictEqual(facts.references.child.input, facts.initialInput)) throw new Error('Group input differs from original scene input');
  };
  const checkRootAccepted = (state, facts) => {
    checkRootInput(state, facts);
    if (!isDeepStrictEqual(state, facts.children.accepted(facts.references.child.ref, receivedGroup))) throw new Error('Scene state differs from accepted group');
  };
  let runner;

  function observe(work, value) {
    event('business-call');
    work.observation({ event: 'finished-preview', text: value.text });
    return value;
  }
  function preview(work, value, ref) {
    // Deliberately conservative preview policy for this fixture only. Emission
    // and CP are not transactional: pending means possibly already displayed.
    work.checkpoint({ point: previewPending, state: value, refs: { child: ref } });
    cut('preview-pending');
    work.output.emit(value.text);
    cut('preview-emitted');
    if (options.fault === 'cancel-after-preview') runner.cancel(new Error('cancel after preview'));
    work.checkpoint({ point: previewed, state: value, refs: { child: ref } });
    cut('previewed');
    return observe(work, value);
  }
  async function receiveGroup(work, handle) {
    const value = await handle.invoke({ reception: receivedGroup, result: { succeeded: (returned) => returned } });
    work.checkpoint({ point: rootAccepted, state: value, refs: { child: handle.ref } });
    cut('root-accepted');
    return preview(work, value, handle.ref);
  }
  const rootWaiting = checkpointPoint()({
    name: 'waiting',
    state: codec,
    references: { child: childReference(group) },
    check: checkRootInput,
    resume: {
      uses: [group],
      run(work, _state, refs) {
        event('scene-resume', { point: 'waiting' });
        return receiveGroup(work, pendingChild(work, refs.child));
      },
    },
  });
  const rootAccepted = checkpointPoint()({
    name: 'accepted',
    state: codec,
    references: { child: childReference(group) },
    check: checkRootAccepted,
    resume: {
      run(work, _state, refs) {
        event('scene-resume', { point: 'accepted' });
        return preview(work, work.children.facts.accepted(refs.child, receivedGroup), refs.child);
      },
    },
  });
  const previewPending = checkpointPoint()({
    name: 'preview-pending',
    state: codec,
    references: { child: childReference(group) },
    check: checkRootAccepted,
    resume: {
      run() {
        event('preview-uncertain');
        throw new Error('Preview delivery is uncertain; this experimental policy refuses to emit again');
      },
    },
  });
  const previewed = checkpointPoint()({
    name: 'previewed',
    state: codec,
    references: { child: childReference(group) },
    check: checkRootAccepted,
    resume: {
      run(work, _state, refs) {
        event('scene-resume', { point: 'previewed' });
        return observe(work, work.children.facts.accepted(refs.child, receivedGroup));
      },
    },
  });
  const scene = new Scene({
    output,
    checkpoint: { key: keys.scene, version: 1, input: codec, output: codec, points: [rootWaiting, rootAccepted, previewPending, previewed], receptions: [receivedGroup] },
    run(work) {
      event('scene-body', { input: work.input });
      const handle = work.children.create(group, work.input);
      work.checkpoint({ point: rootWaiting, state: null, refs: { child: handle.ref } });
      return receiveGroup(work, handle);
    },
  }).add(group);
  const resources = new Resources();
  resources.register(new Resource(study.content.transcript), TranscriptResource.append);
  resources.register(new Resource(null), generate);
  resources
    .capture(group, (input) => {
      event('capture', { material: input.material });
      return input.material;
    })
    .register(materials, (material) => material);
  const checkpoints = {
    read: (id) => study.store.checkpoints.read(id),
    save(image, revision) {
      const receipt = study.store.checkpoints.save(image, revision);
      event('save', { contextId: image.frame.owner.contextId, contract: image.contract.key, point: image.point });
      return receipt;
    },
    finish(id, revision, delivery) {
      const contract = study.store.checkpoints.read(id).image.contract.key;
      const receipt = study.store.checkpoints.finish(id, revision, delivery);
      event('finish', { contextId: id, contract, status: delivery.status });
      if (contract === keys.node) {
        cut('child-finish');
        if (options.fault === 'child-finish-ack') throw new Error('child finish committed but receipt unavailable');
      }
      return receipt;
    },
  };
  runner = new Runner(scene, resources, undefined, {
    checkpoints: {
      store: checkpoints,
      observation: {
        failure: 'propagate',
        observe(fact) {
          if (options.fault === 'strict-checkpoint' && fact.kind === 'activity') throw new Error('strict restored activity failed');
        },
      },
    },
    observations: [
      {
        failure: 'propagate',
        bindInvocation: () => ({
          observe(fact) {
            if (fact.kind === 'relation' && fact.change.kind === 'returned') event('returned', { contextId: fact.identity.contextId, relation: fact.relation, result: fact.change.result });
          },
          business(fact) {
            event('business-observed', { fact });
            if (options.fault === 'strict-observation') throw new Error('strict business observer failed');
          },
        }),
      },
    ],
  }).build();
  runner.output.subscribe({
    receive(value) {
      event('output', { value });
    },
  });
  runner.observation.subscribe({
    receive(value) {
      if (value.source === 'entry') event('entry', { entryId: value.entryId, fact: value.fact });
      if (value.source === 'checkpoint' && ['checking', 'installed', 'continued', 'child-restored', 'activity', 'resource'].includes(value.fact.kind)) event('recovery-event', { entryId: value.entryId, fact: value.fact });
    },
  });
  return {
    runner,
    async probeClosed() {
      for (const endpoint of heldEndpoints) {
        try {
          await (endpoint.read ? endpoint.read(null) : endpoint.generate({ query: 'late', material: { text: 'late' } }));
          event('stale-endpoint-allowed');
        } catch (error) {
          event('stale-endpoint-rejected', { message: error.message, code: error.code });
        }
      }
    },
  };
}
