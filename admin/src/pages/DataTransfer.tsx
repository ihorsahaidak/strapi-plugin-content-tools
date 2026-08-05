import * as React from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  IconButton,
  Field,
  Modal,
  Status,
  Loader,
  Checkbox,
} from '@strapi/design-system';
import { Plus, Trash, ArrowClockwise, Stop, Play } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

type Target = {
  id: string;
  name: string;
  url: string;
  token: string; // '' means "unchanged / already saved"
  hasToken?: boolean;
};

type Bucket = { count: number; bytes: number };

type TransferStatus = {
  running: boolean;
  step?:
    | 'idle'
    | 'backup'
    | 'download'
    | 'transfer'
    | 'restore'
    | 'assets'
    | 'done'
    | 'failed'
    | 'stopped';
  phase?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  counts?: { entities: Bucket; links: Bucket; assets: Bucket; configuration: Bucket };
  estimate?: { entities: number; assets: number } | null;
  percent?: number | null;
  backup?: { id: string; entities: number; assets: number; bytes: number; createdAt: string } | null;
  error?: string | null;
  stopRequested?: boolean;
  startedAt?: number | null;
  finishedAt?: number | null;
};

type Backup = {
  id: string;
  createdAt: string;
  entities: number;
  assets: number;
  bytes: number;
  reason?: string;
  exists?: boolean;
};

