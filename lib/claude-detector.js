// lib/claude-detector.js — Backward-compatible re-export facade (5A)
// After decomposition, consumers should import from the specific module directly.
const detection = require('./claude-detection');
const plugins = require('./plugin-manager');
const settings = require('./settings-manager');
const updates = require('./update-checker');

module.exports = {
  ...detection,
  ...plugins,
  ...settings,
  ...updates,
};
