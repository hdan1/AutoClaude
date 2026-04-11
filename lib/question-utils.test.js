const test = require('node:test');
const assert = require('node:assert/strict');
const { extractQuestions } = require('./question-utils');

test('extractQuestions returns questions array when present', () => {
  const data = { questions: [{ question: 'a' }, { question: 'b' }] };
  assert.deepEqual(extractQuestions(data), [{ question: 'a' }, { question: 'b' }]);
});

test('extractQuestions wraps single question into array', () => {
  const data = { question: 'hello?' };
  assert.deepEqual(extractQuestions(data), [{ question: 'hello?' }]);
});

test('extractQuestions returns empty for no question fields', () => {
  assert.deepEqual(extractQuestions({ foo: 'bar' }), []);
});

test('extractQuestions returns empty for null', () => {
  assert.deepEqual(extractQuestions(null), []);
});

test('extractQuestions returns empty for undefined', () => {
  assert.deepEqual(extractQuestions(undefined), []);
});

test('extractQuestions returns empty for empty object', () => {
  assert.deepEqual(extractQuestions({}), []);
});
