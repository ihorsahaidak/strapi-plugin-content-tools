'use strict';

const service = (strapi) => strapi.plugin('content-tools').service('config');

module.exports = ({ strapi }) => ({
  // GET /content-tools/config  -> { "<uid>": ["field", ...] }
  async find(ctx) {
    ctx.body = await service(strapi).getConfig();
  },

  // PUT /content-tools/config  body: { config: { "<uid>": [...] } }
  async update(ctx) {
    const body = ctx.request.body || {};
    const config = body.config !== undefined ? body.config : body;
    ctx.body = await service(strapi).setConfig(config);
  },

  // GET /content-tools/schema  -> { contentTypes: [...], config: {...} }
  async schema(ctx) {
    ctx.body = {
      contentTypes: service(strapi).getSchema(),
      config: await service(strapi).getConfig(),
    };
  },
});
