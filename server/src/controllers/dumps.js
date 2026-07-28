'use strict';

const service = (strapi) => strapi.plugin('content-tools').service('dumps');

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
    strapi.log.error(`[content-tools] dumps: ${err && err.stack ? err.stack : err}`);
  }
}

module.exports = ({ strapi }) => ({
  // GET /content-tools/dumps -> { retention, dumps: { [uid]: [...] } }
  async overview(ctx) {
    ctx.body = await service(strapi).overview();
  },

  // PUT /content-tools/dumps/retention { retention }
  async setRetention(ctx) {
    try {
      const retention = await service(strapi).setRetention((ctx.request.body || {}).retention);
      ctx.body = { retention };
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/dumps/create { uid }
  async create(ctx) {
    try {
      ctx.body = await service(strapi).createDump((ctx.request.body || {}).uid);
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/dumps/restore { uid, dumpId }
  async restore(ctx) {
    try {
      const { uid, dumpId } = ctx.request.body || {};
      ctx.body = await service(strapi).restoreDump({ uid, dumpId, user: ctx.state.user });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },

  // POST /content-tools/dumps/delete { uid, dumpId }
  async remove(ctx) {
    try {
      const { uid, dumpId } = ctx.request.body || {};
      ctx.body = await service(strapi).deleteDump({ uid, dumpId });
    } catch (err) {
      sendError(strapi, ctx, err);
    }
  },
});
