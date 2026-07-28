import * as React from 'react';
import { Box, Flex, Typography, Button, Checkbox, Divider, Modal } from '@strapi/design-system';
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
          <Flex direction="column" alignItems="stretch" gap={4}>
            {contentTypes.map((ct) => {
              const entry = entryFor(ct.uid);
              return (
                <Box
                  key={ct.uid}
                  padding={5}
                  background="neutral0"
                  hasRadius
                  shadow="tableShadow"
                  borderColor="neutral150"
                >
                  {/* header */}
                  <Flex direction="column" alignItems="flex-start">
                    <Typography variant="delta" tag="h2">
                      {ct.displayName}
                    </Typography>
                    <Typography variant="pi" textColor="neutral500">
                      {ct.uid}
                    </Typography>
                  </Flex>

                  <Box paddingTop={3} paddingBottom={4}>
                    <Divider />
                  </Box>

                  {/* action toggles */}
                  <Flex wrap="wrap" gap={5}>
                    <Checkbox
                      checked={entry.export}
                      onCheckedChange={(v: boolean) => setFlag(ct.uid, 'export', !!v)}
                    >
                      <Flex gap={1} alignItems="center">
                        <Download width="1.2rem" height="1.2rem" />
                        <Typography>Export</Typography>
                      </Flex>
                    </Checkbox>
                    <Checkbox
                      checked={entry.import}
                      onCheckedChange={(v: boolean) => setFlag(ct.uid, 'import', !!v)}
                    >
                      <Flex gap={1} alignItems="center">
                        <Upload width="1.2rem" height="1.2rem" />
                        <Typography>Import</Typography>
                      </Flex>
                    </Checkbox>
                  </Flex>
                </Box>
              );
            })}
          </Flex>
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
