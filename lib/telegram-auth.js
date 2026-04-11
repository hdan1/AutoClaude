// lib/telegram-auth.js — Shared Telegram auth logic (5D)
const fs = require('fs');
const logger = require('./logger');

/**
 * Check if a user is authorized.
 * @param {string|null} username
 * @param {number} numericId
 * @param {string[]} allowedUsers - list of usernames or numeric ID strings
 * @returns {boolean}
 */
function isAuthorized(username, numericId, allowedUsers) {
  if (!allowedUsers || allowedUsers.length === 0) return true;
  const key = username || String(numericId);
  return allowedUsers.includes(key) || allowedUsers.includes(String(numericId));
}

/**
 * Persist chat IDs to a JSON file.
 * @param {string} filePath
 * @param {Map<string, number>} chatIds
 */
function persistChatIds(filePath, chatIds) {
  try {
    const obj = {};
    for (const [k, v] of chatIds) obj[k] = v;
    fs.writeFileSync(filePath, JSON.stringify(obj), 'utf8');
  } catch (e) {
    logger.debug('telegram-auth', `Failed to persist chat IDs: ${e.message}`);
  }
}

/**
 * Load chat IDs from a JSON file.
 * @param {string} filePath
 * @returns {Map<string, number>}
 */
function loadChatIds(filePath) {
  const map = new Map();
  try {
    if (!fs.existsSync(filePath)) return map;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    for (const [k, v] of Object.entries(data)) map.set(k, v);
  } catch (e) {
    logger.debug('telegram-auth', `Failed to load chat IDs: ${e.message}`);
  }
  return map;
}

module.exports = { isAuthorized, persistChatIds, loadChatIds };
