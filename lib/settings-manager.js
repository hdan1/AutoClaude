// lib/settings-manager.js — Settings & tags management extracted from claude-detector.js (5A)
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const { getClaudeHome } = require('./claude-detection');

function readSettingsJson(scope, projectDir) {
  const filePath = scope === 'project' && projectDir
    ? path.join(projectDir, '.claude', 'settings.json')
    : path.join(getClaudeHome(), 'settings.json');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, path: filePath };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `readSettingsJson failed: ${err.message}`);
    return { content: '{\n}', path: filePath };
  }
}

function writeSettingsJson(scope, projectDir, content) {
  const filePath = scope === 'project' && projectDir
    ? path.join(projectDir, '.claude', 'settings.json')
    : path.join(getClaudeHome(), 'settings.json');
  // Validate JSON before writing
  JSON.parse(content); // throws if invalid
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
}

function getTagsDir() {
  return path.join(getClaudeHome(), 'settings-tags');
}

function validateTagName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 50) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function listSettingsTags() {
  const dir = getTagsDir();
  const tags = [];
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace(/\.json$/, '');
      tags.push({ name, path: path.join(dir, f) });
    }
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `listSettingsTags read failed: ${err.message}`);
  }
  tags.sort((a, b) => a.name.localeCompare(b.name));
  return { tags };
}

function loadSettingsTag(name) {
  if (!validateTagName(name)) return { content: '{\n}', path: '', error: 'Invalid tag name' };
  const filePath = path.join(getTagsDir(), name + '.json');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, path: filePath };
  } catch (err) {
    if (err.code !== 'ENOENT') logger.warn('claude-detector', `loadSettingsTag read failed: ${err.message}`);
    return { content: '{\n}', path: filePath, error: 'Tag not found' };
  }
}

function saveSettingsTag(name, content) {
  if (!validateTagName(name)) throw new Error('Invalid tag name: alphanumeric, hyphens, underscores only, max 50 chars');
  JSON.parse(content); // throws if invalid JSON
  const dir = getTagsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name + '.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
}

function deleteSettingsTag(name) {
  if (!validateTagName(name)) throw new Error('Invalid tag name');
  const filePath = path.join(getTagsDir(), name + '.json');
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if (err.code === 'ENOENT') throw new Error('Tag not found');
    throw err;
  }
  return { ok: true };
}

module.exports = {
  readSettingsJson,
  writeSettingsJson,
  getTagsDir,
  validateTagName,
  listSettingsTags,
  loadSettingsTag,
  saveSettingsTag,
  deleteSettingsTag,
};
