import * as React from 'react';
import {
  Modal,
  Flex,
  Field,
  Button,
  Typography,
  Box,
  Combobox,
  ComboboxOption,
  Loader,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

type Candidate = { documentId: string; label: string; locales: string[] };

type Props = {
  onClose: () => void;
  uid: string;
  documentId: string;
  locale: string;
};

/**
 * Modal body for "Move this language to another entry".
 *
 * Re-parents one locale: this entry's `locale` version is detached from the
 * current document and attached to the chosen one. The language doesn't change
 * — the entry it belongs to does. This is the fix for filling a language in on
 * the wrong entry: instead of retyping it into the right entry, move it.
 *
 * Only entries that do NOT already have this language are offered, because
 * Strapi requires (documentId, locale, publishedAt) to be unique.
 */
const MergeLocaleDialog = ({ onClose, uid, documentId, locale }: Props) => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [candidates, setCandidates] = React.useState<Candidate[] | null>(null);
  const [target, setTarget] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ uid, documentId, locale });
    if (search) params.set('q', search);
    get(`/content-tools/merge-candidates?${params.toString()}`)
      .then((res) => {
        if (!cancelled) setCandidates(((res.data as any) ?? []) as Candidate[]);
      })
      .catch(() => {
        if (!cancelled) setCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [get, uid, documentId, locale, search]);

  const chosen = candidates?.find((c) => c.documentId === target);

  const submit = async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      await post('/content-tools/merge-locale', {
        uid,
        sourceDocumentId: documentId,
        targetDocumentId: target,
        locale,
      });
      toggleNotification({
        type: 'success',
        message: `The ${locale} version was moved to the selected entry.`,
      });
      onClose();
      // This document may no longer exist in this locale (or at all), so the
      // current edit view would 404 — send the user to the merged entry.
      window.location.href =
        `/admin/content-manager/collection-types/${uid}/${target}` +
        `?plugins[i18n][locale]=${encodeURIComponent(locale)}`;
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Could not move this language.',
      });
      setSubmitting(false);
    }
  };

  return (
    <>
      <Modal.Body>
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Typography textColor="neutral700">
            Moves this entry&apos;s <b>{locale}</b> version — draft and published — onto another
            entry, keeping its content, relations and media. Use it when a language was filled in on
            the wrong entry.
          </Typography>

          <Field.Root name="content-tools-merge-target" required>
            <Field.Label>Move the {locale} version onto</Field.Label>
            {candidates === null ? (
              <Box paddingTop={2}>
                <Loader small>Loading entries…</Loader>
              </Box>
            ) : (
              <Combobox
                placeholder="Search for an entry…"
                value={target}
                onChange={(v?: string) => setTarget(v ?? '')}
                onInputChange={(e: any) => setSearch(e?.target?.value ?? '')}
                onClear={() => setTarget('')}
              >
                {candidates.map((c) => (
                  <ComboboxOption key={c.documentId} value={c.documentId}>
                    {c.label}
                    {c.locales.length ? `  —  has ${c.locales.join(', ')}` : ''}
                  </ComboboxOption>
                ))}
              </Combobox>
            )}
            <Box paddingTop={1}>
              <Typography variant="pi" textColor="neutral600">
                Only entries without a {locale} version are listed — an entry can hold just one per
                language.
              </Typography>
            </Box>
          </Field.Root>

          {chosen ? (
            <Box padding={3} hasRadius background="neutral100">
              <Typography variant="pi" textColor="neutral700">
                <b>{chosen.label}</b> will gain the <b>{locale}</b> version, ending up with{' '}
                {[...chosen.locales, locale].sort().join(', ')}. This entry loses its {locale}
                version, and disappears entirely if that was its only language.
              </Typography>
            </Box>
          ) : null}
        </Flex>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="tertiary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={submit} loading={submitting} disabled={!target}>
          Move {locale} version
        </Button>
      </Modal.Footer>
    </>
  );
};

export default MergeLocaleDialog;
