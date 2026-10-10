import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSettings } from '@capix/observer-service';

const settings = { model: 'deepseek-flash', contextBudget: 32768, maxOutputTokens: 1536, timeoutMs: 10000 };

test('configuration acceptance preserves bounds and known-field copying without coercion', () => {
  const source = { ...settings, ignored: 'not part of the configuration' };
  const accepted = validateSettings(source);
  assert.deepEqual(accepted, settings);
  assert.notEqual(accepted, source);
  assert.equal(source.ignored, 'not part of the configuration');
  for (const [field, min, max] of [
    ['contextBudget', 256, 1000000],
    ['maxOutputTokens', 64, 8192],
    ['timeoutMs', 1000, 180000],
  ]) {
    for (const value of [min, max]) assert.equal(validateSettings({ ...settings, [field]: value })[field], value);
    for (const value of [min - 1, max + 1, min + 0.5, String(min), null, undefined, NaN, Infinity]) {
      assert.throws(
        () => validateSettings({ ...settings, [field]: value }),
        (error) => error.code === 'INVALID_SETTINGS' && error.detail.issues.some((issue) => issue.path.join('.') === field),
      );
    }
  }
});

test('configuration rejects missing fields and invalid model identities', () => {
  for (const value of [null, [], {}, { ...settings, model: '' }, { ...settings, model: 'model with spaces' }, { ...settings, model: 'x'.repeat(101) }, { ...settings, model: 1 }]) {
    assert.throws(
      () => validateSettings(value),
      (error) => error.code === 'INVALID_SETTINGS',
    );
  }
  assert.equal(validateSettings({ ...settings, model: 'x'.repeat(100) }).model.length, 100);
});
