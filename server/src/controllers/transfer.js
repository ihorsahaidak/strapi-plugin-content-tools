'use strict';

const fs = require('fs');

const service = (strapi) => strapi.plugin('content-tools').service('transfer');

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
    strapi.log.error(`[content-tools] transfer failed: ${err && err.stack ? err.stack : err}`);
  }
}

module.exports = ({ strapi }) => ({
  // POST /content-tools/export -> { filename, contentBase64, count, mediaCount }
  async exportEntities(ctx) {
    const { uid, documentIds, locale } = ctx.request.body || {};
    try {
      ctx.body = await service(strapi).exportEntities({ uid, documentIds, locale });
    } catch (err) {
      sendError(ctx, err);
    }
  },

  // POST /content-tools/import (multipart, field "file") -> import report
  async importEntities(ctx) {
    try {
      const files = ctx.request.files || {};
      const upload = files.file || Object.values(files)[0];
      if (!upload || !upload.filepath) {
        throw Object.assign(new Error('No archive uploaded (field "file")'), {
          name: 'BadRequest',
          status: 400,
        });
      }
      const buffer = await fs.promises.readFile(upload.filepath);
      ctx.body = await service(strapi).importEntities({ buffer, user: ctx.state.user });
    } catch (err) {
      sendError(ctx, err);
    }
  },
});
