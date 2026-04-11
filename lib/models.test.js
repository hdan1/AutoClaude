const test = require('node:test');
const assert = require('node:assert/strict');

const http = require('http');

const { fetchModels, extractModelsFromError } = require('./models');

test('extractModelsFromError parses only model IDs from API 403 message', () => {
  const msg = 'API 403: {"error":{"message":"Model \'as\' is not available. Available models: mmodel, claude-opus-4-6, claude-opus-4.6","type":"invalid_request_error"}}';
  const models = extractModelsFromError(msg);

  assert.deepEqual(models.map(m => m.id), [
    'mmodel',
    'claude-opus-4-6',
    'claude-opus-4.6',
  ]);
});

test('extractModelsFromError returns empty list when message has no model list', () => {
  const models = extractModelsFromError('API 401: Unauthorized');
  assert.equal(models.length, 0);
});

test('extractModelsFromError ignores trailing explanatory prose', () => {
  const msg = 'API 403: {"error":{"message":"Model is unavailable. Available models: mmodel, claude-opus-4-6 please use latest","type":"invalid_request_error"}}';
  const models = extractModelsFromError(msg);

  assert.deepEqual(models.map(m => m.id), [
    'mmodel',
    'claude-opus-4-6',
  ]);
});

test('fetchModels falls back to model names from API error response when /v1/models is unavailable', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>not found</body></html>');
      return;
    }

    if (req.method === 'POST' && req.url === '/v1/messages') {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: "Model 'asd' is not available. Available models: mmodel, claude-opus-4-6, claude-opus-4.6",
          type: 'invalid_request_error',
        },
      }));
      return;
    }

    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'unexpected request' }));
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', (err) => (err ? reject(err) : resolve()));
  });

  t.after(() => server.close());

  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalBaseUrl = process.env.ANTHROPIC_BASE_URL;

  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${server.address().port}`;

  t.after(() => {
    if (originalKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalKey;

    if (originalBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = originalBaseUrl;
  });

  const result = await fetchModels(true);

  assert.deepEqual(result.models.map(m => m.id), [
    'mmodel',
    'claude-opus-4-6',
    'claude-opus-4.6',
  ]);
});
