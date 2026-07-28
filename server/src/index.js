'use strict';

const routes = require('./routes');
const controllers = require('./controllers');
const services = require('./services');

/**
 * content-tools plugin (server).
 *
 * Exposes admin-only endpoints for the Content Manager customisations:
 *  - move an entry between locales (single + bulk)
 *  - per-content-type filter configuration
 *  - export / import of entries with their media
 *
 * No content types are assumed — filter fields are opt-in per content type
 * from Settings → Content Tools → Filters (empty until configured).
 */
// Daily auto-dump for collections with dumps enabled (03:00 server time).
const DAILY_DUMP_RULE = '0 3 * * *';

module.exports = {
  register() {},
  bootstrap({ strapi }) {
    try {
      strapi.cron.add({
        'content-tools-daily-dumps': {
          task: async ({ strapi: s }) => {
            await s.plugin('content-tools').service('dumps').dumpEnabledMissingToday();
          },
          options: { rule: DAILY_DUMP_RULE },
        },
      });
    } catch (err) {
      strapi.log.error(`[content-tools] could not register daily-dump cron: ${err && err.message}`);
    }
  },
  destroy() {},
  routes,
  controllers,
  services,
};
