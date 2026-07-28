import * as React from 'react';
import { Modal, Button, Flex, Typography } from '@strapi/design-system';
import { Upload } from '@strapi/icons';
import {
  useFetchClient,
  useNotification,
  unstable_useContentManagerContext as useContentManagerContext,
} from '@strapi/strapi/admin';

import { fetchContentToolsConfig } from '../utils/configClient';

/**
 * "Import" button injected into the list-view toolbar. Only shown when import
 * is enabled for this content type in Settings → Content Tools → Filters.
 * Uploads a ZIP produced by the Export action (from any environment); the
 * server recreates media + folder structure and creates the entries.
 */
const ImportButton = () => {
  const ctx = useContentManagerContext() as any;
  const { post, get } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [open, setOpen] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [enabled, setEnabled] = React.useState(false);

  const model: string | undefined = ctx?.model;
  React.useEffect(() => {
    let cancelled = false;
    fetchContentToolsConfig(get).then((cfg) => {
      if (!cancelled) setEnabled(!!(model && cfg[model]?.import));
    });
    return () => {
      cancelled = true;
    };
  }, [get, model]);

  if (ctx?.collectionType !== 'collection-types' || !enabled) return null;

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await post('/content-tools/import', form);
      const { created = 0, skipped = [], notPublished = [], missingRelations = [] } =
        (res.data as any) ?? {};

      const warn = skipped.length > 0 || missingRelations.length > 0 || notPublished.length > 0;
      toggleNotification({
        type: warn ? 'warning' : 'success',
        message:
          `Imported ${created} entr${created === 1 ? 'y' : 'ies'}.` +
          (skipped.length ? ` ${skipped.length} skipped (already exist).` : '') +
          (notPublished.length ? ` ${notPublished.length} could not be published.` : '') +
          (missingRelations.length ? ` ${missingRelations.length} relation(s) unmatched.` : ''),
      });
      setOpen(false);
      setFile(null);
      window.location.reload();
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Import failed.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="secondary" startIcon={<Upload />} onClick={() => setOpen(true)}>
        Import
      </Button>

      <Modal.Root open={open} onOpenChange={setOpen}>
        <Modal.Content>
          <Modal.Header>
            <Modal.Title>Import entries</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <Flex direction="column" alignItems="stretch" gap={3}>
              <Typography textColor="neutral700">
                Select a <code>.zip</code> exported from another environment. Media and its folder
                structure are recreated; entries that already exist are skipped.
              </Typography>
              <input
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Flex>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="tertiary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy} disabled={!file}>
              Import
            </Button>
          </Modal.Footer>
        </Modal.Content>
      </Modal.Root>
    </>
  );
};

export default ImportButton;
