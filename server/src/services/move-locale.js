'use strict';

/**
 * Move a document (all of its rows for a given locale: draft + published)
 * from one language to another, in place, at the database level.
 *
 * "In place" means we simply reassign the `locale` column of the existing
 * rows — no copy is created and nothing is left behind in the source locale.
 * Component / relation / media links are keyed by the entry `id`, not the
 * locale, so they are preserved untouched.
 *
 * Both this and the locale-merge feature below are opt-in per content type
 * (Settings → Content Tools → Always-on filters, alongside the sticky
 * filters) — disabled everywhere until switched on, same as the filters.
 *
 * NOTE: this bypasses the Document Service lifecycles, so plugins that react
 * to document changes (e.g. search-index / reindexing plugins) will NOT be
 * triggered. Re-index affected content types manually if an external index
 * must reflect the new language immediately.
 */

function fail(name, message, status) {
  const err = new Error(message);
  err.name = name;
  err.status = status;
  return err;
}

// Built-in template variables that don't come from the row's own columns.
const BUILTIN_TEMPLATE_VARS = new Set(['lang', 'locale', 'documentId']);

/** Every `{word}` placeholder referenced in a template, in first-seen order. */
function templateFieldsOf(template) {
  const seen = new Set();
  const out = [];
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      out.push(m[1]);
    }
  }
  return out;
}

