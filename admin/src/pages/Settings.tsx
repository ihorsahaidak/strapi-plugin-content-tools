import * as React from 'react';
import {
  Box,
  Flex,
  Typography,
  Button,
  Checkbox,
  Divider,
} from '@strapi/design-system';
import { Check } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { prettyLabel } from '../utils/scope';
import { clearFilterConfigCache } from '../utils/configClient';

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

const shortTarget = (uid?: string) => (uid ? uid.split('.').pop() : '');

const attrHint = (attr: AttrMeta) => {
  if (attr.type === 'relation') return `relation → ${shortTarget(attr.target)}`;
  if (attr.type === 'enumeration') return `enum (${(attr.enum ?? []).length} values)`;
  if (attr.type === 'datetime') return 'date range';
  return 'boolean';
};

const SettingsPage = () => {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [contentTypes, setContentTypes] = React.useState<ContentTypeMeta[]>([]);
  const [selection, setSelection] = React.useState<Record<string, string[]>>({});

  React.useEffect(() => {
    let cancelled = false;
    get('/content-tools/schema')
      .then((res) => {
        if (cancelled) return;
        setContentTypes((res.data as any)?.contentTypes ?? []);
        setSelection((res.data as any)?.config ?? {});
      })
      .catch(() => {
        toggleNotification({ type: 'danger', message: 'Could not load the filter configuration.' });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [get, toggleNotification]);

  const isChecked = (uid: string, field: string) => (selection[uid] ?? []).includes(field);

  const toggle = (uid: string, field: string) => {
    setSelection((prev) => {
      const current = prev[uid] ?? [];
      const next = current.includes(field)
        ? current.filter((f) => f !== field)
        : [...current, field];
      const updated = { ...prev };
      if (next.length) updated[uid] = next;
      else delete updated[uid];
      return updated;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await put('/content-tools/config', { config: selection });
      setSelection((res.data as any) ?? selection);
      clearFilterConfigCache();
      toggleNotification({ type: 'success', message: 'Filter configuration saved.' });
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
          subtitle="Choose which fields become sticky list filters in the Content Manager, per content type."
          primaryAction={
            <Button onClick={save} loading={saving} startIcon={<Check />}>
              Save
            </Button>
          }
        />
        <Layouts.Content>
          <Flex direction="column" alignItems="stretch" gap={4}>
            {contentTypes.map((ct) => (
              <Box
                key={ct.uid}
                padding={5}
                background="neutral0"
                hasRadius
                shadow="tableShadow"
                borderColor="neutral150"
              >
                <Flex justifyContent="space-between" alignItems="baseline">
                  <Typography variant="delta" tag="h2">
                    {ct.displayName}
                  </Typography>
                  <Typography variant="pi" textColor="neutral500">
                    {ct.uid}
                  </Typography>
                </Flex>
                <Box paddingTop={3} paddingBottom={3}>
                  <Divider />
                </Box>
                <Flex wrap="wrap" gap={5}>
                  {Object.entries(ct.attributes).map(([name, attr]) => (
                    <Checkbox
                      key={name}
                      checked={isChecked(ct.uid, name)}
                      onCheckedChange={() => toggle(ct.uid, name)}
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
            ))}
          </Flex>
        </Layouts.Content>
      </Page.Main>
    </Layouts.Root>
  );
};

export default SettingsPage;
