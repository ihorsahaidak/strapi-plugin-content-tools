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

  // POST /content-tools/data-transfer/pull  { targetId }
  async pull(ctx) {
    try {
      ctx.body = await service(strapi).pull({ targetId: (ctx.request.body || {}).targetId });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // GET /content-tools/data-transfer/status
  async status(ctx) {
    ctx.body = service(strapi).getStatus();
  },
});