/** Fill `{word}` placeholders from `data`; unknown/empty values render blank. */
function renderTemplate(template, data) {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = data[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

module.exports = ({ strapi }) => {
  const configService = () => strapi.plugin('content-tools').service('config');

  const getLocalizedContentType = (uid) => {
    const ct = strapi.contentTypes[uid];
    if (!ct) {
      throw fail('BadRequest', `Unknown content type: ${uid}`, 400);
    }
    if (ct.kind !== 'collectionType') {
      throw fail('BadRequest', `${uid} is not a collection type`, 400);
    }
    const localized =
      ct.pluginOptions && ct.pluginOptions.i18n && ct.pluginOptions.i18n.localized;
    if (!localized) {
      throw fail('BadRequest', `${uid} is not localized`, 400);
    }
    return ct;
  };

  // Defense in depth: the admin UI already hides these actions per content
  // type, but a direct API call must be rejected too, and consistently with
  // whatever's actually configured (not whatever the client last saw).
  const assertEnabled = async (uid, flag, label) => {
    const cfg = (await configService().getConfig())[uid];
    if (!cfg || !cfg[flag]) {
      throw fail(
        'Forbidden',
        `"${label}" is not enabled for ${uid}. Enable it in Settings → Content Tools → Always-on filters.`,
        403
      );
    }
  };

  const assertLocaleExists = async (code) => {
    const locales = await strapi.plugin('i18n').service('locales').find();
    if (!locales.some((l) => l.code === code)) {
      throw fail('BadRequest', `Unknown locale: ${code}`, 400);
    }
  };

  const columns = (uid) => {
    const meta = strapi.db.metadata.get(uid);
    const attr = meta.attributes || {};
    return {
      tableName: meta.tableName,
      documentIdColumn: (attr.documentId && attr.documentId.columnName) || 'document_id',
      localeColumn: (attr.locale && attr.locale.columnName) || 'locale',
    };
  };

  const countInLocale = async (uid, documentId, locale) => {
    const { tableName, documentIdColumn, localeColumn } = columns(uid);
    const row = await strapi.db
      .connection(tableName)
      .where(documentIdColumn, documentId)
      .where(localeColumn, locale)
      .count({ c: '*' })
      .first();
    return Number(row && row.c ? row.c : 0);
  };

  const moveOne = async ({ uid, documentId, sourceLocale, targetLocale }) => {
    if (!documentId) throw fail('BadRequest', 'documentId is required', 400);
    if (!sourceLocale || !targetLocale) {
      throw fail('BadRequest', 'sourceLocale and targetLocale are required', 400);
    }
    if (sourceLocale === targetLocale) {
      throw fail('BadRequest', 'Source and target languages are the same', 400);
    }

    getLocalizedContentType(uid);
    await assertEnabled(uid, 'moveLocale', 'Move to another language');
    await assertLocaleExists(targetLocale);

    // Block & warn if the document already exists in the target language.
    const existing = await countInLocale(uid, documentId, targetLocale);
    if (existing > 0) {
      throw fail(
        'ConflictError',
        `This entry already exists in "${targetLocale}" — move blocked.`,
        409
      );
    }

    const { tableName, documentIdColumn, localeColumn } = columns(uid);
    const moved = await strapi.db
      .connection(tableName)
      .where(documentIdColumn, documentId)
      .where(localeColumn, sourceLocale)
      .update({ [localeColumn]: targetLocale });

    if (!moved) {
      throw fail('BadRequest', `No "${sourceLocale}" version of this entry was found.`, 400);
    }

    return { documentId, sourceLocale, targetLocale, moved };
  };

  // Heuristic label when no template is configured: title/name/slug, the
  // content-manager's own configured mainField, or documentId as a last
  // resort — one SQL-aggregated column, unchanged from before templates existed.
  const heuristicLabelColumn = async (uid, attrs, documentIdColumn) => {
    const cmConfig = await strapi
      .store({ type: 'plugin', name: 'content_manager' })
      .get({ key: `configuration_content_types::${uid}` })
      .catch(() => null);
    const preferred = cmConfig?.settings?.mainField;
    const labelColumn = ['title', 'name', 'slug'].concat(preferred ? [preferred] : []).reverse()
      .find((c) => attrs[c]) || documentIdColumn;
    return (attrs[labelColumn] && attrs[labelColumn].columnName) || labelColumn;
  };

  /**
   * Candidate documents to merge a locale INTO: same content type, and not
   * already holding `locale` (which would collide on
   * (document_id, locale, published_at)).
   *
   * Label source, in priority order:
   *   1. This content type's configured `mergeLabelTemplate` (Settings →
   *      Content Tools), e.g. "{title} — {slug} — {lang}". Built from ONE
   *      representative row per candidate — the site's default locale if the
   *      candidate has it, else its earliest locale code — because most
   *      fields are themselves localized, so "the title" isn't single-valued
   *      across a document. `{lang}` names which locale that row came from,
   *      so the picker never claims data it didn't actually use.
   *   2. Falls back to the pre-template heuristic (title/name/slug/mainField)
   *      when no template is set.
   *
   * Candidates are capped before labelling (see CANDIDATE_CAP) — labelling
   * requires reading real row data, so unlike the old single-column SQL
   * aggregate this can't sort/search millions of rows purely in the database.
   */
  const CANDIDATE_CAP = 500;
  const RESULT_LIMIT = 50;

  const mergeCandidates = async ({ uid, documentId, locale, q }) => {
    getLocalizedContentType(uid);
    await assertEnabled(uid, 'mergeLocale', 'Move this language to another entry');

    const { tableName, documentIdColumn, localeColumn } = columns(uid);
    const meta = strapi.db.metadata.get(uid);
    const attrs = meta.attributes || {};
    const knex = strapi.db.connection;

    // Documents that DO have the locale — these are excluded as candidates.
    const taken = knex(tableName).distinct(documentIdColumn).where(localeColumn, locale);

    const cfg = (await configService().getConfig())[uid];
    const template = cfg && cfg.mergeLabelTemplate;

    if (!template) {
      const labelCol = await heuristicLabelColumn(uid, attrs, documentIdColumn);
      let query = knex(tableName)
        .select(`${documentIdColumn} as documentId`)
        .max(`${labelCol} as label`)
        .whereNotIn(documentIdColumn, taken)
        .groupBy(documentIdColumn)
        .orderBy('label', 'asc')
        .limit(RESULT_LIMIT);
      if (documentId) query = query.whereNot(documentIdColumn, documentId);
      if (q) query = query.whereILike(labelCol, `%${q}%`);

      const rows = await query;
      const locales = await localesByDocument(knex, tableName, documentIdColumn, localeColumn, rows.map((r) => r.documentId));
      return rows.map((r) => ({
        documentId: r.documentId,
        label: r.label == null || r.label === '' ? `(untitled) ${r.documentId}` : String(r.label),
        locales: locales.get(r.documentId) || [],
      }));
    }

    // Template mode: need real column values, so fetch candidate ids first
    // (bounded), then the actual rows for just those, then render in JS.
    let idQuery = knex(tableName).distinct(documentIdColumn).whereNotIn(documentIdColumn, taken);
    if (documentId) idQuery = idQuery.whereNot(documentIdColumn, documentId);
    const idRows = await idQuery.orderBy(documentIdColumn, 'asc').limit(CANDIDATE_CAP);
    const ids = idRows.map((r) => r[documentIdColumn]);
    if (!ids.length) return [];

    const fields = templateFieldsOf(template).filter((f) => !BUILTIN_TEMPLATE_VARS.has(f) && attrs[f]);
    const selectCols = [documentIdColumn, localeColumn, ...fields].map(
      (c) => (attrs[c] && attrs[c].columnName) || c
    );
    const rows = await knex(tableName).select(selectCols).whereIn(documentIdColumn, ids);

    let defaultLocale;
    try {
      const locales = await strapi.plugin('i18n').service('locales').find();
      defaultLocale = locales.find((l) => l.isDefault)?.code;
    } catch {
      /* best effort */
    }

    const byDoc = new Map();
    for (const row of rows) {
      const id = row[documentIdColumn];
      if (!byDoc.has(id)) byDoc.set(id, []);
      byDoc.get(id).push(row);
    }

    const candidates = [];
    for (const [docId, docRows] of byDoc) {
      docRows.sort((a, b) => {
        const aLoc = a[localeColumn];
        const bLoc = b[localeColumn];
        if (aLoc === bLoc) return 0;
        if (aLoc === defaultLocale) return -1;
        if (bLoc === defaultLocale) return 1;
        return String(aLoc).localeCompare(String(bLoc));
      });
      const pick = docRows[0];
      const data = { documentId: docId, lang: pick[localeColumn], locale: pick[localeColumn] };
      for (const f of fields) data[f] = pick[(attrs[f] && attrs[f].columnName) || f];
      const rendered = renderTemplate(template, data).trim();
      candidates.push({
        documentId: docId,
        label: rendered || `(untitled) ${docId}`,
        locales: [...new Set(docRows.map((r) => r[localeColumn]))].sort(),
      });
    }

    let filtered = candidates;
    if (q) {
      const needle = String(q).toLowerCase();
      filtered = candidates.filter((c) => c.label.toLowerCase().includes(needle));
    }
    filtered.sort((a, b) => a.label.localeCompare(b.label));
    return filtered.slice(0, RESULT_LIMIT);
  };

  async function localesByDocument(knex, tableName, documentIdColumn, localeColumn, ids) {
    const localesByDoc = new Map();
    if (!ids.length) return localesByDoc;
    const rows = await knex(tableName)
      .distinct(`${documentIdColumn} as documentId`, `${localeColumn} as locale`)
      .whereIn(documentIdColumn, ids);
    for (const r of rows) {
      if (!localesByDoc.has(r.documentId)) localesByDoc.set(r.documentId, []);
      localesByDoc.get(r.documentId).push(r.locale);
    }
    for (const list of localesByDoc.values()) list.sort();
    return localesByDoc;
  }

  /**
   * Re-parent one locale: detach `locale` from `sourceDocumentId` and attach it
   * to `targetDocumentId`, keeping the language and the rows themselves.
   *
   * Where moveOne changes WHICH LANGUAGE an entry is, this changes WHICH ENTRY
   * a language belongs to — the fix for "I filled in fr on the wrong entry, and
   * the entry I actually want is missing fr". Both draft and published rows
   * move together; components/relations/media are keyed by row id, so they
   * follow untouched.
   *
   * The source document is left with whatever locales it still had; if this was
   * its only one, it disappears from the Content Manager (that being the point).
   */
  const mergeLocaleIntoDocument = async ({ uid, sourceDocumentId, targetDocumentId, locale }) => {
    if (!sourceDocumentId || !targetDocumentId) {
      throw fail('BadRequest', 'sourceDocumentId and targetDocumentId are required', 400);
    }
    if (sourceDocumentId === targetDocumentId) {
      throw fail('BadRequest', 'Source and target entries are the same', 400);
    }
    if (!locale) throw fail('BadRequest', 'locale is required', 400);

    getLocalizedContentType(uid);
    await assertEnabled(uid, 'mergeLocale', 'Move this language to another entry');
    await assertLocaleExists(locale);

    if ((await countInLocale(uid, sourceDocumentId, locale)) === 0) {
      throw fail('BadRequest', `The source entry has no "${locale}" version.`, 400);
    }
    // Guard the uniqueness Strapi relies on: (document_id, locale, published_at).
    if ((await countInLocale(uid, targetDocumentId, locale)) > 0) {
      throw fail(
        'ConflictError',
        `The target entry already has a "${locale}" version — move blocked. Delete it there first if you want to replace it.`,
        409
      );
    }
    // The target must actually exist in some other locale, otherwise this is a
    // typo'd id and we would silently create an orphan document.
    const { tableName, documentIdColumn, localeColumn } = columns(uid);
    const targetExists = await strapi.db
      .connection(tableName)
      .where(documentIdColumn, targetDocumentId)
      .count({ c: '*' })
      .first();
    if (!Number(targetExists?.c || 0)) {
      throw fail('BadRequest', 'The target entry does not exist.', 400);
    }

    const moved = await strapi.db
      .connection(tableName)
      .where(documentIdColumn, sourceDocumentId)
      .where(localeColumn, locale)
      .update({ [documentIdColumn]: targetDocumentId });

    const remaining = await strapi.db
      .connection(tableName)
      .where(documentIdColumn, sourceDocumentId)
      .count({ c: '*' })
      .first();

    return {
      uid,
      locale,
      sourceDocumentId,
      targetDocumentId,
      moved,
      sourceRemainingRows: Number(remaining?.c || 0),
    };
  };

  const moveMany = async ({ uid, documentIds, sourceLocale, targetLocale }) => {
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      throw fail('BadRequest', 'documentIds must be a non-empty array', 400);
    }
    if (sourceLocale === targetLocale) {
      throw fail('BadRequest', 'Source and target languages are the same', 400);
    }

    getLocalizedContentType(uid);
    await assertEnabled(uid, 'moveLocale', 'Move to another language');
    await assertLocaleExists(targetLocale);

    const moved = [];
    const blocked = [];

    for (const documentId of documentIds) {
      try {
        await moveOne({ uid, documentId, sourceLocale, targetLocale });
        moved.push(documentId);
      } catch (err) {
        blocked.push({ documentId, reason: err.message });
      }
    }

    return { sourceLocale, targetLocale, moved, blocked };
  };

  return { moveOne, moveMany, mergeCandidates, mergeLocaleIntoDocument };
};
