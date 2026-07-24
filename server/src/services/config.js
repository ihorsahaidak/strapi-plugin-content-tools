'use strict';

/**
 * Stores, per content type, which fields are exposed as sticky list filters.
 * Shape: { "<uid>": ["<field>", ...] }
 * Persisted in the plugin store so the config is shared across all admins.
 */

const STORE_KEY = 'filterConfig';
const FILTERABLE_TYPES = ['relation', 'enumeration', 'boolean'];

module.exports = ({ strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: 'content-tools' });

  const getConfig = async () => (await store().get({ key: STORE_KEY })) || {};

  const sanitize = (config) => {
    const result = {};
    if (!config || typeof config !== 'object') return result;

    for (const [uid, fields] of Object.entries(config)) {
      const ct = strapi.contentTypes[uid];
      if (!ct || ct.kind !== 'collectionType' || !Array.isArray(fields)) continue;

      const valid = fields.filter((field) => {
        if (field === 'createdAt') return true;
        if (field === 'publishedAt' && ct.options && ct.options.draftAndPublish) return true;
        const attr = ct.attributes && ct.attributes[field];
        return attr && FILTERABLE_TYPES.includes(attr.type);
      });

      if (valid.length) result[uid] = [...new Set(valid)];
    }
    return result;
  };

  const setConfig = async (config) => {
    const clean = sanitize(config);
    await store().set({ key: STORE_KEY, value: clean });
    return clean;
  };

  /**
   * The filterable schema shown in the settings UI: every api:: collection
   * type and its relation / enumeration / boolean attributes.
   */
  const getSchema = () => {
    const out = [];

    for (const [uid, ct] of Object.entries(strapi.contentTypes)) {
      if (!uid.startsWith('api::') || ct.kind !== 'collectionType') continue;

      const attributes = {};
      for (const [name, attr] of Object.entries(ct.attributes || {})) {
        if (attr.type === 'relation' && attr.target) {
          attributes[name] = { type: 'relation', target: attr.target };
        } else if (attr.type === 'enumeration') {
          attributes[name] = { type: 'enumeration', enum: attr.enum || [] };
        } else if (attr.type === 'boolean') {
          attributes[name] = { type: 'boolean' };
        }
      }

      // Every collection type can be filtered by its creation date, and
      // draft&publish types also by their publication date.
      attributes.createdAt = { type: 'datetime' };
      if (ct.options && ct.options.draftAndPublish) {
        attributes.publishedAt = { type: 'datetime' };
      }

      out.push({
        uid,
        displayName: (ct.info && ct.info.displayName) || uid,
        attributes,
      });
    }

    out.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return out;
  };

  return { getConfig, setConfig, getSchema };
};
