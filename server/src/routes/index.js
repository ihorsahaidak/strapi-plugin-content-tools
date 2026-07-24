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
        method: 'POST',
        path: '/export',
        handler: 'transfer.exportEntities',
        config: { policies: [] },
      },
      {
        method: 'POST',
        path: '/import',
        handler: 'transfer.importEntities',
        config: { policies: [] },
      },
    ],
  },
};
