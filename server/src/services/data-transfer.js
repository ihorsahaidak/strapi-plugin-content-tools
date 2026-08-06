'use strict';

/**
 * Pull all content + media from a remote Strapi environment into this one.
 * Content uses the built-in @strapi/data-transfer engine (same as the
 * `strapi transfer` CLI); media uses a custom step (see below).
 *
 * Safety model:
 *   1. backup  — OPTIONAL (the user picks "Backup & pull" or "Just pull").
 *                Exports the current environment's CONTENT to a local .tar —
 *                the rollback point. Media is deliberately not archived; see
 *                createFullBackup for why that's both safe and much faster.
 *   2. content — restore directly from the remote into this Strapi
 *                (remote source → local Strapi destination, strategy 'restore').
 *   3. media   — best-effort; a broken/missing asset is logged and never rolls
 *                back the content that already committed.
 *
 * Nothing is ever restored silently. Stop offers two explicit choices —
 * "Stop" (keep what landed, backup stays available) and "Stop & roll back"
 * (restore now) — and a pull that fails on its own just reports it and leaves
 * the backup for the admin page to offer.
 *
 * Why content is direct (not via an intermediate tar): routing it through a
 * local .tar.gz file broke on real data — the tar destination requires every
 * asset's bytes to match the source's stored size (mismatched/broken media →
 * ERR_STREAM_DESTROYED, whole transfer aborts) and couldn't reliably carry a
 * cloud source's schemas ("Could not load schemas from Strapi data file").
 * Version/schema strategies are 'ignore' so a source whose schema differs from
 * local still imports whatever content matches.
 *
 * Why media does NOT use the data-transfer engine's assets stage: that stage
 * resolves each asset's local file-entity id via an in-memory map that is only
 * populated by the entities stage of the SAME engine run/transaction. Content
 * and media are deliberately two separate runs (so a broken asset can never
 * roll back already-committed content), which means that map is always empty
 * for a media-only run — every asset write fails immediately with "File ID not
 * found", so the built-in path can never actually deliver a byte. Instead, once
 * content has committed, `plugin::upload.file` rows already carry the source's
 * hash/url/formats verbatim; we fetch each file's original bytes over plain
 * HTTP from the source and regenerate the responsive formats/thumbnail locally
 * with Strapi's own image-manipulation + upload-provider services (the same
 * ones a normal upload uses) — this is also what makes the pulled images
 * actually resizable, visible in the admin, and servable to the website
 * without depending on the source host's CSP/CORS/whitelisting at all.
 *
 * The job runs in the background; the admin page polls getStatus() for live
 * entity/asset counts (shown as done / total) and a percentage. The entities
 * total comes from the pre-pull backup just taken (a fresh, accurate proxy for
 * scale); the media total is the exact `plugin::upload.file` row count once
 * content has committed. Stop aborts the running engine
 * (engine.abortTransfer()). The connection pool (DATABASE_POOL_MAX) must have
 * headroom or the admin can starve while the restore holds connections.
 *
 * Saved targets ({ id, name, url, token }) live in the plugin store.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const {
  engine: dtEngine,
  strapi: dtStrapi,
  file: dtFile,
} = require('@strapi/data-transfer');

const TARGETS_KEY = 'dataTransferTargets';
const BACKUPS_KEY = 'dataTransferBackups'; // [{ id, file, createdAt, entities, assets, bytes, reason }]
const MAX_BACKUPS = 1; // keep only the most recent pre-pull backup

// Models the transfer must never touch. This list is passed as the restore's
// `entities.exclude`, which is what actually protects a model from deletion.
//
// CRITICAL: the restore's delete phase (deleteEntitiesRecords) wipes EVERY
// registered model that isn't in this list — including the internal
// `strapi::core-store` and `strapi::webhook` models. `configuration.coreStore`
// only guards a separate delete path, NOT this one. If core-store isn't excluded
// here, a content-only pull deletes it and never re-inserts it, which erases all
// content-manager configuration + the content-types schema snapshot and leaves
// Strapi unable to boot (content-releases migration crashes on the null schema).
const IGNORED_CONTENT_TYPES = [
  // Internal config/state models — deleting these breaks the admin / boot.
  'strapi::core-store',
  'strapi::webhook',
  // Admin accounts / tokens / audit — restoring these could lock you out.
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

const fmtInt = (n) => (n ?? 0).toLocaleString('en-US');

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

  // Cheap local entity count (COUNT queries only, no export) — used as the
  // progress-bar denominator when the backup step is skipped, since that
  // step is normally what produces this number "for free".
  const countLocalEntities = async () => {
    let total = 0;
    for (const uid of Object.keys(strapi.contentTypes)) {
      if (!notIgnored(uid)) continue;
      try {
        total += await strapi.db.query(uid).count();
      } catch {
        /* best-effort estimate only */
      }
    }
    return total;
  };

  // Slow/large remote assets can stall the source stream; the default 15s kills
  // them (→ ERR_STREAM_DESTROYED). Give assets much longer to arrive.
  const REMOTE_STREAM_TIMEOUT = 180000;

  // Per-file cap for the media pull's own downloads. Generous enough for a
  // large original over a slow link, short enough that one dead URL costs
  // seconds rather than wedging the run.
  const ASSET_FETCH_TIMEOUT = 60000;

  // Engine config. `only` selects which stage group(s) transfer:
  //   ['content']          → entities + links (+ schemas, always)
  //   ['files']            → media assets only
  //   ['content','files']  → everything
  //
  // Strategies are LENIENT on purpose: the local schema/version can differ from
  // the source (preprod). 'ignore' skips schema-diff enforcement so we still
  // pull whatever content matches instead of aborting the whole transfer; fields
  // that only exist on one side are simply not carried over.
  const engineOptions = (only = ['content', 'files']) => ({
    versionStrategy: 'ignore',
    schemaStrategy: 'ignore',
    only,
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
  const listBackups = async () => {
    // Self-heal retention: drop anything beyond MAX_BACKUPS (and its file) so
    // lowering the limit takes effect on the next refresh, not the next pull.
    const kept = await pruneBackups();
    return kept
      .slice()
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .map((b) => ({ ...b, exists: fs.existsSync(b.file) }));
  };

  const pruneBackups = async () => {
    const all = (await getBackupsRaw()).sort((a, b) =>
      (b.createdAt || '').localeCompare(a.createdAt || '')
    );
    const kept = all.slice(0, MAX_BACKUPS);
    // Only touch disk + core_store when there is actually something to prune —
    // writing core_store on every listBackups() poll caused lock contention.
    if (kept.length !== all.length) {
      for (const old of all.slice(MAX_BACKUPS)) {
        await fs.promises.unlink(old.file).catch(() => {});
      }
      await store().set({ key: BACKUPS_KEY, value: kept });
    }
    return kept;
  };

  // Drop a backup once it's served its purpose (a successful pull needs no
  // undo path; a successful restore has already been applied). Keeps the
  // "Backups" panel showing only a backup that's actually still relevant —
  // i.e. one left behind by a pull that failed and hasn't been resolved yet.
  const discardBackup = async (id) => {
    if (!id) return;
    const all = await getBackupsRaw();
    const match = all.find((b) => b.id === id);
    if (!match) return;
    await fs.promises.unlink(match.file).catch(() => {});
    await store().set({ key: BACKUPS_KEY, value: all.filter((b) => b.id !== id) });
  };

  // Native export of the current environment's CONTENT to a local .tar.
  // Read-only against the DB — safe to run any time.
  //
  // Deliberately content-only and uncompressed, because both of those were
  // what made the backup (and therefore the rollback) slow:
  //   - Media bytes dominate the archive size, and backing them up is
  //     unnecessary here: a content-only pull never touches public/uploads
  //     (the restore's deleteAllAssets/handleAssetsBackup both early-return
  //     when `restore.assets` is false), and our media step only ever ADDS
  //     files under the source's hashes — it never deletes the old ones. So
  //     the previous media bytes are still on disk at rollback time, and the
  //     restored rows point straight back at them.
  //   - gzip of the JSONL is pure CPU for a file that never leaves this disk.
  // This also removes the need for the old zero-byte-placeholder workaround
  // (the tar destination demanded every asset's bytes match its stored size,
  // so missing/broken media used to abort the export).
  const createFullBackup = async (reason = 'pre-pull') => {
    await fs.promises.mkdir(backupDir(), { recursive: true });
    const id = crypto.randomUUID();
    // The extension is appended by the file provider; give it the base path.
    const base = path.join(backupDir(), `${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}-${id.slice(0, 8)}`);

    const source = dtStrapi.providers.createLocalStrapiSourceProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
    });
    const destination = dtFile.providers.createLocalFileDestinationProvider({
      file: { path: base, maxSizeJsonl: 256 * 1024 * 1024 },
      encryption: { enabled: false },
      compression: { enabled: false },
    });

    const engine = dtEngine.createTransferEngine(source, destination, engineOptions(['content']));
    currentEngine = engine;
    status.counts = emptyCounts();
    const refresh = wireProgress(engine);

    await engine.transfer();
    refresh();
    currentEngine = null;

    // Matches the provider's archivePath: `${path}.tar` (+ .gz only when
    // compression is enabled, which it isn't).
    const file = `${base}.tar`;
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
      assets: totals.assets, // 0 — media is intentionally not archived, see above
      bytes,
    };
    const all = await getBackupsRaw();
    await store().set({ key: BACKUPS_KEY, value: [meta, ...all] });
    await pruneBackups();
    return meta;
  };

  /* ------------------------------------------------------- direct pull */

  // Pull content directly from the remote into this environment (remote →
  // local Strapi, strategy 'restore'). Only entities + links — media is
  // handled separately by pullMediaFromTarget (see the file header for why).
  //
  // No intermediate tar file: the tar destination demanded each asset's bytes
  // match the source's stored size and aborted on the first mismatch
  // (ERR_STREAM_DESTROYED), and couldn't carry a cloud source's schemas
  // ("Could not load schemas from Strapi data file"). The Strapi destination
  // writes assets straight to disk (tolerant) and reads schemas live from each
  // side; with the lenient strategies it imports whatever content matches.
  const runDirectTransfer = async (target, { only }) => {
    const source = dtStrapi.providers.createRemoteStrapiSourceProvider({
      url: buildRemoteUrl(target.url),
      auth: { type: 'token', token: target.token },
      streamTimeout: REMOTE_STREAM_TIMEOUT,
    });
    const destination = dtStrapi.providers.createLocalStrapiDestinationProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
      strategy: 'restore',
      restore: {
        entities: { exclude: IGNORED_CONTENT_TYPES },
        assets: only.includes('files'),
        configuration: { webhook: false, coreStore: false },
      },
    });

    const engine = dtEngine.createTransferEngine(source, destination, engineOptions(only));
    currentEngine = engine;
    status.counts = emptyCounts();
    const refresh = wireProgress(engine);
    engine.diagnostics?.onDiagnostic?.(({ kind, details }) => {
      if (kind === 'error') strapi.log.error(`[content-tools] pull: ${details?.message}`);
    });

    await engine.transfer();
    refresh();
    currentEngine = null;
    return sum(status.counts);
  };

  /* -------------------------------------------------------- media pull */

  // Turn a file's stored `url` into a fetchable absolute URL against the
  // source environment. Source rows almost always carry an absolute URL
  // already (their own provider's CDN/host); relative ones are resolved
  // against the source's base URL just in case.
  const resolveSourceAssetUrl = (target, url) => {
    if (/^https?:\/\//i.test(url)) return url;
    const base = target.url.replace(/\/+$/, '');
    return `${base}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // Only the fields the upload provider / image-manipulation service actually
  // read/write — dropping the rest (getStream, filepath, tmpWorkingDirectory)
  // keeps what we persist to the `formats` JSON column identical in shape to
  // what a normal upload produces.
  const toStoredFormat = (f) => ({
    name: f.name,
    hash: f.hash,
    ext: f.ext,
    mime: f.mime,
    path: f.path ?? null,
    width: f.width,
    height: f.height,
    size: f.size,
    sizeInBytes: f.sizeInBytes,
    url: f.url,
  });

  // Fetch one file's original bytes from the source and re-run it through
  // Strapi's own upload pipeline locally: upload the original via the
  // configured provider, then (for resizable images) generate + upload a
  // thumbnail and the configured responsive formats — exactly what a normal
  // upload does, so the result is guaranteed to render in the admin and be
  // servable to the website.
  const pullOneFile = async (file, { target, imageManip, providerService, uploadConfig, tmpDir }) => {
    const sourceUrl = resolveSourceAssetUrl(target, file.url);
    // Always bound the fetch. Without a timeout a single unresponsive asset
    // stalls the whole media loop with no way out — and because the response
    // body must be consumed or cancelled to free the connection, a leaked
    // pending request eventually saturates the HTTP agent and wedges every
    // later file too.
    const res = await fetch(sourceUrl, { signal: AbortSignal.timeout(ASSET_FETCH_TIMEOUT) });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      throw new Error(`HTTP ${res.status} fetching ${sourceUrl}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());

    const fileData = {
      name: file.name,
      hash: file.hash,
      ext: file.ext,
      mime: file.mime,
      tmpWorkingDirectory: tmpDir,
      getStream: () => Readable.from(buffer),
    };

    // Upload the original — mutates fileData.url to the local provider's URL.
    await providerService.upload(fileData);
    const update = { url: fileData.url, provider: uploadConfig.provider || 'local' };

    if (await imageManip.isImage(fileData)) {
      const { width, height } = await imageManip.getDimensions(fileData);
      Object.assign(fileData, { width, height });
      update.width = width;
      update.height = height;

      if (await imageManip.isResizableImage(fileData)) {
        const formats = {};
        const thumbnail = await imageManip.generateThumbnail(fileData);
        if (thumbnail) {
          await providerService.upload(thumbnail);
          formats.thumbnail = toStoredFormat(thumbnail);
        }
        const responsive = await imageManip.generateResponsiveFormats(fileData);
        for (const entry of responsive) {
          if (!entry) continue;
          await providerService.upload(entry.file);
          formats[entry.key] = toStoredFormat(entry.file);
        }
        if (Object.keys(formats).length) update.formats = formats;
      }
    }

    await strapi.db.query('plugin::upload.file').update({ where: { id: file.id }, data: update });
  };

  // Download + regenerate every locally-known media file from `target`.
  // Runs AFTER content has committed, so `plugin::upload.file` rows already
  // exist locally with the source's hash/url/mime copied verbatim — we just
  // need the bytes. `onProgress(done, total)` drives the "X / Y" UI counter.
  const pullMediaFromTarget = async (target, { onProgress, isStopped } = {}) => {
    const uploadConfig = strapi.config.get('plugin::upload');
    const imageManip = strapi.plugin('upload').service('image-manipulation');
    const providerService = strapi.plugin('upload').service('provider');

    const files = await strapi.db.query('plugin::upload.file').findMany({
      select: ['id', 'name', 'hash', 'ext', 'mime', 'url'],
    });
    const total = files.length;
    let done = 0;
    let failed = 0;

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'content-tools-media-'));
    try {
      for (const file of files) {
        if (isStopped?.()) break;
        try {
          await pullOneFile(file, { target, imageManip, providerService, uploadConfig, tmpDir });
        } catch (err) {
          failed += 1;
          strapi.log.warn(
            `[content-tools] media pull: "${file.name}" (#${file.id}) — ${err?.message || err}`
          );
        }
        done += 1;
        onProgress?.(done, total);
      }
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
    return { done, total, failed };
  };

  /* ------------------------------------------------------------- restore */

  // Restore a backup .tar into this environment (delete-then-import from a
  // LOCAL file — fast and offline, short destructive window).
  //
  // Content-only, matching what createFullBackup writes. Keeping assets OUT of
  // the restore is also what makes the rollback safe AND fast: with
  // `restore.assets` false the destination skips deleteAllAssets and
  // handleAssetsBackup entirely, so public/uploads is never moved aside or
  // emptied — the pre-pull media bytes stay exactly where they are and the
  // restored rows point back at them.
  const restoreFromFile = async (file, only = ['content']) => {
    if (!fs.existsSync(file)) throw fail('BadRequest', 'Archive file is missing on disk', 400);

    const source = dtFile.providers.createLocalFileSourceProvider({
      file: { path: file },
      encryption: { enabled: false },
      compression: { enabled: false },
    });
    const destination = dtStrapi.providers.createLocalStrapiDestinationProvider({
      getStrapi: () => strapi,
      autoDestroy: false,
      strategy: 'restore',
      restore: {
        entities: { exclude: IGNORED_CONTENT_TYPES },
        assets: only.includes('files'),
        configuration: { webhook: false, coreStore: false },
      },
    });

    const engine = dtEngine.createTransferEngine(source, destination, engineOptions(only));
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
      // The backup has done its job — drop it so the panel doesn't accumulate
      // stale "resolved" backups.
      await discardBackup(backupId);
      status = { ...status, running: false, step: 'done', phase: 'Backup restored', percent: 100, finishedAt: Date.now() };
    } catch (err) {
      currentEngine = null;
      status = { ...status, running: false, step: 'failed', phase: 'Restore failed — backup kept, you can try again', error: err?.message || String(err), finishedAt: Date.now() };
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

  // Resolve a user-initiated stop. Two flavours, chosen when Stop is pressed:
  //   - plain stop (rollbackOnStop false) → leave whatever already committed
  //     in place and keep the backup, so it can still be applied manually.
  //   - stop & roll back                  → restore the pre-pull backup now.
  // With no backup for this run (the backup step was skipped) there is nothing
  // to roll back to either way — say so rather than pretending.
  const stopAndFinish = async (backup) => {
    if (!backup) {
      status = {
        ...status,
        running: false,
        step: 'stopped',
        phase: 'Stopped — no backup was taken (skipped), local data was not reverted',
        percent: null,
        finishedAt: Date.now(),
      };
      return;
    }
    if (!status.rollbackOnStop) {
      status = {
        ...status,
        running: false,
        step: 'stopped',
        phase: 'Stopped — partial data kept. Apply the backup below to undo it.',
        percent: null,
        finishedAt: Date.now(),
      };
      return;
    }
    status = { ...status, step: 'restore', phase: 'Rolling back to pre-pull backup…', percent: null, counts: emptyCounts() };
    try {
      await restoreFromFile(backup.file);
      await discardBackup(backup.id);
      status = { ...status, running: false, step: 'stopped', phase: 'Stopped — restored pre-pull backup', percent: 100, finishedAt: Date.now() };
      strapi.log.info('[content-tools] rolled back to pre-pull backup');
    } catch (restoreErr) {
      currentEngine = null;
      status = {
        ...status,
        running: false,
        step: 'failed',
        phase: 'Rollback failed — restore manually from the backup below',
        error: `rollback failed: ${restoreErr?.message || restoreErr}`,
        finishedAt: Date.now(),
      };
      strapi.log.error(`[content-tools] rollback failed: ${restoreErr?.stack || restoreErr}`);
    }
  };

  // Background chain:
  //   1. backup  — optional (includeBackup); export current data to a local
  //                tar (rollback point). Skipping it trades away the safety
  //                net for a faster pull: Force stop / a failure can then only
  //                report what happened, not undo it.
  //   2. content — direct remote→local restore of entities + links ONLY.
  //                Schema/version-lenient. Commits on its own. On Force stop
  //                it rolls back automatically (if a backup exists); on any
  //                OTHER failure the backup (if any) is left in place and the
  //                job just reports "failed" — the admin page asks before
  //                applying it, it's never restored silently.
  //   3. media   — skipped when includeMedia is false. Downloads each file's
  //                bytes from the source and regenerates its thumbnail/
  //                responsive formats locally (see pullMediaFromTarget).
  //                Best effort; never rolls back content.
  //   On success (or a stopped-and-rolled-back run) the backup is discarded —
  //   only a genuinely failed, unresolved pull leaves one behind.
  const runJob = async (target, { includeMedia, includeBackup }) => {
    // How many entities this environment currently holds. Doubles as the
    // progress denominator for BOTH the backup (which exports exactly these)
    // and the pull that follows, so neither phase sits on "estimating…".
    const localEntities = await countLocalEntities();

    // 1) Content backup of the current data (optional).
    let backup = null;
    if (includeBackup) {
      status = {
        ...status,
        step: 'backup',
        phase: 'Backing up current content…',
        counts: emptyCounts(),
        percent: localEntities ? 0 : null,
        estimate: { entities: localEntities, assets: 0 },
      };
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
        await discardBackup(backup.id);
        return;
      }
    } else if (status.stopRequested) {
      status = { ...status, running: false, step: 'stopped', phase: 'Stopped before any change', finishedAt: Date.now() };
      return;
    }

    // Denominator for the pull: what the backup actually exported if we took
    // one (exact), else this environment's live count from above. Either is
    // only a proxy for the source's size, but it's the right order of scale.
    const estEntities = backup ? backup.entities || localEntities : localEntities;

    // 2) Pull CONTENT (entities + links) — this is the important part and it
    // commits on its own, independent of media.
    status = {
      ...status,
      step: 'transfer',
      phase: 'Pulling content…',
      counts: emptyCounts(),
      percent: estEntities ? 0 : null,
      estimate: { entities: estEntities, assets: 0 },
    };
    let content;
    try {
      content = await runDirectTransfer(target, { only: ['content'] });
    } catch (err) {
      currentEngine = null;
      const stopped = status.stopRequested;
      strapi.log.warn(`[content-tools] content pull ${stopped ? 'stopped by user' : 'failed'}: ${err?.message || err}`);
      if (stopped) {
        await stopAndFinish(backup);
      } else {
        // Genuine failure: do NOT auto-restore. Keep the backup (if any) and
        // let the admin page ask whether to apply it.
        status = {
          ...status,
          running: false,
          step: 'failed',
          phase: backup
            ? 'Pull failed — content may be partially updated. Apply the backup below to undo it.'
            : 'Pull failed — content may be partially updated. No backup was taken (skipped), so this cannot be undone.',
          error: err?.message || String(err),
          finishedAt: Date.now(),
        };
      }
      return;
    }

    // 3) Pull + resize MEDIA (optional). A broken asset here is logged and
    // NEVER rolls back the content that already committed.
    let media = { done: 0, total: 0, failed: 0 };
    if (includeMedia && !status.stopRequested) {
      const mediaTotal = await strapi.db.query('plugin::upload.file').count();
      status = {
        ...status,
        step: 'assets',
        phase: `Downloading & resizing media…`,
        counts: emptyCounts(),
        percent: mediaTotal ? 0 : null,
        estimate: { entities: 0, assets: mediaTotal },
      };
      media = await pullMediaFromTarget(target, {
        isStopped: () => status.stopRequested,
        onProgress: (done, total) => {
          status.counts = { ...status.counts, assets: { count: done, bytes: status.counts.assets.bytes } };
          status.phase = `Downloading & resizing media… (${done} / ${total})`;
          status.percent = total ? Math.max(0, Math.min(99, Math.round((done / total) * 100))) : null;
        },
      });
      if (media.failed) {
        strapi.log.warn(`[content-tools] media pull: ${media.failed}/${media.total} file(s) could not be resized`);
      }
    }

    // Force stop (after content committed) → honour the rollback promise.
    if (status.stopRequested) {
      await stopAndFinish(backup);
      return;
    }

    // Success: the backup (if one was taken) has served its purpose, drop it.
    if (backup) await discardBackup(backup.id);
    status = {
      ...status,
      running: false,
      step: 'done',
      phase: !includeMedia
        ? `Pull finished — content only (media skipped), ${fmtInt(content.entities)} entities`
        : media.failed
          ? `Pull finished — ${fmtInt(content.entities)} entities, ${media.done - media.failed}/${media.total} media resized (${media.failed} had issues, see logs)`
          : `Pull finished — ${fmtInt(content.entities)} entities, ${media.done}/${media.total} media resized`,
      percent: 100,
      finishedAt: Date.now(),
    };
    strapi.log.info(
      `[content-tools] data transfer completed (media ${!includeMedia ? 'skipped' : media.failed ? 'partial' : 'ok'})`
    );
  };

  const pull = async ({ targetId, skipMedia, skipBackup }) => {
    if (status.running) throw fail('ConflictError', 'A transfer is already running', 409);

    const target = await findTarget(targetId);
    if (!target.token) throw fail('BadRequest', 'This target has no transfer token', 400);
    try {
      buildRemoteUrl(target.url);
    } catch {
      throw fail('BadRequest', 'Invalid target URL', 400);
    }

    const includeMedia = !skipMedia;
    const includeBackup = !skipBackup;
    status = {
      running: true,
      step: includeBackup ? 'backup' : 'transfer',
      phase: 'Starting…',
      targetId: target.id,
      targetName: target.name,
      includeMedia,
      includeBackup,
      counts: emptyCounts(),
      estimate: null,
      percent: null,
      backup: null,
      error: null,
      stopRequested: false,
      rollbackOnStop: false, // set by stop({ rollback: true })
      startedAt: Date.now(),
      finishedAt: null,
    };

    // Fire-and-forget; the admin page polls getStatus().
    runJob(target, { includeMedia, includeBackup }).catch((err) => {
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

  // How long to wait for an aborted engine to actually settle before we stop
  // believing it will. abortTransfer() only flips a flag and aborts the stream
  // controller — if a stage is blocked on a socket that never returns, the
  // pipeline promise stays pending forever and `await engine.transfer()` never
  // resolves, which used to leave the page stuck on "Stopping…" indefinitely.
  const ABORT_SETTLE_GRACE = 20000;

  // Stop: flag it, then abort the live engine. runJob notices stopRequested and
  // hands off to stopAndFinish, which either keeps the partial data (default)
  // or restores the pre-pull backup when `rollback` was asked for.
  const stop = async ({ rollback } = {}) => {
    if (!status.running) throw fail('BadRequest', 'No transfer is running', 400);
    status = {
      ...status,
      stopRequested: true,
      rollbackOnStop: !!rollback,
      phase: rollback ? 'Stopping and rolling back…' : 'Stopping…',
    };
    try {
      if (currentEngine && typeof currentEngine.abortTransfer === 'function') {
        // Note: abortTransfer() always throws ('Transfer aborted.') by design.
        await currentEngine.abortTransfer();
      }
    } catch (err) {
      strapi.log.warn(`[content-tools] abortTransfer: ${err?.message || err}`);
    }

    // Safety net: if the job hasn't resolved itself by now, stop reporting it
    // as running so the admin page isn't wedged. The orphaned stage may still
    // be winding down in the background — say so instead of pretending it's
    // clean, and don't touch the backup (it stays listed and applyable).
    const startedAt = status.startedAt;
    setTimeout(() => {
      if (status.running && status.stopRequested && status.startedAt === startedAt) {
        strapi.log.warn('[content-tools] stop: engine did not settle in time, releasing the job');
        status = {
          ...status,
          running: false,
          step: 'stopped',
          phase:
            'Stopped — the transfer did not shut down cleanly. Check the data, and apply the backup below if you need to undo.',
          finishedAt: Date.now(),
        };
        currentEngine = null;
      }
    }, ABORT_SETTLE_GRACE).unref?.();

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
