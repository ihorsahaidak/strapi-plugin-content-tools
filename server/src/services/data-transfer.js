'use strict';

/**
 * Pull all content + media from a remote Strapi environment into this one, using
 * the built-in @strapi/data-transfer engine (same as the `strapi transfer` CLI).
 *
 * Safety model — a pull is DECOUPLED into download-then-apply so the destructive
 * step is never gated on a slow network stream (the old live streaming restore
 * held a DB transaction open for the whole transfer, starving the admin, and left
 * the DB half-wiped on any mid-stream failure):
 *   1. backup   — export the current environment (content + files) to a local
 *                 .tar.gz. This is the rollback point.
 *   2. download — stream the remote into a second local .tar.gz. Long and
 *                 network-bound, but writes only to a file: the local DB is not
 *                 touched, so the admin stays responsive and a failure/stop here
 *                 leaves local data completely intact.
 *   3. restore  — delete-then-import the downloaded tar. The ONLY destructive
 *                 step; it reads a fast local file, so the DB-lock window is short
 *                 and predictable. On failure it rolls back to the phase-1 backup.
 *
 * The job runs in the background; the admin page polls getStatus() for live
 * per-phase counts + a percentage (exact during restore — the tar's counts are
 * known). "Force stop" aborts the running engine (engine.abortTransfer());
 * depending on the phase it either leaves data untouched or rolls back.
 *
 * Saved targets ({ id, name, url, token }) live in the plugin store.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  engine: dtEngine,
  strapi: dtStrapi,
  file: dtFile,
} = require('@strapi/data-transfer');

const TARGETS_KEY = 'dataTransferTargets';
const ESTIMATE_KEY = 'dataTransferLastTotals'; // { entities, assets } from the last good pull
const BACKUPS_KEY = 'dataTransferBackups'; // [{ id, file, createdAt, entities, assets, bytes, reason }]
const MAX_BACKUPS = 3;

// Content types Strapi never transfers — restoring admin accounts / tokens /
// audit logs during a transfer would risk locking you out and break FKs.
const IGNORED_CONTENT_TYPES = [
  'admin::permission',
  'admin::user',
  'admin::role',
  'admin::api-token',
  'admin::api-token-permission',
  'admin::transfer-token',
  'admin::transfer-token-permission',
  'admin::audit-log',
  'plugin::content-releases.release',
  'plugin::content-releases.release-action',
];

// Empty, machine-readable progress buckets. Mirrors the engine's progress.data.
const emptyCounts = () => ({
  entities: { count: 0, bytes: 0 },
  links: { count: 0, bytes: 0 },
  assets: { count: 0, bytes: 0 },
  configuration: { count: 0, bytes: 0 },
});

// Single in-process job (one server process). `status` is the whole picture the
// admin page renders; keep it JSON-serialisable.
let status = {
  running: false,
  step: 'idle', // 'idle' | 'backup' | 'transfer' | 'restore' | 'done' | 'failed' | 'stopped'
  phase: null, // human label
  targetId: null,
  targetName: null,
  counts: emptyCounts(), // live counts of the current step
  estimate: null, // { entities, assets } denominator for the % bar (may be null)
  percent: null, // 0..100 or null when indeterminate
  backup: null, // { id, file, createdAt, entities, assets, bytes } taken before this pull
  error: null,
  stopRequested: false,
  startedAt: null,
  finishedAt: null,
};

// Live engine handle for the currently-running step, so stop() can abort it.
let currentEngine = null;

const fail = (name, message, code) => {
  const err = new Error(message);
  err.name = name;
  err.status = code;
  return err;
};

const sum = (counts) => ({
  entities: counts.entities.count,
  assets: counts.assets.count,
  bytes: counts.entities.bytes + counts.links.bytes + counts.assets.bytes,
});

module.exports = ({ strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: 'content-tools' });

  /* ------------------------------------------------------------ targets */

  const getTargetsRaw = async () => (await store().get({ key: TARGETS_KEY })) || [];
  const mask = (t) => ({ id: t.id, name: t.name, url: t.url, hasToken: !!t.token });
  const listTargets = async () => (await getTargetsRaw()).map(mask);

  const saveTargets = async (incoming) => {
    const existing = await getTargetsRaw();
    const byId = new Map(existing.map((t) => [t.id, t]));
    const clean = (Array.isArray(incoming) ? incoming : [])
      .filter((t) => t && t.url)
      .map((t) => {
        const prev = byId.get(t.id);
        // Empty token on save = keep the previously stored one.
        const token = t.token && String(t.token).length ? String(t.token) : prev ? prev.token : '';
        return {
          id: t.id || crypto.randomUUID(),
          name: String(t.name || '').slice(0, 80),
          url: String(t.url).trim().replace(/\/+$/, ''),
          token,
        };
      });
    await store().set({ key: TARGETS_KEY, value: clean });
    return clean.map(mask);
  };

  const getStatus = () => status;

  const buildRemoteUrl = (raw) => {
    const base = new URL(raw);
    if (!/\/admin\/?$/.test(base.pathname)) {
      base.pathname = `${base.pathname.replace(/\/+$/, '')}/admin`;
    }
    return base;
  };

  const findTarget = async (targetId) => {
    const target = (await getTargetsRaw()).find((t) => t.id === targetId);
    if (!target) throw fail('BadRequest', 'Unknown target', 400);
    return target;
  };

  /* ---------------------------------------------------------- engine glue */

  const notIgnored = (uid) => !IGNORED_CONTENT_TYPES.includes(uid);

  // Common engine config: content + files only, admin/token types excluded.
  const engineOptions = () => ({
    versionStrategy: 'exact',
    schemaStrategy: 'strict',
    only: ['content', 'files'],
    transforms: {
      links: [{ filter: (link) => notIgnored(link.left?.type) && notIgnored(link.right?.type) }],
      entities: [{ filter: (entity) => notIgnored(entity.type) }],
    },
  });

  // Wire the engine's progress stream into `status.counts` (+ percent). Best
  // effort: never let progress wiring throw into the transfer.
  const wireProgress = (engine, { onTick } = {}) => {
    const refresh = () => {
      try {
        const data = engine.progress?.data;
        if (data) {
          for (const key of Object.keys(status.counts)) {
            const d = data[key];
            if (d) {
              status.counts[key] = {
                count: d.count ?? d.aggregates?.count ?? status.counts[key].count,
                bytes: d.bytes ?? d.aggregates?.bytes ?? status.counts[key].bytes,
              };
            }
          }
        }
      } catch {
        /* ignore */
      }
      // Percent from the estimate denominator (entities + assets).
      const est = status.estimate;
      if (est && est.entities + est.assets > 0) {
        const done = status.counts.entities.count + status.counts.assets.count;
        const total = est.entities + est.assets;
        status.percent = Math.max(0, Math.min(99, Math.round((done / total) * 100)));
      }
      if (typeof onTick === 'function') onTick();
    };
    const verb =
      status.step === 'restore'
        ? 'Restoring'
        : status.step === 'download'
          ? 'Downloading'
          : status.step === 'backup'
            ? 'Backing up'
            : 'Transferring';
    try {
      const s = engine.progress?.stream;
      if (s && typeof s.on === 'function') {
        s.on('stage::start', ({ stage } = {}) => {
          if (stage) status.phase = `${verb} ${stage}…`;
          refresh();
        });
        s.on('stage::progress', refresh);
        s.on('stage::finish', refresh);
        s.on('transfer::progress', refresh);
      }
    } catch {
      /* progress wiring is best-effort */
    }
    return refresh;
  };

  /* ------------------------------------------------------------ backups */

  const backupDir = () =>
    path.join(strapi.dirs?.app?.root || process.cwd(), '.tmp', 'content-tools-dumps', '_full');

  const getBackupsRaw = async () => (await store().get({ key: BACKUPS_KEY })) || [];
  const listBackups = async () =>
    (await getBackupsRaw())
      .slice()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map((b) => ({ ...b, exists: fs.existsSync(b.file) }));

  const pruneBackups = async () => {
    const all = (await getBackupsRaw()).sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
    for (const old of all.slice(MAX_BACKUPS)) {
      await fs.promises.unlink(old.file).catch(() => {});
    }
    const kept = all.slice(0, MAX_BACKUPS);
    await store().set({ key: BACKUPS_KEY, value: kept });
    return kept;
  };

  const ensureLocalAssetsExist = async () => {
    try {
      const staticPublic = strapi.dirs?.static?.public || path.join(process.cwd(), 'public');
      const uploadsDir = path.join(staticPublic, 'uploads');
      await fs.promises.mkdir(uploadsDir, { recursive: true });
      const files = await strapi.db.query('plugin::upload.file').findMany({ select: ['hash', 'ext', 'formats'] });
      for (const file of files || []) {
        if (file.hash && file.ext) {
          const mainPath = path.join(uploadsDir, `${file.hash}${file.ext}`);
          if (!fs.existsSync(mainPath)) {
            await fs.promises.writeFile(mainPath, Buffer.alloc(0)).catch(() => {});
          }
        }
        if (file.formats && typeof file.formats === 'object') {
          for (const fmt of Object.values(file.formats)) {
            if (fmt && fmt.hash && fmt.ext) {
              const fmtPath = path.join(uploadsDir, `${fmt.hash}${fmt.ext}`);
              if (!fs.existsSync(fmtPath)) {
                await fs.promises.writeFile(fmtPath, Buffer.alloc(0)).catch(() => {});
              }
            }
          }
        }
      }
    } catch (err) {
      strapi.log.warn(`[content-tools] asset check: ${err?.message || err}`);
    }
  };

  // Full native export of the current environment (content + files) to a
  // compressed .tar.gz. Read-only against the DB — safe to run any time.
  const createFullBackup = async (reason = 'pre-pull') => {
    await fs.promises.mkdir(backupDir(), { recursive: true });
    const id = crypto.randomUUID();
    // .tar.gz is appended by the file provider; give it the base path.
    const base = path.join(backupDir(), `${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`);

    const source = dtStrapi.providers.createLocalStrapiSourceProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
    });
    const destination = dtFile.providers.createLocalFileDestinationProvider({
      file: { path: base, maxSizeJsonl: 256 * 1024 * 1024 },
      encryption: { enabled: false },
      compression: { enabled: true },
    });

    const engine = dtEngine.createTransferEngine(source, destination, engineOptions());
    currentEngine = engine;
    status.counts = emptyCounts();
    const refresh = wireProgress(engine);

    await ensureLocalAssetsExist();
    await engine.transfer();
    refresh();
    currentEngine = null;

    const file = `${base}.tar.gz`;
    let bytes = 0;
    try {
      bytes = (await fs.promises.stat(file)).size;
    } catch {
      /* keep 0 */
    }
    const totals = sum(status.counts);
    const meta = {
      id,
      file,
      reason,
      createdAt: new Date().toISOString(),
      entities: totals.entities,
      assets: totals.assets,
      bytes,
    };
    const all = await getBackupsRaw();
    await store().set({ key: BACKUPS_KEY, value: [meta, ...all] });
    await pruneBackups();
    return meta;
  };

  /* ---------------------------------------------------------- download */

  // Phase 1 of a pull: stream the remote environment into a LOCAL .tar.gz.
  // This is the long, network-bound phase — but it writes only to a file, never
  // to the local DB, so the admin stays fully responsive and, crucially, if it
  // fails or is aborted the local data is completely untouched.
  const downloadRemote = async (target) => {
    await fs.promises.mkdir(backupDir(), { recursive: true });
    const id = crypto.randomUUID();
    const base = path.join(
      backupDir(),
      `remote-download-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`
    );

    const source = dtStrapi.providers.createRemoteStrapiSourceProvider({
      url: buildRemoteUrl(target.url),
      auth: { type: 'token', token: target.token },
    });
    const destination = dtFile.providers.createLocalFileDestinationProvider({
      file: { path: base, maxSizeJsonl: 256 * 1024 * 1024 },
      encryption: { enabled: false },
      compression: { enabled: true },
    });

    const engine = dtEngine.createTransferEngine(source, destination, engineOptions());
    currentEngine = engine;
    status.counts = emptyCounts();
    const refresh = wireProgress(engine);
    engine.diagnostics?.onDiagnostic?.(({ kind, details }) => {
      if (kind === 'error') strapi.log.error(`[content-tools] download: ${details?.message}`);
    });

    await engine.transfer();
    refresh();
    currentEngine = null;

    const file = `${base}.tar.gz`;
    let bytes = 0;
    try {
      bytes = (await fs.promises.stat(file)).size;
    } catch {
      throw fail('BadRequest', 'Download produced no file — the source may be unreachable', 400);
    }
    const totals = sum(status.counts);
    return { file, entities: totals.entities, assets: totals.assets, bytes };
  };

  /* ------------------------------------------------------------- restore */

  // Restore a .tar.gz (a backup, or a freshly downloaded remote snapshot) into
  // this environment. Delete-then-import from a LOCAL file — fast and offline,
  // so the destructive DB window is short and predictable.
  const restoreFromFile = async (file) => {
    if (!fs.existsSync(file)) throw fail('BadRequest', 'Archive file is missing on disk', 400);

    const source = dtFile.providers.createLocalFileSourceProvider({
      file: { path: file },
      encryption: { enabled: false },
      compression: { enabled: true },
    });
    const destination = dtStrapi.providers.createLocalStrapiDestinationProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
      strategy: 'restore',
      restore: {
        entities: { exclude: IGNORED_CONTENT_TYPES },
        assets: true,
        configuration: { webhook: false, coreStore: false },
      },
    });

    const engine = dtEngine.createTransferEngine(source, destination, engineOptions());
    currentEngine = engine;
    status.counts = emptyCounts();
    const refresh = wireProgress(engine);
    await engine.transfer();
    refresh();
    currentEngine = null;
  };

  // Public: restore an arbitrary saved backup by id (manual "undo").
  const restoreBackup = async ({ backupId }) => {
    if (status.running) throw fail('ConflictError', 'A transfer is already running', 409);
    const meta = (await getBackupsRaw()).find((b) => b.id === backupId);
    if (!meta) throw fail('BadRequest', 'Unknown backup', 400);
    status = {
      ...status,
      running: true,
      step: 'restore',
      phase: 'Restoring backup…',
      error: null,
      stopRequested: false,
      counts: emptyCounts(),
      percent: null,
      estimate: { entities: meta.entities, assets: meta.assets },
      startedAt: Date.now(),
      finishedAt: null,
    };
    try {
      await restoreFromFile(meta.file);
      status = { ...status, running: false, step: 'done', phase: 'Backup restored', percent: 100, finishedAt: Date.now() };
    } catch (err) {
      currentEngine = null;
      status = { ...status, running: false, step: 'failed', phase: 'Restore failed', error: err?.message || String(err), finishedAt: Date.now() };
      throw err;
    }
    return status;
  };

  /* --------------------------------------------------------------- probe */

  // Fast pre-flight "test": can we reach the target, does the token work, and do
  // the Strapi versions match? Returns quickly without transferring anything.
  const probe = async ({ targetId }) => {
    const target = await findTarget(targetId);
    if (!target.token) throw fail('BadRequest', 'This target has no transfer token', 400);
    let url;
    try {
      url = buildRemoteUrl(target.url);
    } catch {
      throw fail('BadRequest', 'Invalid target URL', 400);
    }

    const source = dtStrapi.providers.createRemoteStrapiSourceProvider({
      url,
      auth: { type: 'token', token: target.token },
    });

    const localVersion = strapi.config.get('info.strapi') || strapi.config.info?.strapi || null;
    try {
      if (typeof source.bootstrap === 'function') await source.bootstrap();
      let remoteVersion = null;
      try {
        const meta = typeof source.getMetadata === 'function' ? await source.getMetadata() : null;
        remoteVersion = meta?.strapi?.version ?? null;
      } catch {
        /* metadata optional */
      }
      return {
        ok: true,
        reachable: true,
        remoteVersion,
        localVersion,
        versionMatch: remoteVersion ? remoteVersion === localVersion : null,
      };
    } catch (err) {
      return {
        ok: false,
        reachable: false,
        error: err?.message || String(err),
        localVersion,
      };
    } finally {
      try {
        if (typeof source.close === 'function') await source.close();
      } catch {
        /* ignore */
      }
    }
  };

  /* ---------------------------------------------------------------- pull */

  // Background chain, three phases:
  //   1. backup   — export current data to a local tar (rollback point)
  //   2. download — stream the remote into a local tar (NON-destructive)
  //   3. restore  — delete-then-import the downloaded tar (the only destructive
  //                 step; runs from a fast local file, short DB-lock window)
  // A failure or stop in phase 1/2 leaves local data untouched. A failure in
  // phase 3 rolls back to the phase-1 backup.
  const runJob = async (target) => {
    // 1) Full safety backup of the current data.
    status = { ...status, step: 'backup', phase: 'Backing up current data…', counts: emptyCounts(), percent: null };
    let backup = null;
    try {
      backup = await createFullBackup('pre-pull');
      status = { ...status, backup };
    } catch (err) {
      currentEngine = null;
      status = {
        ...status,
        running: false,
        step: 'failed',
        phase: 'Backup failed — pull aborted (data untouched)',
        error: err?.message || String(err),
        finishedAt: Date.now(),
      };
      strapi.log.error(`[content-tools] pre-pull backup failed, pull aborted: ${err?.stack || err}`);
      return;
    }

    if (status.stopRequested) {
      status = { ...status, running: false, step: 'stopped', phase: 'Stopped before any change', finishedAt: Date.now() };
      return;
    }

    // 2) Download the remote into a local tar. Nothing local is touched yet, so
    // a slow/broken source or a Force stop here is completely safe.
    status = { ...status, step: 'download', phase: 'Downloading from source…', counts: emptyCounts(), percent: null };
    let download = null;
    try {
      download = await downloadRemote(target);
    } catch (err) {
      currentEngine = null;
      const stopped = status.stopRequested;
      status = {
        ...status,
        running: false,
        step: stopped ? 'stopped' : 'failed',
        phase: stopped
          ? 'Stopped during download — local data untouched'
          : 'Download failed — local data untouched',
        error: stopped ? null : err?.message || String(err),
        finishedAt: Date.now(),
      };
      strapi.log.warn(`[content-tools] download ${stopped ? 'stopped' : 'failed'}: ${err?.message || err}`);
      return;
    }

    if (status.stopRequested) {
      await fs.promises.unlink(download.file).catch(() => {});
      status = { ...status, running: false, step: 'stopped', phase: 'Stopped after download — local data untouched', finishedAt: Date.now() };
      return;
    }

    // 3) Apply the downloaded snapshot. The estimate is now EXACT (we know the
    // tar's counts), so the restore progress bar is accurate.
    status = {
      ...status,
      step: 'restore',
      phase: 'Applying downloaded data…',
      counts: emptyCounts(),
      percent: null,
      estimate: { entities: download.entities, assets: download.assets },
    };
    try {
      await restoreFromFile(download.file);
      await store().set({
        key: ESTIMATE_KEY,
        value: { entities: download.entities, assets: download.assets },
      });
      await fs.promises.unlink(download.file).catch(() => {});
      status = { ...status, running: false, step: 'done', phase: 'Pull finished', percent: 100, finishedAt: Date.now() };
      strapi.log.info('[content-tools] data transfer completed');
    } catch (err) {
      currentEngine = null;
      const stopped = status.stopRequested;
      strapi.log.warn(
        `[content-tools] restore ${stopped ? 'stopped by user' : 'failed'}: ${err?.message || err}`
      );
      // Roll back to the pre-pull backup so you are never left half-restored.
      status = { ...status, phase: 'Rolling back to pre-pull backup…', percent: null, counts: emptyCounts() };
      try {
        await restoreFromFile(backup.file);
        await fs.promises.unlink(download.file).catch(() => {});
        status = {
          ...status,
          running: false,
          step: stopped ? 'stopped' : 'failed',
          phase: stopped ? 'Stopped — restored pre-pull backup' : 'Failed — restored pre-pull backup',
          error: stopped ? null : err?.message || String(err),
          percent: 100,
          finishedAt: Date.now(),
        };
        strapi.log.info('[content-tools] rolled back to pre-pull backup');
      } catch (restoreErr) {
        currentEngine = null;
        status = {
          ...status,
          running: false,
          step: 'failed',
          phase: 'Restore failed AND rollback failed — restore manually from the backup',
          error: `restore: ${err?.message || err}; rollback: ${restoreErr?.message || restoreErr}`,
          finishedAt: Date.now(),
        };
        strapi.log.error(`[content-tools] rollback failed: ${restoreErr?.stack || restoreErr}`);
      }
    }
  };

  const pull = async ({ targetId }) => {
    if (status.running) throw fail('ConflictError', 'A transfer is already running', 409);

    const target = await findTarget(targetId);
    if (!target.token) throw fail('BadRequest', 'This target has no transfer token', 400);
    try {
      buildRemoteUrl(target.url);
    } catch {
      throw fail('BadRequest', 'Invalid target URL', 400);
    }

    status = {
      running: true,
      step: 'backup',
      phase: 'Starting…',
      targetId: target.id,
      targetName: target.name,
      counts: emptyCounts(),
      estimate: null,
      percent: null,
      backup: null,
      error: null,
      stopRequested: false,
      startedAt: Date.now(),
      finishedAt: null,
    };

    // Fire-and-forget; the admin page polls getStatus().
    runJob(target).catch((err) => {
      currentEngine = null;
      status = {
        ...status,
        running: false,
        step: 'failed',
        phase: 'failed',
        error: err?.message || String(err),
        finishedAt: Date.now(),
      };
      strapi.log.error(`[content-tools] data transfer job crashed: ${err?.stack || err}`);
    });

    return status;
  };

  // Force stop: flag it, then abort the live engine. The runJob catch handler
  // detects stopRequested and restores the pre-pull backup.
  const stop = async () => {
    if (!status.running) throw fail('BadRequest', 'No transfer is running', 400);
    status = { ...status, stopRequested: true, phase: 'Stopping…' };
    try {
      if (currentEngine && typeof currentEngine.abortTransfer === 'function') {
        await currentEngine.abortTransfer();
      }
    } catch (err) {
      strapi.log.warn(`[content-tools] abortTransfer: ${err?.message || err}`);
    }
    return status;
  };

  return {
    listTargets,
    saveTargets,
    getStatus,
    probe,
    pull,
    stop,
    listBackups,
    restoreBackup,
  };
};
