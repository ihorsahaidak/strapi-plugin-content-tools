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
module.exports = {
  register() {},
  bootstrap() {},
  destroy() {},
  routes,
  controllers,
  services,
};
