'use strict';

/**
 * Per-collection dumps (snapshots). A dump is a full export of a collection
 * type (all documents + all locales + media, via the transfer service),
 * written to disk. Retention keeps the last N (max 7) per collection.
 *
 * Restore = replace: the collection is wiped and recreated from the dump.
 *
 * NOTE: dump files live under <app>/.tmp — ephemeral if the container image is
 * rebuilt. Treat them as short-lived working snapshots, not long-term backups.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DUMPS_KEY = 'dumps'; // { [uid]: [ { id, createdAt, count, mediaCount, size, file } ] }
const RETENTION_KEY = 'dumpRetention';
const DEFAULT_RETENTION = 3;
const MAX_RETENTION = 7;

const fail = (name, message, code) => {
  const err = new Error(message);
  err.name = name;
  err.status = code;
  return err;
};

module.exports = ({ strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: 'content-tools' });
  const transfer = () => strapi.plugin('content-tools').service('transfer');

  const baseDir = () =>
    path.join(strapi.dirs?.app?.root || process.cwd(), '.tmp', 'content-tools-dumps');
  const uidDir = (uid) => path.join(baseDir(), uid.replace(/[^a-z0-9._-]/gi, '_'));

  const getRetention = async () => {
    const n = Number(await store().get({ key: RETENTION_KEY }));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, MAX_RETENTION) : DEFAULT_RETENTION;
  };

  const setRetention = async (value) => {
    const n = Math.max(1, Math.min(MAX_RETENTION, Math.floor(Number(value) || DEFAULT_RETENTION)));
    await store().set({ key: RETENTION_KEY, value: n });
    return n;
  };

  const getAll = async () => (await store().get({ key: DUMPS_KEY })) || {};
  const setAll = async (value) => store().set({ key: DUMPS_KEY, value });

  const sortDesc = (list) =>
    list.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

  const listDumps = async (uid) => sortDesc((await getAll())[uid] || []);

  const overview = async () => ({ retention: await getRetention(), dumps: await getAll() });

  const createDump = async (uid) => {
    const ct = strapi.contentTypes[uid];
    if (!ct || ct.kind !== 'collectionType') {
      throw fail('BadRequest', `Unknown collection type: ${uid}`, 400);
    }

    const refs = await transfer().collectAllRefs(uid);
    const { buffer, count, mediaCount } = await transfer().buildArchiveBuffer({ uid, refs });

    const dir = uidDir(uid);
    await fs.promises.mkdir(dir, { recursive: true });
    const id = crypto.randomUUID();
    const file = `${id}.zip`;
    await fs.promises.writeFile(path.join(dir, file), buffer);

    const meta = {
      id,
      createdAt: new Date().toISOString(),
      count,
      mediaCount,
      size: buffer.length,
      file,
    };

    const all = await getAll();
    const list = sortDesc([meta, ...(all[uid] || [])]);

    // Retention: keep the newest N, delete the rest (files + metadata).
    const retention = await getRetention();
    for (const old of list.slice(retention)) {
      await fs.promises.unlink(path.join(dir, old.file)).catch(() => {});
    }
    all[uid] = list.slice(0, retention);
    await setAll(all);

    return { dump: meta, count, mediaCount, kept: all[uid].length };
  };

  const readDumpBuffer = async (uid, dumpId) => {
    const meta = ((await getAll())[uid] || []).find((d) => d.id === dumpId);
    if (!meta) throw fail('BadRequest', 'Unknown dump', 400);
    try {
      return await fs.promises.readFile(path.join(uidDir(uid), meta.file));
    } catch {
      throw fail('BadRequest', 'Dump file is missing on disk', 400);
    }
  };

  const restoreDump = async ({ uid, dumpId, user }) => {
    const buffer = await readDumpBuffer(uid, dumpId);
    // True restore: wipe the collection, then recreate from the dump.
    return transfer().importArchive({ buffer, user, replace: true });
  };

  const deleteDump = async ({ uid, dumpId }) => {
    const all = await getAll();
    const list = all[uid] || [];
    const meta = list.find((d) => d.id === dumpId);
    if (meta) await fs.promises.unlink(path.join(uidDir(uid), meta.file)).catch(() => {});
    all[uid] = list.filter((d) => d.id !== dumpId);
    await setAll(all);
    return { deleted: !!meta };
  };

  return {
    overview,
    listDumps,
    getRetention,
    setRetention,
    createDump,
    restoreDump,
    deleteDump,
  };
};
