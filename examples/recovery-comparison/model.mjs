import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Deliberately restricted laboratory: acyclic JSON values, a single writer and
// a serial coordinator. This is not the production CheckpointStore/Invocation.
export function fixed(value) {
  const body = JSON.stringify(value);
  assert.notEqual(body, undefined, 'Expected JSON data');
  const result = JSON.parse(body);
  assert.deepEqual(result, value, 'Only lossless JSON values are supported');
  const freeze = (item) => {
    if (item && typeof item === 'object') {
      for (const child of Object.values(item)) freeze(child);
      Object.freeze(item);
    }
    return item;
  };
  return freeze(result);
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class Refusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'Refusal';
  }
}

export class Journal {
  #db;
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.#db = new DatabaseSync(join(directory, 'workflow.sqlite'));
    this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS head (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS commands (ordinal INTEGER PRIMARY KEY, body TEXT NOT NULL, digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS metrics (name TEXT PRIMARY KEY, value INTEGER NOT NULL)');
  }

  bump(name, count = 1) {
    this.#db.prepare('INSERT INTO metrics VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value').run(name, count);
  }

  #write(table, id, value) {
    const body = JSON.stringify(fixed(value));
    const column = table === 'head' ? 'id' : 'ordinal';
    this.#db.prepare(`INSERT INTO ${table} VALUES (?,?,?) ON CONFLICT(${column}) DO UPDATE SET body=excluded.body,digest=excluded.digest`).run(id, body, digest(value));
    this.bump('workflowCommits');
    this.bump('workflowBytes', Buffer.byteLength(body));
  }

  #decode(row) {
    if (!row) return null;
    const value = JSON.parse(row.body);
    assert.equal(row.digest, digest(value), 'Durable fact digest mismatch');
    return fixed(value);
  }

  #atomic(write) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      write();
      this.#db.exec('COMMIT');
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  get head() {
    return this.#decode(this.#db.prepare('SELECT body,digest FROM head WHERE id=1').get());
  }

  create(mode, input, policyVersion) {
    assert.equal(this.head, null, 'Run already exists');
    const head = { id: randomUUID(), mode, policyVersion, input: fixed(input), commandCount: 0, point: 'read', locals: {}, status: 'active', result: null };
    this.#write('head', 1, head);
    return this.head;
  }

  advance(point, locals) {
    const head = this.head;
    assert.equal(head.status, 'active', 'Terminal call cannot advance');
    this.#write('head', 1, { ...head, point, locals: fixed(locals) });
    this.bump('checkpointWrites');
  }

  terminal(status, result = null) {
    assert.ok(['succeeded', 'failed', 'cancelled'].includes(status));
    const head = this.head;
    assert.ok(head, 'Missing original input');
    assert.equal(head.status, 'active', 'Terminal call cannot advance');
    this.#write('head', 1, { ...head, status, result: fixed(result) });
  }

  command(ordinal) {
    this.bump('commandReads');
    return this.#decode(this.#db.prepare('SELECT body,digest FROM commands WHERE ordinal=?').get(ordinal));
  }

  commands() {
    return this.#db
      .prepare('SELECT body,digest FROM commands ORDER BY ordinal')
      .all()
      .map((row) => this.#decode(row));
  }

  // Cold verification is intentionally full-history. It is not a bounded cold
  // recovery proposal; these counters are kept separate from replay matching.
  validate(checkPolicy) {
    const head = this.head;
    if (!head) throw new Refusal('Missing original input/head');
    const commands = this.commands();
    assert.equal(commands.length, head.commandCount, 'Command history suffix missing or unanchored');
    for (const [index, command] of commands.entries()) {
      assert.equal(command.ordinal, index + 1, 'Command history gap');
      assert.equal(command.owner, head.id, 'Foreign command owner');
      assert.equal(command.policyVersion, head.policyVersion, 'Changed policy');
      if (index > 0) assert.notEqual(commands[index - 1].outcome, null, 'Dispatched beyond unresolved command');
      if (command.kind === 'child' && command.outcome) {
        assert.equal(command.outcome.childId, command.id, 'Child delivery identity mismatch');
        assert.ok(['succeeded', 'failed'].includes(command.outcome.returned.status), 'Invalid child outcome');
      }
      if (command.kind === 'reception') {
        const child = commands[index - 1];
        assert.equal(child?.kind, 'child', 'Reception is not associated with a child');
        assert.deepEqual(command.input, child.outcome, 'Reception source changed');
        if (command.outcome) {
          assert.equal(command.outcome.childId, child.id, 'Foreign reception result');
          assert.equal(command.outcome.receipt, command.id, 'Foreign effect receipt');
          assert.equal(command.outcome.reception, child.outcome.returned.status === 'succeeded' ? 'accepted' : 'handled', 'Reception changed failure into success');
        }
      }
      this.bump('coldValidatedCommands');
    }
    // Application-specific checks are shared by both continuation strategies;
    // replay matching is not a substitute for authenticating skipped history.
    checkPolicy?.(head, commands);
    this.bump('coldPolicyChecks');
    return head;
  }

  intent(spec) {
    const head = this.head;
    assert.equal(head.status, 'active');
    const expected = fixed({ owner: head.id, policyVersion: head.policyVersion, ...spec });
    const old = this.command(spec.ordinal);
    if (old) {
      const { id, outcome, ...identity } = old;
      assert.deepEqual(identity, expected, 'Command identity/input/policy mismatch');
      this.bump('historicalMatches');
      return { command: old, fresh: false };
    }
    assert.equal(spec.ordinal, this.commands().length + 1, 'Command order mismatch');
    const command = { ...expected, id: randomUUID(), outcome: null };
    // Losing the command suffix must not look like permission to dispatch new
    // operations with new identities. Intent and its coverage anchor commit
    // together; this is local to the workflow DB, never a cross-world transaction.
    this.#atomic(() => {
      this.#write('commands', spec.ordinal, command);
      this.#write('head', 1, { ...head, commandCount: spec.ordinal });
    });
    this.bump('commandsIssued');
    return { command: this.command(spec.ordinal), fresh: true };
  }

  outcome(command, outcome) {
    const current = this.command(command.ordinal);
    assert.equal(current.id, command.id);
    const value = fixed(outcome);
    if (current.outcome !== null) assert.deepEqual(current.outcome, value, 'Outcome changed');
    else this.#write('commands', command.ordinal, { ...current, outcome: value });
    return value;
  }

  get metrics() {
    return Object.fromEntries(
      this.#db
        .prepare('SELECT name,value FROM metrics')
        .all()
        .map((row) => [row.name, row.value]),
    );
  }

  mutate(options) {
    if (options.deleteHead) this.#db.prepare('DELETE FROM head').run();
    if (options.deleteCommandsFrom !== undefined) this.#db.prepare('DELETE FROM commands WHERE ordinal >= ?').run(options.deleteCommandsFrom);
    if (options.command) {
      const { ordinal, field, value } = options.command;
      const command = this.command(ordinal);
      assert.ok(command);
      // This is deliberate test corruption. Recompute checksum to exercise
      // semantic matching rather than merely the byte-corruption detector.
      this.#write('commands', ordinal, { ...command, [field]: value });
    }
  }

  close() {
    this.#db.close();
  }
}

