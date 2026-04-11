const test = require('node:test');
const assert = require('node:assert/strict');
const summarize = require('./summarize');

test('summarize Bash returns command', () => { assert.equal(summarize('Bash', { command: 'npm test' }), '$ npm test'); });
test('summarize Read returns path', () => { assert.equal(summarize('Read', { file_path: '/src/index.js' }), '/src/index.js'); });
test('summarize Write returns path', () => { assert.equal(summarize('Write', { file_path: '/out.txt' }), '/out.txt'); });
test('summarize Edit returns path', () => { assert.equal(summarize('Edit', { file_path: '/foo.js' }), '/foo.js'); });
test('summarize Grep returns pattern', () => { assert.equal(summarize('Grep', { pattern: 'TODO' }), '"TODO"'); });
test('summarize Glob returns pattern', () => { assert.equal(summarize('Glob', { pattern: '**/*.js' }), '**/*.js'); });
test('summarize null input', () => { assert.equal(summarize('Bash', null), ''); });
test('summarize fallback to first string', () => { assert.equal(summarize('Custom', { n: 42, s: 'hello' }), 'hello'); });
test('summarize truncates long commands', () => { assert.ok(summarize('Bash', { command: 'x'.repeat(200) }).length <= 122); });
test('summarize WebFetch returns url', () => { assert.equal(summarize('WebFetch', { url: 'https://example.com' }), 'https://example.com'); });
