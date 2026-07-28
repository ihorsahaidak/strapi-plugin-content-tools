import * as React from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  Checkbox,
  Divider,
  Field,
  Modal,
  Loader,
  IconButton,
} from '@strapi/design-system';
import { Check, Archive, ArrowClockwise, Trash } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { clearContentToolsConfigCache, ContentToolsEntry } from '../utils/configClient';

type ContentTypeMeta = { uid: string; displayName: string };
type DumpMeta = { id: string; createdAt: string; count: number; mediaCount: number; size: number };

const EMPTY: ContentToolsEntry & { dump?: boolean } = {
  fields: [],
  export: false,
  import: false,
  dump: false,
} as any;

const fmtSize = (b: number) => (b > 1_000_000 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
};

type Job = { open: boolean; title: string; running: boolean; message?: string; error?: string };

const CollectionDumpPage = () => {
  const { get, put, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [contentTypes, setContentTypes] = React.useState<ContentTypeMeta[]>([]);
  const [selection, setSelection] = React.useState<Record<string, any>>({});
  const [retention, setRetention] = React.useState(3);
  const [dumps, setDumps] = React.useState<Record<string, DumpMeta[]>>({});
  const [job, setJob] = React.useState<Job>({ open: false, title: '', running: false });
  const [confirmRestore, setConfirmRestore] = React.useState<{ uid: string; dumpId: string; label: string } | null>(null);

  const loadOverview = React.useCallback(async () => {
    const res = await get('/content-tools/dumps');
    setRetention((res.data as any)?.retention ?? 3);
    setDumps((res.data as any)?.dumps ?? {});
  }, [get]);

  React.useEffect(() => {
    Promise.all([get('/content-tools/schema'), get('/content-tools/dumps')])
      .then(([s, d]) => {
        setContentTypes(((s.data as any)?.contentTypes ?? []).map((c: any) => ({ uid: c.uid, displayName: c.displayName })));
        setSelection((s.data as any)?.config ?? {});
        setRetention((d.data as any)?.retention ?? 3);
        setDumps((d.data as any)?.dumps ?? {});
      })
      .catch(() => toggleNotification({ type: 'danger', message: 'Could not load the configuration.' }))
      .finally(() => setLoading(false));
  }, [get, toggleNotification]);

  const entryFor = (uid: string) => selection[uid] ?? EMPTY;

  const toggleDump = (uid: string, value: boolean) => {
    setSelection((prev) => {
      const current = prev[uid] ?? EMPTY;
      const next = { ...current, dump: value };
      const updated = { ...prev };
      if (next.fields?.length || next.export || next.import || next.dump) updated[uid] = next;
      else delete updated[uid];
      return updated;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      await put('/content-tools/config', { config: selection });
      await put('/content-tools/dumps/retention', { retention });
      clearContentToolsConfigCache();

      // Immediately create today's dump for any newly-enabled collection
      // that doesn't have one yet.
      setJob({ open: true, title: 'Saving & creating missing dumps…', running: true });
      const res = await post('/content-tools/dumps/ensure');
      const created = (res.data as any)?.created ?? 0;
      await loadOverview();
      setJob({
        open: true,
        title: 'Saved',
        running: false,
        message: created
          ? `Created ${created} dump(s) for newly-enabled collections.`
          : 'Configuration saved. No new dumps were needed.',
      });
    } catch {
      setJob({ open: false, title: '', running: false });
      toggleNotification({ type: 'danger', message: 'Could not save.' });
    } finally {
      setSaving(false);
    }
  };

  const createDump = async (ct: ContentTypeMeta) => {
    setJob({ open: true, title: `Creating dump — ${ct.displayName}`, running: true });
    try {
      const res = await post('/content-tools/dumps/create', { uid: ct.uid });
      const { count = 0, mediaCount = 0 } = (res.data as any) ?? {};
      await loadOverview();
      setJob({ open: true, title: `Dump created — ${ct.displayName}`, running: false, message: `${count} entr${count === 1 ? 'y' : 'ies'} · ${mediaCount} media file(s).` });
    } catch (err: any) {
      setJob({ open: true, title: `Dump failed — ${ct.displayName}`, running: false, error: err?.response?.data?.error?.message ?? 'Could not create the dump.' });
    }
  };

  const runRestore = async () => {
    if (!confirmRestore) return;
    const { uid, dumpId, label } = confirmRestore;
    setConfirmRestore(null);
    setJob({ open: true, title: `Restoring — ${label}`, running: true });
    try {
      const res = await post('/content-tools/dumps/restore', { uid, dumpId });
      const { deleted = 0, created = 0 } = (res.data as any) ?? {};
      setJob({ open: true, title: `Restore complete — ${label}`, running: false, message: `Removed ${deleted}, restored ${created} entr${created === 1 ? 'y' : 'ies'}.` });
    } catch (err: any) {
      setJob({ open: true, title: `Restore failed — ${label}`, running: false, error: err?.response?.data?.error?.message ?? 'Could not restore.' });
    }
  };

  const deleteDump = async (uid: string, dumpId: string) => {
    try {
      await post('/content-tools/dumps/delete', { uid, dumpId });
      await loadOverview();
    } catch {
      toggleNotification({ type: 'danger', message: 'Could not delete the dump.' });
    }
  };

  if (loading) return <Page.Loading />;

  return (
    <Layouts.Root>
      <Page.Main>
        <Layouts.Header
          title="Collection Dump"
          subtitle="Snapshot a whole collection (entries + media) and restore it later."
          primaryAction={
            <Button onClick={save} loading={saving} startIcon={<Check />}>
              Save
            </Button>
          }
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={4}>
            {/* retention control */}
            <Box padding={5} background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150">
              <Box width="18rem">
                <Field.Root name="retention" hint="How many dumps to keep per collection (max 7).">
                  <Field.Label>Keep last N dumps</Field.Label>
                  <Field.Input
                    type="number"
                    min={1}
                    max={7}
                    value={retention}
                    onChange={(e: any) =>
                      setRetention(Math.max(1, Math.min(7, Number(e.target.value) || 1)))
                    }
                  />
                  <Field.Hint />
                </Field.Root>
              </Box>
              <Box paddingTop={3}>
                <Typography variant="pi" textColor="neutral600">
                  Enabling a collection <b>creates its dump immediately</b> (on Save). Enabled
                  collections are then dumped <b>automatically once a day</b> (03:00 server time) —
                  the job <b>skips</b> any collection that already has a dump from today (manual or
                  auto). When a collection reaches the limit above, its <b>oldest dump is removed</b>{' '}
                  to make room for the new one.
                </Typography>
              </Box>
            </Box>

            {contentTypes.map((ct) => {
              const entry = entryFor(ct.uid);
              const list = dumps[ct.uid] ?? [];
              return (
                <Box key={ct.uid} padding={5} background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150">
                  <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                    <Flex direction="column" alignItems="flex-start">
                      <Typography variant="delta" tag="h2">
                        {ct.displayName}
                      </Typography>
                      <Typography variant="pi" textColor="neutral500">
                        {ct.uid}
                      </Typography>
                    </Flex>
                    <Checkbox
                      checked={!!entry.dump}
                      onCheckedChange={(v: boolean) => toggleDump(ct.uid, !!v)}
                    >
                      <Typography>Enable dumps</Typography>
                    </Checkbox>
                  </Flex>

                  {entry.dump ? (
                    <>
                      <Box paddingTop={3} paddingBottom={4}>
                        <Divider />
                      </Box>
                      <Flex direction="column" alignItems="stretch" gap={3}>
                        <Box>
                          <Button variant="secondary" startIcon={<Archive />} onClick={() => createDump(ct)}>
                            Create dump
                          </Button>
                        </Box>
                        {list.length === 0 ? (
                          <Typography variant="pi" textColor="neutral500">
                            No dumps yet.
                          </Typography>
                        ) : (
                          list.map((d) => (
                            <Flex
                              key={d.id}
                              justifyContent="space-between"
                              alignItems="center"
                              padding={3}
                              background="neutral100"
                              hasRadius
                            >
                              <Flex direction="column" alignItems="flex-start">
                                <Typography fontWeight="semiBold">{fmtDate(d.createdAt)}</Typography>
                                <Typography variant="pi" textColor="neutral600">
                                  {d.count} entr{d.count === 1 ? 'y' : 'ies'} · {d.mediaCount} media · {fmtSize(d.size)}
                                </Typography>
                              </Flex>
                              <Flex gap={2}>
                                <Button
                                  variant="danger-light"
                                  startIcon={<ArrowClockwise />}
                                  onClick={() =>
                                    setConfirmRestore({ uid: ct.uid, dumpId: d.id, label: `${ct.displayName} · ${fmtDate(d.createdAt)}` })
                                  }
                                >
                                  Restore
                                </Button>
                                <IconButton label="Delete dump" onClick={() => deleteDump(ct.uid, d.id)}>
                                  <Trash />
                                </IconButton>
                              </Flex>
                            </Flex>
                          ))
                        )}
                      </Flex>
                    </>
                  ) : null}
                </Box>
              );
            })}
          </Flex>
        </Layouts.Content>

        {/* confirm restore (destructive) */}
        <Modal.Root open={!!confirmRestore} onOpenChange={() => setConfirmRestore(null)}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Restore this dump?</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography textColor="neutral700">
                This will <b>delete all current entries</b> of this collection and recreate them from
                the dump (<b>{confirmRestore?.label}</b>). This cannot be undone.
              </Typography>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setConfirmRestore(null)}>
                Cancel
              </Button>
              <Button variant="danger" startIcon={<ArrowClockwise />} onClick={runRestore}>
                Restore
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>

        {/* create/restore progress + result */}
        <Modal.Root open={job.open} onOpenChange={(o: boolean) => !job.running && setJob((j) => ({ ...j, open: o }))}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>{job.title}</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              {job.running ? (
                <Flex gap={3} alignItems="center">
                  <Loader small>Working…</Loader>
                  <Typography textColor="neutral700">Please wait — this can take a moment.</Typography>
                </Flex>
              ) : job.error ? (
                <Typography textColor="danger600">{job.error}</Typography>
              ) : (
                <Typography textColor="neutral700">{job.message}</Typography>
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button
                variant="tertiary"
                disabled={job.running}
                onClick={() => setJob((j) => ({ ...j, open: false }))}
              >
                Close
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </Page.Main>
    </Layouts.Root>
  );
};

export default CollectionDumpPage;
