// lib/telegram-secure.js -- Secure bot token storage using Electron safeStorage
const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./logger');

const SESSION_TOKEN_FILE = 'tg-token.enc';
const MASTER_TOKEN_FILE = 'tg-master-token.enc';
const CUSTOM_PROVIDER_TOKEN_FILE = 'anthropic-provider-token.enc';

function saveEncryptedToken(userDataPath, plainToken, fileName) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const encrypted = safeStorage.encryptString(plainToken);
  fs.writeFileSync(path.join(userDataPath, fileName), encrypted);
  return true;
}

function loadEncryptedToken(userDataPath, fileName) {
  try {
    const p = path.join(userDataPath, fileName);
    if (!fs.existsSync(p)) return null;
    const encrypted = fs.readFileSync(p);
    return safeStorage.decryptString(encrypted);
  } catch(e) {
    if (e.code !== 'ENOENT') {
      logger.warn('telegram-secure', `Failed to load token ${fileName}: ${e.message}`);
    }
    return null;
  }
}

function clearEncryptedToken(userDataPath, fileName) {
  try {
    const p = path.join(userDataPath, fileName);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch(e) {
    if (e.code !== 'ENOENT') {
      logger.warn('telegram-secure', `Failed to clear token ${fileName}: ${e.message}`);
    }
  }
}

function saveToken(userDataPath, plainToken) {
  return saveEncryptedToken(userDataPath, plainToken, SESSION_TOKEN_FILE);
}

function loadToken(userDataPath) {
  return loadEncryptedToken(userDataPath, SESSION_TOKEN_FILE);
}

function deleteToken(userDataPath) {
  clearEncryptedToken(userDataPath, SESSION_TOKEN_FILE);
}

function saveMasterTelegramToken(userDataPath, token) {
  return saveEncryptedToken(userDataPath, token, MASTER_TOKEN_FILE);
}

function loadMasterTelegramToken(userDataPath) {
  return loadEncryptedToken(userDataPath, MASTER_TOKEN_FILE);
}

function clearMasterTelegramToken(userDataPath) {
  clearEncryptedToken(userDataPath, MASTER_TOKEN_FILE);
}

function projectTokenFileName(projectDir) {
  const hash = crypto.createHash('md5').update(path.resolve(projectDir)).digest('hex').slice(0, 12);
  return `tg-project-${hash}.enc`;
}

function saveProjectToken(userDataPath, projectDir, plainToken) {
  return saveEncryptedToken(userDataPath, plainToken, projectTokenFileName(projectDir));
}

function loadProjectToken(userDataPath, projectDir) {
  return loadEncryptedToken(userDataPath, projectTokenFileName(projectDir));
}

function clearProjectToken(userDataPath, projectDir) {
  clearEncryptedToken(userDataPath, projectTokenFileName(projectDir));
}

function saveCustomProviderToken(userDataPath, token) {
  return saveEncryptedToken(userDataPath, token, CUSTOM_PROVIDER_TOKEN_FILE);
}

function loadCustomProviderToken(userDataPath) {
  return loadEncryptedToken(userDataPath, CUSTOM_PROVIDER_TOKEN_FILE);
}

function clearCustomProviderToken(userDataPath) {
  clearEncryptedToken(userDataPath, CUSTOM_PROVIDER_TOKEN_FILE);
}

function isEncryptionAvailable() {
  return safeStorage.isEncryptionAvailable();
}

module.exports = {
  saveToken,
  loadToken,
  deleteToken,
  saveMasterTelegramToken,
  loadMasterTelegramToken,
  clearMasterTelegramToken,
  saveProjectToken,
  loadProjectToken,
  clearProjectToken,
  saveCustomProviderToken,
  loadCustomProviderToken,
  clearCustomProviderToken,
  isEncryptionAvailable,
};
