import * as React from 'react';
import {
  Modal,
  Flex,
  Field,
  Button,
  Typography,
  SingleSelect,
  SingleSelectOption,
} from '@strapi/design-system';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

type Locale = { code: string; name: string };

type Props = {
  onClose: () => void;
  uid: string;
  documentIds: string[];
  sourceLocale: string;
};

/**
 * Modal body for the "Move to another language" document / bulk action.
 * Rendered inside the Strapi action dialog (receives `onClose`).
 */
const MoveLocaleDialog = ({ onClose, uid, documentIds, sourceLocale }: Props) => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [locales, setLocales] = React.useState<Locale[]>([]);
  const [target, setTarget] = React.useState<string>('');
  const [submitting, setSubmitting] = React.useState(false);

  const isBulk = documentIds.length > 1;

  React.useEffect(() => {
    let cancelled = false;
    get('/i18n/locales')
      .then((res) => {
        if (!cancelled) setLocales((res.data as any) ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [get]);

  const options = locales.filter((l) => l.code !== sourceLocale);

  const submit = async () => {
    if (!target) return;
    setSubmitting(true);
    try {
      if (!isBulk) {
        await post('/content-tools/move-locale', {
          uid,
          documentId: documentIds[0],
          sourceLocale,
          targetLocale: target,
        });
        toggleNotification({ type: 'success', message: `Entry moved to ${target}.` });
        onClose();
        // The entry no longer exists in the current locale — land on the
        // target-locale list so the user sees it in its new language.
        window.location.href =
          `/admin/content-manager/collection-types/${uid}` +
          `?plugins[i18n][locale]=${encodeURIComponent(target)}`;
        return;
      }

      const res = await post('/content-tools/move-locale-many', {
        uid,
        documentIds,
        sourceLocale,
        targetLocale: target,
      });
      const moved: string[] = (res.data as any)?.moved ?? [];
      const blocked: Array<{ documentId: string }> = (res.data as any)?.blocked ?? [];
      toggleNotification({
        type: blocked.length ? 'warning' : 'success',
        message:
          `Moved ${moved.length} entr${moved.length === 1 ? 'y' : 'ies'} to ${target}.` +
          (blocked.length
            ? ` ${blocked.length} skipped — already exist in ${target}.`
            : ''),
      });
      onClose();
      window.location.reload();
    } catch (err: any) {
      const message =
        err?.response?.data?.error?.message ?? 'Could not move the entry.';
      toggleNotification({ type: 'danger', message });
      setSubmitting(false);
    }
  };

  return (
    <>
      <Modal.Body>
        <Flex direction="column" alignItems="stretch" gap={4}>
          <Typography textColor="neutral700">
            {isBulk
              ? `Moving ${documentIds.length} entries from "${sourceLocale}" to another language.`
              : `Moving this entry from "${sourceLocale}" to another language.`}
            {' '}Entries that already exist in the target language will be skipped.
          </Typography>

          <Field.Root name="content-tools-target-locale" required>
            <Field.Label>Target language</Field.Label>
            <SingleSelect
              placeholder="Select a language"
              value={target}
              onChange={(value: string | number) => setTarget(String(value))}
            >
              {options.map((l) => (
                <SingleSelectOption key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </SingleSelectOption>
              ))}
            </SingleSelect>
          </Field.Root>
        </Flex>
      </Modal.Body>

      <Modal.Footer>
        <Button variant="tertiary" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button onClick={submit} loading={submitting} disabled={!target}>
          Move
        </Button>
      </Modal.Footer>
    </>
  );
};

export default MoveLocaleDialog;
