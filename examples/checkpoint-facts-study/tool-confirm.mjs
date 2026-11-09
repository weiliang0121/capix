import { isDeepStrictEqual as equal } from 'node:util';
import { feedbackDigest } from '@weiliang0121/capix-model-exchanges';
import { modelReplyText } from '@weiliang0121/capix-model-provider';
import { assertToolFeedbackBytes, assertToolOutputBytes, assertToolReplyBytes } from '@capix/conversation-service/tools';
import { ToolRelations } from './tool-relations.mjs';

/**
 * Indexed counterpart of ToolLoop's completed.resume confirmation, using its
 * public declaration/reception/selection contracts and the real exchange entity.
 * It runs after relation authentication and point.check, not instead of them.
 * Cold rebuilding and full durable exchange confirmation remain O(history).
 */
export function indexedToolConfirm(fixture, snapshot, { resource, stats = {} } = {}) {
  const count = (key, amount = 1) => (stats[key] = (stats[key] ?? 0) + amount);
  const facts = fixture.facts(snapshot).children;
  const definitions = new Map(fixture.loop.checkpoint.receptions.map((item) => [item.child, item]));
  const modelReception = definitions.get(fixture.definitions.model);
  const exchanges = resource ? null : fixture.restoreExchanges(snapshot);
  const access = resource ?? { read: (reference) => exchanges.read(snapshot.input.scope, reference, false), closed: (references) => exchanges.closed(snapshot.input.scope, references) };
  const read = (reference) => {
    count('entityReads');
    return access.read(reference);
  };
  const records = new Map();
  const normalized = [];
  for (const record of snapshot.records) {
    records.set(record.identity.contextId, record);
    normalized.push({ ...record, identity: { ...record.identity, position: String(record.identity.position), contract: contractKey(record.identity.contract) } });
    count('indexRebuildRecords');
  }
  const index = new ToolRelations(normalized);
  // Preserve the first occurrence in author-selected order. Duplicate refs do
  // not change .find's first match; removing a ref does not remove the ledger.
  const ranks = new Map();
  for (const [slot, references] of Object.entries(snapshot.refs)) {
    const rank = new Map();
    for (let offset = 0; offset < references.length; offset++) {
      const child = facts.get(references[offset]);
      if (!rank.has(child.identity.contextId)) rank.set(child.identity.contextId, offset);
      count('rankReferences');
    }
    ranks.set(slot, rank);
  }
  const models = snapshot.refs.models;
  if (!models) throw new Error('Tool checkpoint references an unknown member');
  try {
    access.closed(snapshot.state.exchanges);
    count('closedPrefixes');
    for (let modelIndex = 0; modelIndex < models.length; modelIndex++) {
      const fact = facts.require(fixture.definitions.model, models[modelIndex]);
      count('modelRelations');
      if (fact.reception.status !== 'accepted') continue;
      const receipt = facts.accepted(fact.ref, modelReception);
      const entry = read(receipt.reference);
      assertToolReplyBytes(entry.reply, fixture.loop.budgets);
      if (fact.returned?.status !== 'succeeded' || !equal(entry.reply, fact.returned.output) || !equal(entry.operation, receipt.operation)) throw new Error('Exchange differs from original model return or reception');
      const next = models[modelIndex + 1];
      const end = next ? facts.get(next).order : Infinity;
      const originalCalls = new Map();
      for (const item of entry.reply.output) {
        if (item.kind === 'tool-call' && !originalCalls.has(item.id)) originalCalls.set(item.id, item);
        count('replyItemsIndexed');
      }
      const receptions = new Map();
      for (const item of entry.receptions) {
        if (!receptions.has(item.callId)) receptions.set(item.callId, item);
        count('receptionsIndexed');
      }
      for (const feedback of entry.feedback) {
        count('feedbackItems');
        assertToolFeedbackBytes(feedback.toolCallId, { status: feedback.status, content: feedback.content }, fixture.loop.budgets);
        const call = originalCalls.get(feedback.toolCallId);
        count('originalCallLookups');
        if (!call) throw new Error('Feedback has no original model call');
        const selected = fixture.loop.checkToolCall(call);
        if (selected.kind === 'rejected') {
          if (!equal(feedback, { toolCallId: call.id, ...selected.result })) throw new Error('Precheck feedback differs from fixed policy');
          continue;
        }
        const rank = ranks.get(selected.entry.name);
        if (!rank) throw new Error('Tool checkpoint references an unknown member');
        const candidates = index.query({ parentId: snapshot.parentId, position: String(selected.entry.position), contract: contractKey(selected.entry.registration.node.checkpoint), key: call.id, after: fact.order, before: end });
        let child;
        let firstRank = Infinity;
        for (const candidate of candidates) {
          const position = rank.get(candidate.identity.contextId);
          if (position === undefined || position >= firstRank) continue;
          count('inputComparisons');
          if (!equal(candidate.input, selected.input)) continue;
          firstRank = position;
          child = records.get(candidate.identity.contextId);
        }
        if (!child) throw new Error('Feedback has no exact tool child');
        if (child.returned?.status === 'succeeded' && selected.entry.registration.maxOutputBytes !== undefined) assertToolOutputBytes(child.returned.output, selected.entry.registration.maxOutputBytes);
        // Persisted feedback may precede the parent CP's acceptance fact. This
        // window is already allowed by production and must not be tightened.
        if (child.reception.status !== 'accepted' && child.reception.status !== 'handled') continue;
        const reception = definitions.get(selected.entry.registration.node);
        const prior = child.reception.status === 'accepted' ? facts.accepted(child.ref, reception) : facts.handled(child.ref, reception);
        count('receptionLookups');
        if (prior.reference.collection !== receipt.reference.collection || prior.reference.id !== receipt.reference.id || prior.feedbackDigest !== feedbackDigest(feedback) || !equal(prior.operation, receptions.get(call.id)?.operation)) throw new Error('Feedback differs from original tool reception');
      }
    }
    if (!snapshot.state.current) throw new Error('Missing final model exchange');
    const reply = read(snapshot.state.current).reply;
    if (reply.termination.kind !== 'completed') throw new Error('Incomplete model reply cannot finish ToolLoop');
    const text = modelReplyText(reply);
    if (!text.trim()) throw new Error('ToolLoop final answer is empty');
    return text;
  } finally {
    count('lookupQueries', index.stats.queries);
    count('lookupComparisons', index.stats.queryComparisons);
    count('lookupCandidates', index.stats.queryCandidates);
  }
}

function contractKey(contract) {
  return JSON.stringify([contract.key, contract.version]);
}
