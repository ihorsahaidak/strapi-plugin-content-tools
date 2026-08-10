'use strict';

/**
 * Admin-type routes are mounted under `/content-tools` and require an
 * authenticated admin user (same session the Content Manager uses).
 */
module.exports = {
  admin: {
    type: 'admin',
    routes: [
      {
        method: 'POST',
        path: '/move-locale',
        handler: 'move-locale.moveOne',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/move-locale-many',
        handler: 'move-locale.moveMany',
        config: { policies: [] },
      },
      {
        method: 'GET',
        path: '/merge-candidates',
        handler: 'move-locale.mergeCandidates',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/merge-locale',
        handler: 'move-locale.mergeLocale',
        config: { policies: [] },
      },
      {
        method: 'GET',
        path: '/config',
        handler: 'config.find',
        config: { policies: [] },
      },
      {
        method: 'PUT',
        path: '/config',
        handler: 'config.update',
        config: { policies: [] },
      },
      {
        method: 'GET',
        path: '/schema',
        handler: 'config.schema',
        config: { policies: [] },
      },
      {
        method: 'GET',
        path: '/data-transfer/targets',
        handler: 'data-transfer.targets',
        config: { policies: [] },
      },
      {
        method: 'PUT',
        path: '/data-transfer/targets',
        handler: 'data-transfer.saveTargets',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/data-transfer/pull',
        handler: 'data-transfer.pull',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/data-transfer/stop',
        handler: 'data-transfer.stop',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/data-transfer/probe',
        handler: 'data-transfer.probe',
        config: { policies: [] },
      },
      {
        method: 'GET',
        path: '/data-transfer/backups',
        handler: 'data-transfer.backups',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/data-transfer/restore-backup',
        handler: 'data-transfer.restoreBackup',
        config: { policies: [] },
      },
      {
        method: 'GET',
        path: '/data-transfer/status',
        handler: 'data-transfer.status',
        config: { policies: [] },
      },
    ],
  },
};
