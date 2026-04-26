'use strict';

const { makeUpdateErrorStatus, makeUpdateProgressStatus } = require('./operations-status');

function toRendererUpdateStatus(event = {}) {
  if (event.type === 'error') {
    return {
      status: 'error',
      ...makeUpdateErrorStatus({ summary: event.summary, detail: event.detail }),
    };
  }

  if (event.type === 'downloading' || event.type === 'ready') {
    return {
      status: event.type,
      ...makeUpdateProgressStatus(event.type, { version: event.version }),
    };
  }

  return {
    status: 'info',
    severity: 'info',
    scope: 'update',
    summary: 'Update status',
    details: '',
    nextSteps: [],
    meta: {},
  };
}

module.exports = {
  toRendererUpdateStatus,
};
