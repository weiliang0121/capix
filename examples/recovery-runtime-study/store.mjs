import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ConversationStore } from '@capix/conversation-service/persistence';
import { loadConversationContent } from '@capix/conversation-service/assembly';

export const keys = { scene: 'study.runtime.scene', group: 'study.runtime.group', node: 'study.runtime.node' };

// The diagnostic ledger observes executions. Recovery never consumes its events.
export function openStudy(directory, options) {
  mkdirSync(directory, { recursive: true });
  const store = ConversationStore.open(join(directory, 'content.sqlite'));
  const ledger = new DatabaseSync(join(directory, 'diagnostics.sqlite'));
  ledger.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL) STRICT; CREATE TABLE IF NOT EXISTS source (id INTEGER PRIMARY KEY, body TEXT NOT NULL) STRICT;');
  ledger.prepare('INSERT OR IGNORE INTO source VALUES (1, ?)').run(JSON.stringify({ revision: 1, text: 'original material' }));
  if (options.source) ledger.prepare('UPDATE source SET body = ? WHERE id = 1').run(JSON.stringify(options.source));
  const event = (kind, body = {}) => ledger.prepare('INSERT INTO events (kind, body) VALUES (?, ?)').run(kind, JSON.stringify(body));
  const persistence = {
    load: () => store.load(),
    initialize: (state) => store.initialize(state),
    assertAvailable: () => store.assertAvailable(),
    transcript: {
      commit(change) {
        store.transcript.commit(change);
        event('entity-commit');
      },
    },
    memories: store.memories,
    view: store.view,
  };
  const content = loadConversationContent(persistence);
  const heads = () => {
    const found = {};
    const visit = (head) => {
      if (!head) return;
      const kind = Object.keys(keys).find((name) => keys[name] === head.image.contract.key);
      if (kind) found[kind] = head;
      for (const child of head.image.frame.children) visit(store.checkpoints.read(child.identity.contextId));
    };
    for (const head of store.checkpoints.listRoots()) visit(head);
    return found;
  };
  const report = (extra = {}) => ({
    ...extra,
    source: JSON.parse(ledger.prepare('SELECT body FROM source WHERE id = 1').get().body),
    transcript: content.transcript.exportState(),
    heads: heads(),
    events: ledger
      .prepare('SELECT seq, kind, body FROM events ORDER BY seq')
      .all()
      .map((row) => ({ seq: row.seq, kind: row.kind, ...JSON.parse(row.body) })),
  });
  return {
    store,
    content,
    event,
    heads,
    report,
    source: () => JSON.parse(ledger.prepare('SELECT body FROM source WHERE id = 1').get().body),
    close() {
      store.close();
      ledger.close();
    },
  };
}
