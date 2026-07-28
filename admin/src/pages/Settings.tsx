import * as React from 'react';
import { Box, Flex, Typography, Button, Checkbox, Divider, Modal } from '@strapi/design-system';
import { Check, Download, Upload, ArrowClockwise } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { prettyLabel } from '../utils/scope';
import { clearContentToolsConfigCache, ContentToolsEntry } from '../utils/configClient';

type AttrMeta = {
  type: 'relation' | 'enumeration' | 'boolean' | 'datetime';
  target?: string;
  enum?: string[];
};
type ContentTypeMeta = {
  uid: string;
  displayName: string;
  attributes: Record<string, AttrMeta>;
};

const EMPTY: ContentToolsEntry = { fields: [], export: false, import: false };

const shortTarget = (uid?: string) => (uid ? uid.split('.').pop() : '');

const attrHint = (attr: AttrMeta) => {
  if (attr.type === 'relation') return shortTarget(attr.target);
  if (attr.type === 'enumeration') return `${(attr.enum ?? []).length} values`;
  if (attr.type === 'datetime') return 'date range';
  return 'yes / no';
};

const GROUPS: Array<{ key: string; label: string; match: (a: AttrMeta) => boolean }> = [
  { key: 'relation', label: 'Relations', match: (a) => a.type === 'relation' },
  { key: 'choice', label: 'Choices', match: (a) => a.type === 'enumeration' || a.type === 'boolean' },
  { key: 'date', label: 'Dates', match: (a) => a.type === 'datetime' },
];

const SettingsPage = () => {
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
        setContentTypes((res.data as any)?.contentTypes ?? []);
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

  const updateEntry = (uid: string, patch: Partial<ContentToolsEntry>) => {
    setSelection((prev) => {
      const current = prev[uid] ?? EMPTY;
      const next: ContentToolsEntry = { ...current, ...patch };
      const updated = { ...prev };
      if (next.fields.length || next.export || next.import) updated[uid] = next;
      else delete updated[uid];
      return updated;
    });
  };

  const toggleField = (uid: string, field: string) => {
    const fields = entryFor(uid).fields;
    updateEntry(uid, {
      fields: fields.includes(field) ? fields.filter((f) => f !== field) : [...fields, field],
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
          title="Filters"
          subtitle="Per content type: choose the sticky list filters and enable export / import."
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
              const attrs = Object.entries(ct.attributes);
              return (
                <Box
                  key={ct.uid}
                  padding={5}
                  background="neutral0"
                  hasRadius
                  shadow="tableShadow"
                  borderColor="neutral150"
                >
                  {/* header + action toggles */}
                  <Flex justifyContent="space-between" alignItems="center" wrap="wrap" gap={3}>
                    <Flex direction="column" alignItems="flex-start">
                      <Typography variant="delta" tag="h2">
                        {ct.displayName}
                      </Typography>
                      <Typography variant="pi" textColor="neutral500">
                        {ct.uid}
                      </Typography>
                    </Flex>
                    <Flex gap={5} alignItems="center">
                      <Checkbox
                        checked={entry.export}
                        onCheckedChange={(v: boolean) => updateEntry(ct.uid, { export: !!v })}
                      >
                        <Flex gap={1} alignItems="center">
                          <Download width="1.2rem" height="1.2rem" />
                          <Typography>Export</Typography>
                        </Flex>
                      </Checkbox>
                      <Checkbox
                        checked={entry.import}
                        onCheckedChange={(v: boolean) => updateEntry(ct.uid, { import: !!v })}
                      >
                        <Flex gap={1} alignItems="center">
                          <Upload width="1.2rem" height="1.2rem" />
                          <Typography>Import</Typography>
                        </Flex>
                      </Checkbox>
                    </Flex>
                  </Flex>

                  <Box paddingTop={3} paddingBottom={4}>
                    <Divider />
                  </Box>

                  {/* filter fields, grouped by kind */}
                  <Flex direction="column" alignItems="stretch" gap={4}>
                    {GROUPS.map((group) => {
                      const groupAttrs = attrs.filter(([, a]) => group.match(a));
                      if (groupAttrs.length === 0) return null;
                      return (
                        <Box key={group.key}>
                          <Typography variant="sigma" textColor="neutral600">
                            {group.label}
                          </Typography>
                          <Flex wrap="wrap" gap={4} paddingTop={2}>
                            {groupAttrs.map(([name, attr]) => (
                              <Checkbox
                                key={name}
                                checked={entry.fields.includes(name)}
                                onCheckedChange={() => toggleField(ct.uid, name)}
                              >
                                <Flex direction="column" alignItems="flex-start">
                                  <Typography>{prettyLabel(name)}</Typography>
                                  <Typography variant="pi" textColor="neutral500">
                                    {attrHint(attr)}
                                  </Typography>
                                </Flex>
                              </Checkbox>
                            ))}
                          </Flex>
                        </Box>
                      );
                    })}
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
                Configuration saved. Reload the page for the changes to take
                effect across the Content Manager.
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

export default SettingsPage;
