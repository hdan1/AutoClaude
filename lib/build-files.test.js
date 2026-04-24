const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const buildFiles = packageJson.build?.files || [];

test('electron build includes renderer assets referenced by index.html', () => {
  const referencedRendererScripts = Array.from(indexHtml.matchAll(/<script\s+src="(renderer\/[^"]+\.js)"><\/script>/g)).map(m => m[1]);
  assert.ok(referencedRendererScripts.length > 0, 'expected renderer scripts to be referenced by index.html');
  assert.ok(
    buildFiles.some(entry => entry === 'renderer/**/*' || entry === 'renderer/**' || entry === 'renderer/*' || entry === 'renderer/*.js'),
    `build.files must include renderer assets; index.html references: ${referencedRendererScripts.join(', ')}`,
  );
});
