import * as React from 'react';
import { Box, Flex, Typography, Button, Checkbox, Modal } from '@strapi/design-system';
import { Check, Download, Upload, ArrowClockwise } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { clearContentToolsConfigCache, ContentToolsEntry } from '../utils/configClient';

type ContentTypeMeta = { uid: string; displayName: string };

const EMPTY: ContentToolsEntry = { fields: [], export: false, import: false };

/**
 * Settings → Content Tools → Import / Export.
 * Enables the per-content-type Export (bulk) and Import (toolbar) actions.
 * Shares the same stored config as the Filters page (the `fields` array is
 * preserved untouched here).
 */
const ImportExportPage = () => {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [showReload, setShowReload] = React.useState(false);
  const [contentTypes, setContentTypes] = React.useState<ContentTypeMeta[]>([]);
  const [selection, setSelection] = React.useState<Record<string, ContentToolsEntry>>({});

  React.useEffect(() => {
    let cancelled = false;
    get('/content-tools/schema')
      .then((res) => {
        if (cancelled) return;
        const cts = ((res.data as any)?.contentTypes ?? []).map((c: any) => ({
          uid: c.uid,
          displayName: c.displayName,
        }));
        setContentTypes(cts);
        setSelection((res.data as any)?.config ?? {});
      })
      .catch(() => {
        toggleNotification({ type: 'danger', message: 'Could not load the configuration.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [get, toggleNotification]);

  const entryFor = (uid: string): ContentToolsEntry => selection[uid] ?? EMPTY;

  const setFlag = (uid: string, key: 'export' | 'import', value: boolean) => {
    setSelection((prev) => {
      const current = prev[uid] ?? EMPTY;
      const next: ContentToolsEntry = { ...current, [key]: value };
      const updated = { ...prev };
      if (next.fields.length || next.export || next.import) updated[uid] = next;
      else delete updated[uid];
      return updated;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await put('/content-tools/config', { config: selection });
      setSelection((res.data as any) ?? selection);
      clearContentToolsConfigCache();
      toggleNotification({ type: 'success', message: 'Configuration saved.' });
      setShowReload(true);
    } catch {
      toggleNotification({ type: 'danger', message: 'Could not save the configuration.' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <Page.Loading />;

  return (
    <Layouts.Root>
      <Page.Main>
        <Layouts.Header
          title="Import / Export"
          subtitle="Enable the Export (bulk) and Import (toolbar) actions per content type."
          primaryAction={
            <Button onClick={save} loading={saving} startIcon={<Check />}>
              Save
            </Button>
          }
        />
        <Layouts.Content>
          <Box background="neutral0" hasRadius shadow="tableShadow" borderColor="neutral150">
            {/* column headers */}
            <Flex
              paddingLeft={5}
              paddingRight={5}
              paddingTop={3}
              paddingBottom={3}
              background="neutral100"
              justifyContent="space-between"
            >
              <Typography variant="sigma" textColor="neutral600">
                Content type
              </Typography>
              <Flex gap={6}>
                <Typography variant="sigma" textColor="neutral600">
                  Export
                </Typography>
                <Typography variant="sigma" textColor="neutral600">
                  Import
                </Typography>
              </Flex>
            </Flex>

            {contentTypes.map((ct) => {
              const entry = entryFor(ct.uid);
              return (
                <Flex
                  key={ct.uid}
                  paddingLeft={5}
                  paddingRight={5}
                  paddingTop={3}
                  paddingBottom={3}
                  justifyContent="space-between"
                  alignItems="center"
                  borderColor="neutral150"
                  style={{ borderTop: '1px solid' }}
                >
                  <Flex direction="column" alignItems="flex-start">
                    <Typography fontWeight="semiBold">{ct.displayName}</Typography>
                    <Typography variant="pi" textColor="neutral500">
                      {ct.uid}
                    </Typography>
                  </Flex>
                  <Flex gap={6} alignItems="center">
                    <Flex width="4rem" justifyContent="center">
                      <Checkbox
                        aria-label={`Enable export for ${ct.displayName}`}
                        checked={entry.export}
                        onCheckedChange={(v: boolean) => setFlag(ct.uid, 'export', !!v)}
                      />
                    </Flex>
                    <Flex width="4rem" justifyContent="center">
                      <Checkbox
                        aria-label={`Enable import for ${ct.displayName}`}
                        checked={entry.import}
                        onCheckedChange={(v: boolean) => setFlag(ct.uid, 'import', !!v)}
                      />
                    </Flex>
                  </Flex>
                </Flex>
              );
            })}
          </Box>

          <Box paddingTop={3}>
            <Typography variant="pi" textColor="neutral600">
              <Download width="0.9rem" height="0.9rem" /> Export adds a bulk action to the list view.{' '}
              <Upload width="0.9rem" height="0.9rem" /> Import adds a button to the list toolbar.
            </Typography>
          </Box>
        </Layouts.Content>

        <Modal.Root open={showReload} onOpenChange={setShowReload}>
          <Modal.Content>
            <Modal.Header>
              <Modal.Title>Reload to apply</Modal.Title>
            </Modal.Header>
            <Modal.Body>
              <Typography textColor="neutral700">
                Configuration saved. Reload the page for the changes to take effect across the
                Content Manager.
              </Typography>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" onClick={() => setShowReload(false)}>
                Later
              </Button>
              <Button startIcon={<ArrowClockwise />} onClick={() => window.location.reload()}>
                Reload now
              </Button>
            </Modal.Footer>
          </Modal.Content>
        </Modal.Root>
      </Page.Main>
    </Layouts.Root>
  );
};

export default ImportExportPage;
