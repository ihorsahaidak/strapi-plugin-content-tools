import * as React from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  IconButton,
  Field,
  Divider,
  Modal,
  Status,
  Loader,
} from '@strapi/design-system';
import { Plus, Trash, ArrowClockwise } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

type Target = {
  id: string;
  name: string;
  url: string;
  token: string; // '' means "unchanged / already saved"
  hasToken?: boolean;
};

type TransferStatus = {
  running: boolean;
  targetId?: string | null;
  targetName?: string | null;
  phase?: string | null;
  error?: string | null;
  startedAt?: number | null;
  finishedAt?: number | null;
};

const newId = () =>
  (typeof crypto !== 'undefined' && (crypto as any).randomUUID?.()) ||
  `t_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const DataTransferPage = () => {
  const { get, put, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [targets, setTargets] = React.useState<Target[]>([]);
  const [status, setStatus] = React.useState<TransferStatus>({ running: false });
  const [confirmTarget, setConfirmTarget] = React.useState<Target | null>(null);

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

  React.useEffect(() => {
    Promise.all([loadTargets(), loadStatus()]).finally(() => setLoading(false));
  }, [loadTargets, loadStatus]);

  // Poll while a transfer is running.
  React.useEffect(() => {
    if (!status.running) return;
    const id = setInterval(loadStatus, 2000);
    return () => clearInterval(id);
  }, [status.running, loadStatus]);

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

  const runPull = async (target: Target) => {
    setConfirmTarget(null);
    try {
      const res = await post('/content-tools/data-transfer/pull', { targetId: target.id });
      setStatus((res.data as any) ?? { running: true, targetName: target.name });
      toggleNotification({ type: 'info', message: `Pull from "${target.name}" started.` });
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Could not start the transfer.',
      });
    }
  };

  if (loading) return <Page.Loading />;

  const busy = status.running;

  return (
    <Layouts.Root>
      <Page.Main>
        <Layouts.Header
          title="Data Transfer"
          subtitle="Pull all data (content, media, config) from another environment into this one."
          primaryAction={
            <Button onClick={save} loading={saving} disabled={busy}>
              Save targets
            </Button>
          }
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={4}>
            {/* running/last-run status */}
            {status.phase || status.error ? (
              <Box
                padding={4}
                hasRadius
                background={status.error ? 'danger100' : 'neutral0'}
                borderColor={status.error ? 'danger200' : 'neutral150'}
                shadow="tableShadow"
              >
                <Flex gap={3} alignItems="center">
                  {busy ? <Loader small>Running</Loader> : null}
                  <Flex direction="column" alignItems="flex-start">
                    <Typography fontWeight="bold">
                      {busy
                        ? `Pulling from "${status.targetName ?? ''}"…`
                        : status.error
                          ? 'Last transfer failed'
                          : 'Last transfer finished'}
                    </Typography>
                    <Typography variant="pi" textColor={status.error ? 'danger600' : 'neutral600'}>
                      {status.error ?? status.phase ?? ''}
                    </Typography>
                  </Flex>
                </Flex>
              </Box>
            ) : null}

            {/* danger note */}
            <Box padding={4} hasRadius background="danger100" borderColor="danger200">
              <Typography textColor="danger700">
                Pulling replaces <b>all data in this environment</b> — content, media, admin users,
                tokens and config — with the source environment&apos;s. This cannot be undone.
              </Typography>
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
                        placeholder="Dev"
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
                      variant="danger-light"
                      startIcon={<ArrowClockwise />}
                      disabled={busy || !t.url || (!t.token && !t.hasToken)}
                      onClick={() => setConfirmTarget(t)}
                    >
                      Pull
                    </Button>
                    <IconButton
                      label="Remove"
                      onClick={() => removeTarget(t.id)}
                      disabled={busy}
                    >
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
          </Flex>
        </Layouts.Content>

        {/* confirm destructive pull */}
        <Modal.Root open={!!confirmTarget} onOpenChange={() => setConfirmTarget(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Replace all data?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography textColor="neutral700">
                This will <b>delete everything in this environment</b> and replace it with the data
                from <b>{confirmTarget?.name || confirmTarget?.url}</b>. Make sure you have a backup.
                This cannot be undone.
              </Typography>
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
                Pull &amp; replace
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </Page.Main>
    </Layouts.Root>
  );
};

export default DataTransferPage;
