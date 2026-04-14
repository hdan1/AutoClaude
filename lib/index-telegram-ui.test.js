const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

test('telegram panel includes tgMasterNotify select with full/ping/off options', () => {
  assert.match(indexHtml, /<select[^>]*data-el="tgMasterNotify"[^>]*>/);
  assert.match(indexHtml, /<option\s+value="full">Full details<\/option>/);
  assert.match(indexHtml, /<option\s+value="ping">Ping only<\/option>/);
  assert.match(indexHtml, /<option\s+value="off">Off<\/option>/);
});

test('loadTelegramConfig wiring sets tgMasterNotify default to full', () => {
  assert.match(indexHtml, /tgMasterNotify=el\('tgMasterNotify'\)/);
  assert.match(indexHtml, /c\.masterNotifyMode==='full'\s*\|\|\s*c\.masterNotifyMode==='ping'\s*\|\|\s*c\.masterNotifyMode==='off'/);
  assert.match(indexHtml, /tgMasterNotify\.value\s*=\s*loadedMasterNotifyMode/);
});

test('saveTelegramConfig wiring includes masterNotifyMode in payload', () => {
  assert.match(indexHtml, /masterNotifyMode\s*:\s*tgMasterNotify\.value/);
});
