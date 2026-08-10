import * as React from 'react';
import { Box, Flex, Typography, Button, Checkbox, Divider, Field } from '@strapi/design-system';
import { Check } from '@strapi/icons';
import { Layouts, Page, useFetchClient, useNotification } from '@strapi/strapi/admin';

import { clearContentToolsConfigCache, ContentToolsEntry } from '../utils/configClient';

type ContentTypeMeta = {
  uid: string;
  displayName: string;
  localized: boolean;
  templateFields: string[];
};

const EMPTY: ContentToolsEntry = { fields: [], moveLocale: false, mergeLocale: false, mergeLabelTemplate: '' };

// Variables always available for a merge-label template, regardless of the
// content type's own fields — `lang` is which locale the shown data actually
// came from: most fields are themselves localized, so a candidate lacking the
// language being moved is labelled using one of its OTHER locales, and this
// says which one.
const BUILTIN_TEMPLATE_VARS = ['lang', 'documentId'];

const LanguageToolsPage = () => {
  const { get, put } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [contentTypes, setContentTypes] = React.useState<ContentTypeMeta[]>([]);
  const [selection, setSelection] = React.useState<Record<string, ContentToolsEntry>>({});
  // One template <input> ref per content type, so a variable chip can insert
  // into the right field at the right cursor position.
  const inputRefs = React.useRef<Record<string, HTMLInputElement | null>>({});

  React.useEffect(() => {
    let cancelled = false;
    get('/content-tools/schema')
      .then((res) => {
        if (cancelled) return;
        setContentTypes(((res.data as any)?.contentTypes ?? []).filter((ct: ContentTypeMeta) => ct.localized));
        // Loaded whole (fields included) so saving here never drops another
        // page's config — see updateEntry.
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

  // Config is one flat per-content-type object shared with the Always-on
  // filters page (its own `fields` array lives alongside these flags). Always
  // merge onto the CURRENT entry rather than replacing it, so saving here
  // never wipes filter fields set on the other tab.
  const updateEntry = (uid: string, patch: Partial<ContentToolsEntry>) => {
    setSelection((prev) => {
      const current = prev[uid] ?? EMPTY;
      const next: ContentToolsEntry = { ...current, ...patch };
      const updated = { ...prev };
      if (next.fields.length || next.moveLocale || next.mergeLocale) updated[uid] = next;
      else delete updated[uid];
      return updated;
    });
  };

  const insertVariable = (uid: string, name: string) => {
    const token = `{${name}}`;
    const el = inputRefs.current[uid];
    const current = entryFor(uid).mergeLabelTemplate || '';

    if (!el) {
      updateEntry(uid, { mergeLabelTemplate: current + token });
      return;
    }

    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = current.slice(0, start) + token + current.slice(end);
    updateEntry(uid, { mergeLabelTemplate: next });

    // Restore focus + caret after the token once React re-renders the value.
    const caret = start + token.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await put('/content-tools/config', { config: selection });
      setSelection((res.data as any) ?? selection);
      clearContentToolsConfigCache();
      toggleNotification({ type: 'success', message: 'Configuration saved.' });
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
          title="Language tools"
          subtitle="Move an entry to another language, or move a single language onto a different entry — enabled per content type, localized types only."
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
              const availableVars = [...ct.templateFields, ...BUILTIN_TEMPLATE_VARS];
              return (
                <Box
                  key={ct.uid}
                  padding={5}
                  background="neutral0"
                  hasRadius
                  shadow="tableShadow"
                  borderColor="neutral150"
                >
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

                  <Flex direction="column" alignItems="stretch" gap={4}>
                    <Flex wrap="wrap" gap={4}>
                      <Checkbox
                        checked={entry.moveLocale}
                        onCheckedChange={(v: boolean | 'indeterminate') =>
                          updateEntry(ct.uid, { moveLocale: v === true })
                        }
                      >
                        <Flex direction="column" alignItems="flex-start">
                          <Typography>Move to another language</Typography>
                          <Typography variant="pi" textColor="neutral500">
                            Reassign an entry&apos;s locale (single, row menu &amp; bulk)
                          </Typography>
                        </Flex>
                      </Checkbox>
                      <Checkbox
                        checked={entry.mergeLocale}
                        onCheckedChange={(v: boolean | 'indeterminate') =>
                          updateEntry(ct.uid, { mergeLocale: v === true })
                        }
                      >
                        <Flex direction="column" alignItems="flex-start">
                          <Typography>Move this language to another entry</Typography>
                          <Typography variant="pi" textColor="neutral500">
                            Re-parent one language onto a different entry
                          </Typography>
                        </Flex>
                      </Checkbox>
                    </Flex>

                    {entry.mergeLocale ? (
                      <Box paddingTop={1} width="100%" style={{ maxWidth: '40rem' }}>
                        <Field.Root
                          name={`merge-template-${ct.uid}`}
                          hint="Shown for each entry offered as a merge target. Click a variable below to insert it, or type { } yourself."
                        >
                          <Field.Label>Entry label template</Field.Label>
                          <Field.Input
                            ref={(el: HTMLInputElement | null) => {
                              inputRefs.current[ct.uid] = el;
                            }}
                            placeholder="e.g. {title} — {slug} — {lang}"
                            value={entry.mergeLabelTemplate}
                            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                              updateEntry(ct.uid, { mergeLabelTemplate: e.target.value })
                            }
                          />
                          <Field.Hint />
                        </Field.Root>
                        <Box paddingTop={2}>
                          <Typography variant="pi" textColor="neutral500">
                            Available variables — click to insert:
                          </Typography>
                          <Flex wrap="wrap" gap={1} paddingTop={1}>
                            {availableVars.map((name) => (
                              <Button
                                key={name}
                                type="button"
                                variant="tertiary"
                                size="S"
                                onClick={() => insertVariable(ct.uid, name)}
                                style={{ fontFamily: 'monospace' }}
                              >
                                {`{${name}}`}
                              </Button>
                            ))}
                          </Flex>
                          {!entry.mergeLabelTemplate ? (
                            <Box paddingTop={2}>
                              <Typography variant="pi" textColor="neutral500">
                                Empty: falls back to title / name / slug (whichever exists).
                              </Typography>
                            </Box>
                          ) : null}
                        </Box>
                      </Box>
                    ) : null}
                  </Flex>
                </Box>
              );
            })}
          </Flex>
        </Layouts.Content>
      </Page.Main>
    </Layouts.Root>
  );
};

export default LanguageToolsPage;
