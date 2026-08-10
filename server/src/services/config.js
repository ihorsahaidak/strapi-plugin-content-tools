'use strict';

/**
 * Per-content-type Content Tools configuration.
 *
 * Stored shape: { "<uid>": { fields, moveLocale, mergeLocale, mergeLabelTemplate } }
 * Legacy shapes normalized on read: a bare string[] (v1), and the v2 object
 * that also carried `export`/`import` flags for the removed import/export
 * feature — those keys are simply dropped.
 *
 * Persisted in the plugin store so the config is shared across all admins.
 */

const STORE_KEY = 'filterConfig';
const FILTERABLE_TYPES = ['relation', 'enumeration', 'boolean'];

// Scalar attribute types usable inside a merge-label template — anything that
// stringifies sensibly. Relations/components/dynamiczones/media/json/password
// are deliberately excluded: they don't have a single meaningful value.
const TEMPLATE_SCALAR_TYPES = [
  'string',
  'text',
  'richtext',
  'uid',
  'email',
  'enumeration',
  'integer',
  'float',
  'decimal',
  'biginteger',
  'boolean',
  'date',
  'datetime',
  'time',
];

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

  const isTemplateFieldAttr = (name, attr) => {
    if (!attr || EXCLUDED_FIELDS.has(name)) return false;
    return TEMPLATE_SCALAR_TYPES.includes(attr.type);
  };

  const isLocalized = (ct) => !!(ct.pluginOptions && ct.pluginOptions.i18n && ct.pluginOptions.i18n.localized);

  const normalizeEntry = (raw) => {
    if (Array.isArray(raw)) {
      return { fields: [...new Set(raw)], moveLocale: false, mergeLocale: false, mergeLabelTemplate: '' };
    }
    if (raw && typeof raw === 'object') {
      return {
        fields: Array.isArray(raw.fields) ? [...new Set(raw.fields)] : [],
        moveLocale: !!raw.moveLocale,
        mergeLocale: !!raw.mergeLocale,
        mergeLabelTemplate: typeof raw.mergeLabelTemplate === 'string' ? raw.mergeLabelTemplate : '',
      };
    }
    return { fields: [], moveLocale: false, mergeLocale: false, mergeLabelTemplate: '' };
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
        const ct = strapi.contentTypes[uid];
        if (!ct) continue;
        const entry = normalizeEntry(raw);
        entry.fields = [...new Set(validFieldsFor(uid, entry.fields))];
        // Move/merge only make sense for localized collection types — never
        // persist them as enabled for anything else, however the request
        // to the settings UI happened.
        const localizable = ct.kind === 'collectionType' && isLocalized(ct);
        entry.moveLocale = localizable && entry.moveLocale;
        entry.mergeLocale = localizable && entry.mergeLocale;
        entry.mergeLabelTemplate = entry.mergeLocale ? entry.mergeLabelTemplate.slice(0, 500) : '';
        // Keep the entry only if it enables something.
        if (entry.fields.length || entry.moveLocale || entry.mergeLocale) clean[uid] = entry;
      }
    }
    await store().set({ key: STORE_KEY, value: clean });
    return clean;
  };

  /**
   * Schema shown in the settings UI: every api:: collection type, its
   * relation / enumeration / boolean attributes for the sticky-filter picker
   * (noise excluded), createdAt/publishedAt date-range filters, whether it's
   * localized (move/merge only apply then), and the scalar fields available
   * for a merge-label template.
   */
  const getSchema = () => {
    const out = [];

    for (const [uid, ct] of Object.entries(strapi.contentTypes)) {
      if (!uid.startsWith('api::') || ct.kind !== 'collectionType') continue;

      const attributes = {};
      const templateFields = [];
      for (const [name, attr] of Object.entries(ct.attributes || {})) {
        if (isFilterableAttr(name, attr)) {
          if (attr.type === 'relation') attributes[name] = { type: 'relation', target: attr.target };
          else if (attr.type === 'enumeration') attributes[name] = { type: 'enumeration', enum: attr.enum || [] };
          else if (attr.type === 'boolean') attributes[name] = { type: 'boolean' };
        }
        if (isTemplateFieldAttr(name, attr)) templateFields.push(name);
      }

      attributes.createdAt = { type: 'datetime' };
      if (ct.options && ct.options.draftAndPublish) attributes.publishedAt = { type: 'datetime' };

      templateFields.sort();

      out.push({
        uid,
        displayName: (ct.info && ct.info.displayName) || uid,
        attributes,
        localized: isLocalized(ct),
        templateFields,
      });
    }

    out.sort((a, b) => a.displayName.localeCompare(b.displayName));
    return out;
  };

  return { getConfig, setConfig, getSchema };
};