export class World {
  #db;
  constructor(directory) {
    this.#db = new DatabaseSync(join(directory, 'world.sqlite'));
    this.#db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS source (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS effects (id INTEGER PRIMARY KEY, kind TEXT NOT NULL); INSERT OR IGNORE INTO source VALUES(1,'original material')");
  }

  get source() {
    return this.#db.prepare('SELECT body FROM source WHERE id=1').get().body;
  }

  set source(value) {
    this.#db.prepare('UPDATE source SET body=? WHERE id=1').run(value);
  }

  count(kind) {
    this.#db.prepare('INSERT INTO effects(kind) VALUES (?)').run(kind);
  }

  receipt(id) {
    const row = this.#db.prepare('SELECT body FROM receipts WHERE id=?').get(id);
    return row ? fixed(JSON.parse(row.body)) : null;
  }

  exact(id, kind, input) {
    const receipt = this.receipt(id);
    if (!receipt) throw new Refusal(`Unknown ${kind} effect: exact receipt missing`);
    assert.equal(receipt.kind, kind, 'Effect kind mismatch');
    assert.deepEqual(receipt.input, input, 'Effect confirmation payload changed');
    return receipt;
  }

  // Effect and acknowledgment deliberately have a gap. The test process may
  // die after the effect; missing acknowledgment never licenses a repeat.
  execute(id, kind, input, result, cut) {
    assert.equal(this.receipt(id), null, 'Effect already has a receipt');
    this.count(kind);
    cut(`${kind}-executed-unconfirmed`);
    const receipt = fixed({ id, kind, input, result });
    this.#db.prepare('INSERT INTO receipts VALUES (?,?)').run(id, JSON.stringify(receipt));
    cut(`${kind}-effect`);
    return receipt;
  }

  mutate(options) {
    if (options.source !== undefined) this.source = options.source;
    if (options.deleteReceipt) {
      const entries = this.snapshot().receipts.filter((receipt) => receipt.kind === options.deleteReceipt);
      for (const receipt of entries) this.#db.prepare('DELETE FROM receipts WHERE id=?').run(receipt.id);
    }
  }

  snapshot() {
    return {
      source: this.source,
      counts: Object.fromEntries(
        this.#db
          .prepare('SELECT kind,count(*) AS n FROM effects GROUP BY kind')
          .all()
          .map((row) => [row.kind, row.n]),
      ),
      receipts: this.#db
        .prepare('SELECT body FROM receipts ORDER BY rowid')
        .all()
        .map((row) => JSON.parse(row.body)),
    };
  }

  close() {
    this.#db.close();
  }
}
