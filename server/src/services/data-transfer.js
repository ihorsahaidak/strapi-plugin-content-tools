'use strict';

/**
 * Pull all data from a remote Strapi environment into this one, using the
 * built-in @strapi/data-transfer engine (same as the `strapi transfer` CLI).
 *
 * Saved targets ({ id, name, url, token }) live in the plugin store. The pull
 * runs as a background job; the admin page polls getStatus().
 */

const crypto = require('crypto');
const { engine: dtEngine, strapi: dtStrapi } = require('@strapi/data-transfer');

const TARGETS_KEY = 'dataTransferTargets';

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

// Single in-process job (one server process).
let status = {
  running: false,
  targetId: null,
  targetName: null,
  phase: null,
  error: null,
  startedAt: null,
  finishedAt: null,
};

const fail = (name, message, code) => {
  const err = new Error(message);
  err.name = name;
  err.status = code;
  return err;
};

module.exports = ({ strapi }) => {
  const store = () => strapi.store({ type: 'plugin', name: 'content-tools' });

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

  const runTransfer = async (target) => {
    const source = dtStrapi.providers.createRemoteStrapiSourceProvider({
      url: buildRemoteUrl(target.url),
      auth: { type: 'token', token: target.token },
    });

    const destination = dtStrapi.providers.createLocalStrapiDestinationProvider({
      getStrapi: () => strapi,
      autoDestroy: false, // don't tear down the running instance
      strategy: 'restore',
      restore: {
        entities: { exclude: IGNORED_CONTENT_TYPES },
        assets: true,
        configuration: { webhook: true, coreStore: true },
      },
    });

    const notIgnored = (uid) => !IGNORED_CONTENT_TYPES.includes(uid);
    const transferEngine = dtEngine.createTransferEngine(source, destination, {
      versionStrategy: 'exact',
      schemaStrategy: 'strict',
      transforms: {
        links: [{ filter: (link) => notIgnored(link.left?.type) && notIgnored(link.right?.type) }],
        entities: [{ filter: (entity) => notIgnored(entity.type) }],
      },
    });

    try {
      transferEngine.progress?.stream?.on('stage::start', ({ stage }) => {
        status = { ...status, phase: `transferring ${stage}` };
      });
      transferEngine.diagnostics?.onDiagnostic?.(({ kind, details }) => {
        if (kind === 'error') strapi.log.error(`[content-tools] transfer: ${details?.message}`);
      });
    } catch {
      /* progress wiring is best-effort */
    }

    return transferEngine.transfer();
  };

  const pull = async ({ targetId }) => {
    if (status.running) throw fail('ConflictError', 'A transfer is already running', 409);

    const target = (await getTargetsRaw()).find((t) => t.id === targetId);
    if (!target) throw fail('BadRequest', 'Unknown target', 400);
    if (!target.token) throw fail('BadRequest', 'This target has no transfer token', 400);
    try {
      buildRemoteUrl(target.url);
    } catch {
      throw fail('BadRequest', 'Invalid target URL', 400);
    }

    status = {
      running: true,
      targetId: target.id,
      targetName: target.name,
      phase: 'starting',
      error: null,
      startedAt: Date.now(),
      finishedAt: null,
    };

    // Fire-and-forget; the admin page polls getStatus().
    runTransfer(target)
      .then(() => {
        status = { ...status, running: false, phase: 'done', finishedAt: Date.now() };
        strapi.log.info('[content-tools] data transfer completed');
      })
      .catch((err) => {
        status = {
          ...status,
          running: false,
          phase: 'failed',
          error: err?.message || String(err),
          finishedAt: Date.now(),
        };
        strapi.log.error(`[content-tools] data transfer failed: ${err?.stack || err}`);
      });

    return status;
  };

  return { listTargets, saveTargets, getStatus, pull };
};
