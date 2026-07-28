'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSZip = require('jszip');

const FILE_UID = 'plugin::upload.file';
const FOLDER_UID = 'plugin::upload.folder';
const MANIFEST_VERSION = 1;

// Managed fields never carried across environments (import stamps fresh ones).
const SYSTEM_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'publishedAt',
  'createdBy',
  'updatedBy',
  'locale',
  'localizations',
]);

// Natural keys tried (in order) when matching a relation across environments.
const REL_MATCH_FIELDS = ['name', 'slug', 'title', 'code', 'uid'];
// Entry fields tried (in order) to detect a same-entry conflict on import.
const CONFLICT_FIELDS = ['slug', 'name', 'title'];

function fail(name, message, status) {
  const err = new Error(message);
  err.name = name;
  err.status = status;
  return err;
}

// Stable key for a relation reference. Must NOT use "::" as a separator —
// the target uid (e.g. "api::website.website") already contains it.
const relKey = (ref) => JSON.stringify([ref.__rel, ref.field, String(ref.value)]);

const isMediaObject = (v) =>
  v && typeof v === 'object' && typeof v.hash === 'string' && typeof v.mime === 'string';

module.exports = ({ strapi }) => {
  /* ----------------------------------------------------------- schema walk */

  const getSchema = (uid) => {
    const ct = strapi.contentTypes[uid];
    if (!ct || ct.kind !== 'collectionType') {
      throw fail('BadRequest', `Unknown collection type: ${uid}`, 400);
    }
    return ct;
  };

  // Recursively build a populate object covering media, relations (shallow),
  // components and dynamic zones.
  const buildPopulate = (schema, depth = 0) => {
    if (depth > 6) return true;
    const populate = {};
    for (const [name, attr] of Object.entries(schema.attributes || {})) {
      if (attr.type === 'media') populate[name] = true;
      else if (attr.type === 'relation') populate[name] = true;
      else if (attr.type === 'component') {
        const comp = strapi.components[attr.component];
        populate[name] = comp ? { populate: buildPopulate(comp, depth + 1) } : true;
      } else if (attr.type === 'dynamiczone') {
        // Dynamic zones are polymorphic — use the fragment API (`on`) to
        // populate each component variant separately.
        const on = {};
        for (const cuid of attr.components || []) {
          const comp = strapi.components[cuid];
          if (comp) on[cuid] = { populate: buildPopulate(comp, depth + 1) };
        }
        populate[name] = Object.keys(on).length ? { on } : true;
      }
    }
    return populate;
  };

  /* --------------------------------------------------------- folder helpers */

  // id -> { name, parentId }
  const loadFolderIndex = async () => {
    const folders = await strapi.db
      .query(FOLDER_UID)
      .findMany({ populate: { parent: true } });
    const index = new Map();
    for (const f of folders) index.set(f.id, { name: f.name, parentId: f.parent?.id ?? null });
    return index;
  };

  const folderSegments = (index, folderId) => {
    const segments = [];
    let current = folderId;
    let guard = 0;
    while (current != null && guard++ < 32) {
      const node = index.get(current);
      if (!node) break;
      segments.unshift(node.name);
      current = node.parentId;
    }
    return segments;
  };

  /* ------------------------------------------------------------- export */

  const transformForExport = (entity, schema, media) => {
    const out = {};
    for (const [name, attr] of Object.entries(schema.attributes || {})) {
      if (SYSTEM_FIELDS.has(name)) continue;
      if (!(name in entity) || entity[name] == null) continue;
      out[name] = transformValue(entity[name], attr, media);
    }
    return out;
  };

  const transformValue = (value, attr, media) => {
    switch (attr.type) {
      case 'media': {
        const one = (f) => registerMedia(f, media);
        return Array.isArray(value) ? value.map(one).filter(Boolean) : one(value);
      }
      case 'relation': {
        const one = (r) => relationRef(r, attr);
        return Array.isArray(value) ? value.map(one).filter(Boolean) : one(value);
      }
      case 'component': {
        const comp = strapi.components[attr.component];
        if (!comp) return undefined;
        const one = (v) => transformForExport(v, comp, media);
        return Array.isArray(value) ? value.map(one) : one(value);
      }
      case 'dynamiczone':
        return (value || [])
          .map((item) => {
            const comp = strapi.components[item.__component];
            if (!comp) return null;
            return { __component: item.__component, ...transformForExport(item, comp, media) };
          })
          .filter(Boolean);
      default:
        return value;
    }
  };

  const registerMedia = (file, media) => {
    if (!isMediaObject(file)) return null;
    if (!media.has(file.hash)) {
      media.set(file.hash, {
        hash: file.hash,
        ext: file.ext,
        mime: file.mime,
        name: file.name,
        alternativeText: file.alternativeText ?? null,
        caption: file.caption ?? null,
        provider: file.provider,
        url: file.url,
        id: file.id,
      });
    }
    return { __media: file.hash };
  };

  const relationRef = (rel, attr) => {
    if (!rel || typeof rel !== 'object') return null;
    const field = REL_MATCH_FIELDS.find((f) => rel[f] != null);
    if (!field) return null;
    return { __rel: attr.target, field, value: rel[field] };
  };

  const readMediaBytes = async (file) => {
    // Local provider: read straight from disk.
    if (!file.provider || file.provider === 'local') {
      const local = path.join(strapi.dirs.static.public, 'uploads', `${file.hash}${file.ext}`);
      try {
        return await fs.promises.readFile(local);
      } catch {
        /* fall through to URL fetch */
      }
    }
    // Otherwise fetch the URL (absolute, or relative to the server).
    const base = strapi.config.get('server.url') || '';
    const url = /^https?:\/\//.test(file.url) ? file.url : `${base}${file.url}`;
    const res = await fetch(url);
    if (!res.ok) throw fail('BadRequest', `Could not read media ${file.name} (${res.status})`, 400);
    return Buffer.from(await res.arrayBuffer());
  };

  // Core: build a JSZip archive for a set of { documentId, locale } refs.
  const buildArchive = async ({ uid, refs }) => {
    const schema = getSchema(uid);
    const populate = buildPopulate(schema);
    const media = new Map();
    const entities = [];

    for (const ref of refs) {
      const entity = await strapi
        .documents(uid)
        .findOne({ documentId: ref.documentId, locale: ref.locale ?? undefined, status: 'draft', populate });
      if (!entity) continue;
      entities.push({
        documentId: ref.documentId,
        locale: entity.locale ?? ref.locale ?? null,
        data: transformForExport(entity, schema, media),
      });
    }

    // Resolve human-readable folder paths + gather bytes.
    const folderIndex = await loadFolderIndex();
    const zip = new JSZip();

    for (const item of media.values()) {
      const fileRecord = await strapi.db
        .query(FILE_UID)
        .findOne({ where: { id: item.id }, populate: { folder: true } });
      item.folderSegments = fileRecord?.folder?.id
        ? folderSegments(folderIndex, fileRecord.folder.id)
        : [];
      delete item.id;
      const bytes = await readMediaBytes(item);
      zip.file(`media/${item.hash}${item.ext}`, bytes);
    }

    const manifest = {
      version: MANIFEST_VERSION,
      uid,
      exportedAt: new Date().toISOString(),
      media: Array.from(media.values()),
      entities,
    };
    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    return { zip, count: entities.length, mediaCount: media.size };
  };

  // Every distinct { documentId, locale } draft ref of a whole collection.
  const collectAllRefs = async (uid) => {
    const rows = await strapi.db
      .query(uid)
      .findMany({ select: ['documentId', 'locale'], limit: -1 });
    const seen = new Set();
    const refs = [];
    for (const r of rows) {
      if (!r.documentId) continue;
      const key = `${r.documentId}::${r.locale ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ documentId: r.documentId, locale: r.locale ?? undefined });
    }
    return refs;
  };

  // Raw nodebuffer archive (used by dumps).
  const buildArchiveBuffer = async ({ uid, refs }) => {
    const { zip, count, mediaCount } = await buildArchive({ uid, refs });
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    return { buffer, count, mediaCount };
  };

  const exportEntities = async ({ uid, documentIds, locale }) => {
    getSchema(uid);
    if (!Array.isArray(documentIds) || documentIds.length === 0) {
      throw fail('BadRequest', 'documentIds must be a non-empty array', 400);
    }
    const refs = documentIds.map((documentId) => ({ documentId, locale }));
    const { zip, count, mediaCount } = await buildArchive({ uid, refs });
    const base64 = await zip.generateAsync({ type: 'base64' });
    const safe = uid.split('.').pop();
    return { filename: `${safe}-export-${count}.zip`, contentBase64: base64, count, mediaCount };
  };

  /* ------------------------------------------------------------- import */

  const ensureFolder = async (segments, user, cache) => {
    if (!segments || segments.length === 0) return null;
    let parentId = null;
    let key = '';
    for (const name of segments) {
      key = `${key}/${name}`;
      if (cache.has(key)) {
        parentId = cache.get(key);
        continue;
      }
      let folder = await strapi.db
        .query(FOLDER_UID)
        .findOne({ where: { name, parent: parentId ?? null } });
      if (!folder) {
        folder = await strapi
          .plugin('upload')
          .service('folder')
          .create({ name, parent: parentId ?? undefined }, { user });
      }
      cache.set(key, folder.id);
      parentId = folder.id;
    }
    return parentId;
  };

  const importMedia = async (mediaList, zip, user) => {
    const byHash = {};
    const folderCache = new Map();

    for (const m of mediaList || []) {
      // Dedupe: reuse an existing file with the same hash.
      const existing = await strapi.db.query(FILE_UID).findOne({ where: { hash: m.hash } });
      if (existing) {
        byHash[m.hash] = existing.id;
        continue;
      }

      const zipEntry = zip.file(`media/${m.hash}${m.ext}`);
      if (!zipEntry) continue;
      const buffer = await zipEntry.async('nodebuffer');

      const folderId = await ensureFolder(m.folderSegments, user, folderCache);
      const tmp = path.join(os.tmpdir(), `ct-import-${m.hash}${m.ext}`);
      await fs.promises.writeFile(tmp, buffer);

      try {
        const [file] = await strapi
          .plugin('upload')
          .service('upload')
          .upload(
            {
              data: {
                fileInfo: {
                  name: m.name,
                  alternativeText: m.alternativeText ?? undefined,
                  caption: m.caption ?? undefined,
                  folder: folderId ?? undefined,
                },
              },
              files: {
                filepath: tmp,
                originalFilename: m.name || `${m.hash}${m.ext}`,
                mimetype: m.mime,
                size: buffer.length,
              },
            },
            { user }
          );
        if (file) byHash[m.hash] = file.id;
      } finally {
        fs.promises.unlink(tmp).catch(() => {});
      }
    }
    return byHash;
  };

  const resolveForImport = (data, schema, ctx) => {
    const out = {};
    for (const [name, attr] of Object.entries(schema.attributes || {})) {
      if (SYSTEM_FIELDS.has(name)) continue;
      if (!(name in data) || data[name] == null) continue;
      out[name] = resolveValue(data[name], attr, ctx);
    }
    return out;
  };

  const resolveValue = (value, attr, ctx) => {
    switch (attr.type) {
      case 'media': {
        const one = (v) => (v && v.__media != null ? ctx.mediaMap[v.__media] ?? null : null);
        return Array.isArray(value) ? value.map(one).filter((v) => v != null) : one(value);
      }
      case 'relation': {
        const one = (v) => resolveRelation(v, ctx);
        return Array.isArray(value) ? value.map(one).filter((v) => v != null) : one(value);
      }
      case 'component': {
        const comp = strapi.components[attr.component];
        if (!comp) return undefined;
        const one = (v) => resolveForImport(v, comp, ctx);
        return Array.isArray(value) ? value.map(one) : one(value);
      }
      case 'dynamiczone':
        return (value || [])
          .map((item) => {
            const comp = strapi.components[item.__component];
            if (!comp) return null;
            return { __component: item.__component, ...resolveForImport(item, comp, ctx) };
          })
          .filter(Boolean);
      default:
        return value;
    }
  };

  const resolveRelation = (ref, ctx) => {
    if (!ref || !ref.__rel) return null;
    const id = ctx.relResolved.get(relKey(ref)) ?? null;
    if (id == null) ctx.report.missingRelations.add(`${ref.__rel} (${ref.field}=${ref.value})`);
    return id;
  };

  // Pre-resolve every relation reference in the manifest (async) so the
  // recursive resolveValue walk can stay synchronous.
  const preResolveRelations = async (entities, resolved) => {
    const refs = new Map(); // key -> ref
    const collect = (v) => {
      if (Array.isArray(v)) return v.forEach(collect);
      if (v && typeof v === 'object') {
        if (v.__rel) refs.set(relKey(v), v);
        else Object.values(v).forEach(collect);
      }
    };
    entities.forEach((e) => collect(e.data));

    for (const [key, ref] of refs) {
      const found = await strapi.db
        .query(ref.__rel)
        .findOne({ where: { [ref.field]: ref.value } });
      if (found) resolved.set(key, found.id);
    }
  };

  const findConflictField = (schema) =>
    CONFLICT_FIELDS.find((f) => schema.attributes && schema.attributes[f]);

  // Delete every document of a collection (used by "replace" restore).
  const deleteAllDocuments = async (uid) => {
    const rows = await strapi.db.query(uid).findMany({ select: ['documentId'], limit: -1 });
    const ids = [...new Set(rows.map((r) => r.documentId).filter(Boolean))];
    for (const documentId of ids) {
      try {
        await strapi.documents(uid).delete({ documentId });
      } catch {
        /* keep going */
      }
    }
    return ids.length;
  };

  const importArchive = async ({ buffer, user, replace = false }) => {
    const zip = await JSZip.loadAsync(buffer);
    const manifestEntry = zip.file('manifest.json');
    if (!manifestEntry) throw fail('BadRequest', 'Archive is missing manifest.json', 400);
    const manifest = JSON.parse(await manifestEntry.async('string'));

    const { uid } = manifest;
    const schema = getSchema(uid);

    const mediaMap = await importMedia(manifest.media, zip, user);

    const relResolved = new Map();
    await preResolveRelations(manifest.entities, relResolved);

    // Replace = wipe the collection first, then recreate everything.
    let deleted = 0;
    if (replace) deleted = await deleteAllDocuments(uid);

    const conflictField = findConflictField(schema);
    const report = {
      uid,
      deleted,
      created: [],
      skipped: [],
      notPublished: [],
      missingRelations: new Set(),
    };

    for (const entity of manifest.entities) {
      const ctx = { mediaMap, relResolved, relCache: new Map(), report };
      const locale = entity.locale ?? manifest.locale ?? undefined;

      // Conflict: same natural key + locale already present (skipped in replace
      // mode, where the collection was just emptied).
      const conflictValue = conflictField ? entity.data[conflictField] : undefined;
      if (!replace && conflictField && conflictValue != null) {
        const existing = await strapi.db
          .query(uid)
          .findOne({ where: { [conflictField]: conflictValue, locale: locale ?? null } });
        if (existing) {
          report.skipped.push({ [conflictField]: conflictValue, reason: 'already exists' });
          continue;
        }
      }

      const data = resolveForImport(entity.data, schema, ctx);
      try {
        const created = await strapi.documents(uid).create({ data, locale, status: 'draft' });
        report.created.push(created.documentId);

        // Publish so the publication date is set to the import time.
        if (schema.options && schema.options.draftAndPublish) {
          try {
            await strapi.documents(uid).publish({ documentId: created.documentId, locale });
          } catch (pubErr) {
            report.notPublished.push({ documentId: created.documentId, reason: pubErr.message });
          }
        }

        // Stamp the creation date (all rows of the document) to the import time.
        const meta = strapi.db.metadata.get(uid);
        const createdAtColumn = meta.attributes.createdAt?.columnName || 'created_at';
        const documentIdColumn = meta.attributes.documentId?.columnName || 'document_id';
        await strapi.db
          .connection(meta.tableName)
          .where(documentIdColumn, created.documentId)
          .update({ [createdAtColumn]: new Date() });
      } catch (err) {
        report.skipped.push({ [conflictField || 'entry']: conflictValue, reason: err.message });
      }
    }

    return {
      uid,
      deleted: report.deleted,
      created: report.created.length,
      skipped: report.skipped,
      notPublished: report.notPublished,
      missingRelations: Array.from(report.missingRelations),
    };
  };

  const importEntities = ({ buffer, user }) => importArchive({ buffer, user, replace: false });

  return {
    exportEntities,
    importEntities,
    // Reusable primitives for the dumps feature:
    buildArchiveBuffer,
    collectAllRefs,
    importArchive,
  };
};
