'use strict';

const service = (strapi) => strapi.plugin('content-tools').service('move-locale');

function sendError(ctx, err) {
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
    strapi.log.error(`[content-tools] move-locale failed: ${err && err.stack ? err.stack : err}`);
  }
}

module.exports = ({ strapi }) => ({
  async moveOne(ctx) {
    const { uid, documentId, sourceLocale, targetLocale } = ctx.request.body || {};
    try {
      ctx.body = await service(strapi).moveOne({ uid, documentId, sourceLocale, targetLocale });
    } catch (err) {
      sendError(ctx, err);
    }
  },

  async moveMany(ctx) {
    const { uid, documentIds, sourceLocale, targetLocale } = ctx.request.body || {};
    try {
      ctx.body = await service(strapi).moveMany({ uid, documentIds, sourceLocale, targetLocale });
    } catch (err) {
      sendError(ctx, err);
    }
  },
});
