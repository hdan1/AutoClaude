const test = require('node:test');
const assert = require('node:assert/strict');

test('SETTINGS_SCHEMA includes gsd.enabled', () => {
  const { SETTINGS_SCHEMA } = require('../settings-db');
  assert.ok(SETTINGS_SCHEMA['gsd.enabled'], 'gsd.enabled should exist in schema');
  assert.equal(SETTINGS_SCHEMA['gsd.enabled'].category, 'gsd');
  assert.equal(SETTINGS_SCHEMA['gsd.enabled'].type, 'toggle');
  assert.equal(SETTINGS_SCHEMA['gsd.enabled'].default, true);
});

test('SETTINGS_SCHEMA includes all 6 GSD settings', () => {
  const { SETTINGS_SCHEMA } = require('../settings-db');
  const gsdKeys = Object.keys(SETTINGS_SCHEMA).filter(k => k.startsWith('gsd.'));
  assert.equal(gsdKeys.length, 6);
  assert.ok(SETTINGS_SCHEMA['gsd.autoNext']);
  assert.ok(SETTINGS_SCHEMA['gsd.derailmentCorrection']);
  assert.ok(SETTINGS_SCHEMA['gsd.maxPhaseRetries']);
  assert.ok(SETTINGS_SCHEMA['gsd.autoContinueDelaySecs']);
  assert.ok(SETTINGS_SCHEMA['gsd.phaseTimeoutMinutes']);
});

test('CATEGORY_ORDER includes gsd after superpowers', () => {
  const { CATEGORY_ORDER } = require('../settings-db');
  const spIdx = CATEGORY_ORDER.findIndex(c => c.key === 'superpowers');
  const gsdIdx = CATEGORY_ORDER.findIndex(c => c.key === 'gsd');
  assert.ok(gsdIdx > 0, 'gsd category should exist');
  assert.ok(gsdIdx > spIdx, 'gsd should come after superpowers');
  assert.equal(CATEGORY_ORDER[gsdIdx].icon, '\u{1F680}');
});
