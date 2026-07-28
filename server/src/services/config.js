'use strict';

/**
 * Per-content-type Content Tools configuration.
 *
 * Stored shape (v2): { "<uid>": { fields: string[], export: boolean, import: boolean } }
 * Legacy shape (v1): { "<uid>": string[] }  -> normalized to v2 on read.
 *
 * Persisted in the plugin store so the config is shared across all admins.
 */

const STORE_KEY = 'filterConfig';
const FILTERABLE_TYPES = ['relation', 'enumeration', 'boolean'];

// Noise never worth offering as a sticky filter.
const EXCLUDED_FIELDS = new Set(['createdBy', 'updatedBy', 'localizations']);
const EXCLUDED_RELATION_TARGETS = new Set(['admin::user', 'plugin::users-permissions.user']);

module.exports = ({ strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: 'content-tools' });

  const isFilterableAttr = (name, attr) => {
    if (!attr || EXCLUDED_FIELDS.has(name)) return false;
    if (attr.type === 'relation') {
      return !!attr.target && !EXCLUDED_RELATION_TARGETS.has(attr.target);
    }
    return FILTERABLE_TYPES.includes(attr.type);
  };

  const normalizeEntry = (raw) => {
    if (Array.isArray(raw)) {
      return { fields: [...new Set(raw)], export: false, import: false, dump: false };
    }
    if (raw && typeof raw === 'object') {
      return {
        fields: Array.isArray(raw.fields) ? [...new Set(raw.fields)] : [],
        export: !!raw.export,
        import: !!raw.import,
        dump: !!raw.dump,
      };
    }
    return { fields: [], export: false, import: false, dump: false };
  };

  const getConfig = async () => {
    const stored = (await store().get({ key: STORE_KEY })) || {};
    const out = {};
    for (const [uid, raw] of Object.entries(stored)) out[uid] = normalizeEntry(raw);
    return out;
  };

  const validFieldsFor = (uid, fields) => {
    const ct = strapi.contentTypes[uid];
    if (!ct) return [];
    return (Array.isArray(fields) ? fields : []).filter((field) => {
      if (field === 'createdAt') return true;
      if (field === 'publishedAt' && ct.options && ct.options.draftAndPublish) return true;
      return isFilterableAttr(field, ct.attributes && ct.attributes[field]);
    });
  };

  const setConfig = async (config) => {
    const clean = {};
    if (config && typeof config === 'object') {
      for (const [uid, raw] of Object.entries(config)) {
        if (!strapi.contentTypes[uid]) continue;
        const entry = normalizeEntry(raw);
        entry.fields = [...new Set(validFieldsFor(uid, entry.fields))];
        // Keep the entry only if it enables something.
        if (entry.fields.length || entry.export || entry.import || entry.dump) clean[uid] = entry;
      }
    }
    await store().set({ key: STORE_KEY, value: clean });
    return clean;
  };

  /**
   * Filterable schema shown in the settings UI: every api:: collection type
   * and its relation / enumeration / boolean attributes (noise excluded),
   * plus createdAt and (for D&P) publishedAt date-range filters.
   */
  const getSchema = () => {
    const out = [];

    for (const [uid, ct] of Object.entries(strapi.contentTypes)) {
      if (!uid.startsWith('api::') || ct.kind !== 'collectionType') continue;

      const attributes = {};
      for (const [name, attr] of Object.entries(ct.attributes || {})) {
        if (!isFilterableAttr(name, attr)) continue;
        if (attr.type === 'relation') attributes[name] = { type: 'relation', target: attr.target };
        else if (attr.type === 'enumeration') attributes[name] = { type: 'enumeration', enum: attr.enum || [] };
        else if (attr.type === 'boolean') attributes[name] = { type: 'boolean' };
      }

      attributes.createdAt = { type: 'datetime' };
      if (ct.options && ct.options.draftAndPublish) attributes.publishedAt = { type: 'datetime' };

      out.push({ uid, displayName: (ct.info && ct.info.displayName) || uid, attributes });
    }

    out.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return out;
  };

  return { getConfig, setConfig, getSchema };
};
