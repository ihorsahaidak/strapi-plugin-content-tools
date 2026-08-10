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

module.exports = ({ strapi }) => {
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

  /**
   * Candidate documents to merge a locale INTO: same content type, and not
   * already holding `locale` (which would collide on
   * (document_id, locale, published_at)). Labelled with the content type's
   * mainField taken from whichever locale the candidate does have, since by
   * definition it has nothing in `locale` yet.
   */
  const mergeCandidates = async ({ uid, documentId, locale, q }) => {
    getLocalizedContentType(uid);
    const { tableName, documentIdColumn, localeColumn } = columns(uid);

    // mainField drives the label; fall back to something recognisable.
    const config = await strapi
      .store({ type: 'plugin', name: 'content_manager' })
      .get({ key: `configuration_content_types::${uid}` })
      .catch(() => null);
    const meta = strapi.db.metadata.get(uid);
    const attrs = meta.attributes || {};
    const preferred = config?.settings?.mainField;
    const labelColumn = ['title', 'name', 'slug'].concat(preferred ? [preferred] : []).reverse()
      .find((c) => attrs[c]) || documentIdColumn;
    const labelCol = (attrs[labelColumn] && attrs[labelColumn].columnName) || labelColumn;

    const knex = strapi.db.connection;
    // Documents that DO have the locale — these are the ones to exclude.
    const taken = knex(tableName).distinct(documentIdColumn).where(localeColumn, locale);

    let query = knex(tableName)
      .select(`${documentIdColumn} as documentId`)
      .max(`${labelCol} as label`)
      .whereNotIn(documentIdColumn, taken)
      .groupBy(documentIdColumn)
      .orderBy('label', 'asc')
      .limit(50);

    if (documentId) query = query.whereNot(documentIdColumn, documentId);
    if (q) query = query.whereILike(labelCol, `%${q}%`);

    const rows = await query;
    // Which locales each candidate already has, so the picker can show it.
    const ids = rows.map((r) => r.documentId);
    const localesByDoc = new Map();
    if (ids.length) {
      const localeRows = await knex(tableName)
        .distinct(`${documentIdColumn} as documentId`, `${localeColumn} as locale`)
        .whereIn(documentIdColumn, ids);
      for (const r of localeRows) {
        if (!localesByDoc.has(r.documentId)) localesByDoc.set(r.documentId, []);
        localesByDoc.get(r.documentId).push(r.locale);
      }
    }

    return rows.map((r) => ({
      documentId: r.documentId,
      label: r.label == null || r.label === '' ? `(untitled) ${r.documentId}` : String(r.label),
      locales: (localesByDoc.get(r.documentId) || []).sort(),
    }));
  };

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
