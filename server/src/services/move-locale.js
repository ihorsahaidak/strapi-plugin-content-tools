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

  return { moveOne, moveMany };
};