const newId = () =>
  (typeof crypto !== 'undefined' && (crypto as any).randomUUID?.()) ||
  `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const fmtBytes = (n?: number) => {
  if (!n || n < 1) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};

const fmtInt = (n?: number) => (n ?? 0).toLocaleString();

const fmtElapsed = (ms: number) => {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
};

const stepLabel: Record<string, string> = {
  backup: 'Backing up',
  transfer: 'Pulling content',
  assets: 'Resizing media',
  restore: 'Rolling back',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
};

/** Simple determinate/indeterminate progress bar (no external CSS needed). */
const Bar = ({ percent }: { percent: number | null | undefined }) => {
  const indeterminate = percent == null;
  return (
    <Box
      style={{
        position: 'relative',
        width: '100%',
        height: 8,
        borderRadius: 4,
        background: 'rgba(0,0,0,0.08)',
        overflow: 'hidden',
      }}
    >
      <Box
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: indeterminate ? '35%' : `${Math.max(2, Math.min(100, percent!))}%`,
          borderRadius: 4,
          background: 'var(--primary600, #4945ff)',
          transition: 'width .4s ease',
          animation: indeterminate ? 'ct-indeterminate 1.2s ease-in-out infinite' : undefined,
        }}
      />
      <style>{`@keyframes ct-indeterminate {0%{left:-35%}100%{left:100%}}`}</style>
    </Box>
  );
};

const DataTransferPage = () => {
  const { get, put, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [targets, setTargets] = React.useState<Target[]>([]);
  const [status, setStatus] = React.useState<TransferStatus>({ running: false });
  const [backups, setBackups] = React.useState<Backup[]>([]);
  const [confirmTarget, setConfirmTarget] = React.useState<Target | null>(null);
  const [skipMedia, setSkipMedia] = React.useState(false);
  const [confirmStop, setConfirmStop] = React.useState(false);
  const [confirmRestore, setConfirmRestore] = React.useState<Backup | null>(null);
  const [testingId, setTestingId] = React.useState<string | null>(null);
  const [now, setNow] = React.useState(Date.now());

  const loadTargets = React.useCallback(async () => {
    const res = await get('/content-tools/data-transfer/targets');
    setTargets(((res.data as any) ?? []).map((t: any) => ({ ...t, token: '' })));
  }, [get]);

  const loadStatus = React.useCallback(async () => {
    try {
      const res = await get('/content-tools/data-transfer/status');
      setStatus((res.data as any) ?? { running: false });
    } catch {
      /* ignore */
    }
  }, [get]);

  const loadBackups = React.useCallback(async () => {
    try {
      const res = await get('/content-tools/data-transfer/backups');
      setBackups((res.data as any) ?? []);
    } catch {
      /* ignore */
    }
  }, [get]);

  React.useEffect(() => {
    Promise.all([loadTargets(), loadStatus(), loadBackups()]).finally(() => setLoading(false));
  }, [loadTargets, loadStatus, loadBackups]);

  const busy = status.running;

  // Poll while a transfer is running (fast), and tick the elapsed clock.
  React.useEffect(() => {
    if (!busy) return;
    const poll = setInterval(loadStatus, 1500);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [busy, loadStatus]);

  // When a run just finished, refresh the backups list once.
  const prevBusy = React.useRef(busy);
  React.useEffect(() => {
    if (prevBusy.current && !busy) loadBackups();
    prevBusy.current = busy;
  }, [busy, loadBackups]);

  const patch = (id: string, key: keyof Target, value: string) =>
    setTargets((prev) => prev.map((t) => (t.id === id ? { ...t, [key]: value } : t)));

  const addTarget = () =>
    setTargets((prev) => [...prev, { id: newId(), name: '', url: '', token: '', hasToken: false }]);

  const removeTarget = (id: string) => setTargets((prev) => prev.filter((t) => t.id !== id));

  const save = async () => {
    setSaving(true);
    try {
      const res = await put('/content-tools/data-transfer/targets', { targets });
      setTargets(((res.data as any) ?? []).map((t: any) => ({ ...t, token: '' })));
      toggleNotification({ type: 'success', message: 'Targets saved.' });
    } catch {
      toggleNotification({ type: 'danger', message: 'Could not save targets.' });
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (target: Target) => {
    setTestingId(target.id);
    try {
      const res = await post('/content-tools/data-transfer/probe', { targetId: target.id });
      const r = (res.data as any) || {};
      if (r.ok) {
        const match =
          r.versionMatch === false
            ? ` — ⚠ version mismatch (source ${r.remoteVersion} vs local ${r.localVersion})`
            : r.remoteVersion
              ? ` — Strapi ${r.remoteVersion} ✓`
              : '';
        toggleNotification({
          type: r.versionMatch === false ? 'warning' : 'success',
          message: `Reachable and token accepted${match}.`,
        });
      } else {
        toggleNotification({ type: 'danger', message: `Cannot reach target: ${r.error || 'unknown error'}` });
      }
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Test failed.',
      });
    } finally {
      setTestingId(null);
    }
  };

  const runPull = async (target: Target) => {
    setConfirmTarget(null);
    try {
      await put('/content-tools/data-transfer/targets', { targets });
      const res = await post('/content-tools/data-transfer/pull', {
        targetId: target.id,
        skipMedia,
      });
      setStatus((res.data as any) ?? { running: true, targetName: target.name });
      toggleNotification({
        type: 'info',
        message: `Backup + pull from "${target.name}" started${skipMedia ? ' (content only)' : ''}.`,
      });
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Could not start the transfer.',
      });
    }
  };

  const forceStop = async () => {
    setConfirmStop(false);
    try {
      const res = await post('/content-tools/data-transfer/stop', {});
      setStatus((res.data as any) ?? status);
      toggleNotification({ type: 'info', message: 'Stopping and rolling back to the pre-pull backup…' });
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Could not stop the transfer.',
      });
    }
  };

  const restore = async (backup: Backup) => {
    setConfirmRestore(null);
    try {
      const res = await post('/content-tools/data-transfer/restore-backup', { backupId: backup.id });
      setStatus((res.data as any) ?? status);
      toggleNotification({ type: 'info', message: 'Restoring backup…' });
      loadStatus();
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Could not restore the backup.',
      });
    }
  };

  if (loading) return <Page.Loading />;

  const c = status.counts;
  const totalEntities = c ? c.entities.count : 0;
  const totalAssets = c ? c.assets.count : 0;
  const totalBytes = c ? c.entities.bytes + c.links.bytes + c.assets.bytes : 0;
  const elapsed = status.startedAt ? fmtElapsed((status.finishedAt || now) - status.startedAt) : '0s';
  const showPanel = busy || !!status.phase || !!status.error;

  const statusVariant =
    status.step === 'failed'
      ? 'danger'
      : status.step === 'done'
        ? 'success'
        : status.step === 'stopped'
          ? 'warning'
          : 'secondary';

  return (
    <Layouts.Root>
      <Page.Main>
        <Layouts.Header
          title="Data Transfer"
          subtitle="Pull content & media from another environment. A full backup is taken first, with live progress and a force-stop that rolls back."
          primaryAction={
            <Button onClick={save} loading={saving} disabled={busy}>
              Save targets
            </Button>
          }
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={4}>
            {/* live progress / last-run status */}
            {showPanel ? (
              <Box
                padding={5}
                hasRadius
                background={status.error ? 'danger100' : 'neutral0'}
                borderColor={status.error ? 'danger200' : 'neutral150'}
                shadow="tableShadow"
              >
                <Flex direction="column" alignItems="stretch" gap={3}>
                  <Flex justifyContent="space-between" alignItems="center">
                    <Flex gap={3} alignItems="center">
                      {busy ? <Loader small>Working</Loader> : null}
                      <Flex direction="column" alignItems="flex-start">
                        <Flex gap={2} alignItems="center">
                          <Status variant={statusVariant as any} size="S">
                            <Typography fontWeight="bold">
                              {stepLabel[status.step || ''] || (busy ? 'Working' : 'Idle')}
                            </Typography>
                          </Status>
                          {status.targetName ? (
                            <Typography variant="pi" textColor="neutral600">
                              {status.targetName}
                            </Typography>
                          ) : null}
                        </Flex>
                        <Typography variant="pi" textColor={status.error ? 'danger600' : 'neutral600'}>
                          {status.error ?? status.phase ?? ''}
                        </Typography>
                      </Flex>
                    </Flex>
                    {busy ? (
                      <Button variant="danger" startIcon={<Stop />} onClick={() => setConfirmStop(true)}>
                        Force stop &amp; roll back
                      </Button>
                    ) : null}
                    {!busy && status.step === 'failed' && status.backup ? (
                      <Button
                        variant="danger-light"
                        startIcon={<ArrowClockwise />}
                        onClick={() => setConfirmRestore(status.backup as Backup)}
                      >
                        Apply pre-pull backup
                      </Button>
                    ) : null}
                  </Flex>

                  {busy || status.step === 'done' ? (
                    <Box>
                      <Flex justifyContent="space-between" paddingBottom={1}>
                        <Typography variant="pi" textColor="neutral600">
                          {status.percent != null ? `${status.percent}%` : 'estimating…'}
                        </Typography>
                        <Typography variant="pi" textColor="neutral600">
                          {elapsed} elapsed
                        </Typography>
                      </Flex>
                      <Bar percent={busy ? status.percent : 100} />
                    </Box>
                  ) : null}

                  {/* live counters — show "done / total" when an estimate exists */}
                  <Flex gap={6} wrap="wrap">
                    <Stat
                      label="Entities"
                      value={
                        status.estimate?.entities
                          ? `${fmtInt(totalEntities)} / ${fmtInt(status.estimate.entities)}`
                          : fmtInt(totalEntities)
                      }
                    />
                    <Stat
                      label="Media"
                      value={
                        status.estimate?.assets
                          ? `${fmtInt(totalAssets)} / ${fmtInt(status.estimate.assets)}`
                          : fmtInt(totalAssets)
                      }
                    />
                    <Stat label="Data" value={fmtBytes(totalBytes)} />
                    {status.backup ? (
                      <Stat
                        label={status.step === 'failed' ? 'Backup kept (undo available)' : 'Pre-pull backup'}
                        value={`${fmtInt(status.backup.entities)} entities · ${fmtInt(
                          status.backup.assets
                        )} assets · ${fmtBytes(status.backup.bytes)}`}
                      />
                    ) : null}
                  </Flex>
                </Flex>
              </Box>
            ) : null}

            {/* what the fields mean + safety note, combined */}
            <Box padding={4} hasRadius background="neutral0" borderColor="neutral150" shadow="tableShadow">
              <Typography variant="delta" tag="h2">
                How it works
              </Typography>
              <Box paddingTop={2}>
                <Typography tag="p" textColor="neutral700">
                  <b>Strapi URL</b> — the base address of the environment you want to copy data{' '}
                  <i>from</i> (e.g. <code>https://your-strapi.example.com</code>). Don&apos;t add{' '}
                  <code>/admin</code>; it&apos;s appended automatically. The source must run the same
                  Strapi version as this one — use <b>Test</b> to check.
                </Typography>
              </Box>
              <Box paddingTop={2}>
                <Typography tag="p" textColor="neutral700">
                  <b>Transfer token</b> — created in the <i>source</i> environment&apos;s admin under{' '}
                  <b>Settings → Transfer Tokens</b> (choose <b>Pull</b> or <b>Full access</b>). An API
                  token will <b>not</b> work. It&apos;s stored masked and only used for the pull.
                </Typography>
              </Box>
              <Box paddingTop={3} borderStyle="solid" borderWidth="1px 0 0 0" borderColor="neutral150">
                <Box paddingTop={3}>
                  <Typography tag="p" textColor="warning700">
                    Pulling replaces this environment&apos;s <b>content and media</b> with the
                    source&apos;s. Your <b>admin users, tokens and configuration are kept</b>. A{' '}
                    <b>full backup is taken automatically before the pull</b> and every image is
                    re-downloaded and resized locally so it renders correctly here and on the website.
                    Hit <b>Force stop</b> at any time to abort and restore that backup immediately; if
                    the pull fails on its own, the backup is kept and you&apos;ll be asked whether to
                    apply it — nothing is restored silently. A successful pull discards the backup.
                  </Typography>
                </Box>
              </Box>
            </Box>

            {/* targets */}
            {targets.map((t) => (
              <Box
                key={t.id}
                padding={5}
                background="neutral0"
                hasRadius
                shadow="tableShadow"
                borderColor="neutral150"
              >
                <Flex gap={4} alignItems="flex-end" wrap="wrap">
                  <Box width="14rem">
                    <Field.Root name={`name-${t.id}`}>
                      <Field.Label>Name</Field.Label>
                      <Field.Input
                        placeholder="Preprod"
                        value={t.name}
                        onChange={(e: any) => patch(t.id, 'name', e.target.value)}
                      />
                    </Field.Root>
                  </Box>
                  <Box style={{ flex: 1, minWidth: '20rem' }}>
                    <Field.Root name={`url-${t.id}`}>
                      <Field.Label>Strapi URL</Field.Label>
                      <Field.Input
                        placeholder="https://your-env.example.com"
                        value={t.url}
                        onChange={(e: any) => patch(t.id, 'url', e.target.value)}
                      />
                    </Field.Root>
                  </Box>
                  <Box width="18rem">
                    <Field.Root name={`token-${t.id}`}>
                      <Field.Label>Transfer token</Field.Label>
                      <Field.Input
                        type="password"
                        placeholder={t.hasToken ? '•••••••• (saved)' : 'paste transfer token'}
                        value={t.token}
                        onChange={(e: any) => patch(t.id, 'token', e.target.value)}
                      />
                    </Field.Root>
                  </Box>
                  <Flex gap={2}>
                    <Button
                      variant="tertiary"
                      startIcon={<Play />}
                      loading={testingId === t.id}
                      disabled={busy || !t.url || (!t.token && !t.hasToken)}
                      onClick={() => testConnection(t)}
                    >
                      Test
                    </Button>
                    <Button
                      variant="danger-light"
                      startIcon={<ArrowClockwise />}
                      disabled={busy || !t.url || (!t.token && !t.hasToken)}
                      onClick={() => setConfirmTarget(t)}
                    >
                      Pull
                    </Button>
                    <IconButton label="Remove" onClick={() => removeTarget(t.id)} disabled={busy}>
                      <Trash />
                    </IconButton>
                  </Flex>
                </Flex>
              </Box>
            ))}

            <Box>
              <Button variant="secondary" startIcon={<Plus />} onClick={addTarget} disabled={busy}>
                Add environment
              </Button>
            </Box>

            {/* backups / undo */}
            {backups.length ? (
              <Box padding={4} hasRadius background="neutral0" borderColor="neutral150" shadow="tableShadow">
                <Typography variant="delta" tag="h2">
                  Backups
                </Typography>
                <Typography variant="pi" textColor="neutral600" tag="p">
                  A successful pull discards its backup automatically — a backup only stays here when a
                  pull failed and hasn&apos;t been resolved yet. Apply it to undo. Only one is ever kept.
                </Typography>
                <Box paddingTop={3}>
                  <Flex direction="column" alignItems="stretch" gap={2}>
                    {backups.map((b) => (
                      <Flex
                        key={b.id}
                        justifyContent="space-between"
                        alignItems="center"
                        padding={3}
                        hasRadius
                        background="neutral100"
                      >
                        <Flex direction="column" alignItems="flex-start">
                          <Typography fontWeight="bold" variant="pi">
                            {new Date(b.createdAt).toLocaleString()}
                          </Typography>
                          <Typography variant="pi" textColor="neutral600">
                            {fmtInt(b.entities)} entities · {fmtInt(b.assets)} assets · {fmtBytes(b.bytes)}
                            {b.exists === false ? ' · ⚠ file missing' : ''}
                          </Typography>
                        </Flex>
                        <Button
                          variant="secondary"
                          startIcon={<ArrowClockwise />}
                          disabled={busy || b.exists === false}
                          onClick={() => setConfirmRestore(b)}
                        >
                          Restore
                        </Button>
                      </Flex>
                    ))}
                  </Flex>
                </Box>
              </Box>
            ) : null}
          </Flex>
        </Layouts.Content>

        {/* confirm destructive pull */}
        <Modal.Root open={!!confirmTarget} onOpenChange={() => setConfirmTarget(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Backup &amp; pull?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography textColor="neutral700">
                This first takes a <b>full backup</b> of the current content &amp; media, then pulls{' '}
                <b>content</b> from <b>{confirmTarget?.name || confirmTarget?.url}</b>, then downloads and{' '}
                <b>resizes every media file</b> locally (unless skipped) so it renders correctly here and
                on the website. Admin users, tokens and config are kept. <b>Force stop</b> aborts and
                restores the backup immediately; if the pull fails on its own, you&apos;ll be asked
                whether to apply the backup instead.
              </Typography>
              <Box paddingTop={4}>
                <Checkbox
                  checked={skipMedia}
                  onCheckedChange={(v: boolean | 'indeterminate') => setSkipMedia(v === true)}
                >
                  Skip media — pull content only (recommended if the source has broken images)
                </Checkbox>
              </Box>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setConfirmTarget(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                startIcon={<ArrowClockwise />}
                onClick={() => confirmTarget && runPull(confirmTarget)}
              >
                Backup &amp; pull
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>

        {/* confirm force stop */}
        <Modal.Root open={confirmStop} onOpenChange={() => setConfirmStop(false)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Force stop and roll back?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography textColor="neutral700">
                This aborts the running transfer and restores the <b>pre-pull backup</b>, returning this
                environment to exactly how it was before the pull started.
              </Typography>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setConfirmStop(false)}>
                Keep running
              </Button>
              <Button variant="danger" startIcon={<Stop />} onClick={forceStop}>
                Stop &amp; roll back
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>

        {/* confirm restore */}
        <Modal.Root open={!!confirmRestore} onOpenChange={() => setConfirmRestore(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Restore this backup?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography textColor="neutral700">
                This replaces the current content &amp; media with the snapshot from{' '}
                <b>{confirmRestore ? new Date(confirmRestore.createdAt).toLocaleString() : ''}</b>. Admin
                users, tokens and config are kept.
              </Typography>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setConfirmRestore(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                startIcon={<ArrowClockwise />}
                onClick={() => confirmRestore && restore(confirmRestore)}
              >
                Restore
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </Page.Main>
    </Layouts.Root>
  );
};

const Stat = ({ label, value }: { label: string; value: string }) => (
  <Flex direction="column" alignItems="flex-start">
    <Typography variant="sigma" textColor="neutral600">
      {label}
    </Typography>
    <Typography fontWeight="bold">{value}</Typography>
  </Flex>
);

export default DataTransferPage;
