'use strict';

const service = (strapi) => strapi.plugin('content-tools').service('data-transfer');

function sendError(strapi, ctx, err) {
  const status = err && err.status ? err.status : 500;
  ctx.status = status;
  ctx.body = {
    error: {
      status,
      name: (err && err.name) || 'InternalServerError',
      message: (err && err.message) || 'Something went wrong',
    },
  };
  if (status >= 500) {
    strapi.log.error(`[content-tools] data-transfer: ${err && err.stack ? err.stack : err}`);
  }
}

module.exports = ({ strapi }) => ({
  // GET /content-tools/data-transfer/targets
  async targets(ctx) {
    ctx.body = await service(strapi).listTargets();
  },

  // PUT /content-tools/data-transfer/targets  { targets: [...] }
  async saveTargets(ctx) {
    try {
      ctx.body = await service(strapi).saveTargets((ctx.request.body || {}).targets);
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/data-transfer/pull  { targetId, skipMedia, skipBackup }
  async pull(ctx) {
    try {
      const body = ctx.request.body || {};
      ctx.body = await service(strapi).pull({
        targetId: body.targetId,
        skipMedia: !!body.skipMedia,
        skipBackup: !!body.skipBackup,
      });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/data-transfer/stop  { rollback }
  async stop(ctx) {
    try {
      ctx.body = await service(strapi).stop({ rollback: !!(ctx.request.body || {}).rollback });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/data-transfer/probe  { targetId }  — fast pre-flight test
  async probe(ctx) {
    try {
      ctx.body = await service(strapi).probe({ targetId: (ctx.request.body || {}).targetId });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // GET /content-tools/data-transfer/backups
  async backups(ctx) {
    try {
      ctx.body = await service(strapi).listBackups();
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/data-transfer/restore-backup  { backupId }
  async restoreBackup(ctx) {
    try {
      ctx.body = await service(strapi).restoreBackup({ backupId: (ctx.request.body || {}).backupId });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // GET /content-tools/data-transfer/status
  async status(ctx) {
    ctx.body = service(strapi).getStatus();
  },
});
