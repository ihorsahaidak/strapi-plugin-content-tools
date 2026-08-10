import * as React from 'react';
import { Earth } from '@strapi/icons';
import { useFetchClient } from '@strapi/strapi/admin';

import MergeLocaleDialog from '../components/MergeLocaleDialog';
import { useContentToolsFlag } from '../utils/configClient';

/**
 * "Move this language to another entry" document action.
 *
 * Companion to moveLocaleDocumentAction: that one changes WHICH LANGUAGE an
 * entry is, this one changes WHICH ENTRY a language belongs to. Shown in the
 * edit-view panel and each list row's "⋯" menu, for localized collection-type
 * entries that already exist, and only when enabled for this content type
 * (Settings → Content Tools → Always-on filters).
 */
const mergeLocaleDocumentAction = ({ collectionType, model, documentId, document }: any) => {
  const { get } = useFetchClient();
  const enabled = useContentToolsFlag(get, model, 'mergeLocale');
  const locale: string | undefined = document?.locale;

  if (!enabled) return null;
  if (collectionType !== 'collection-types') return null;
  if (!documentId || !locale) return null;

  return {
    label: 'Move this language to another entry',
    icon: <Earth />,
    position: ['panel', 'table-row'],
    variant: 'secondary',
    dialog: {
      type: 'modal',
      title: 'Move this language to another entry',
      content: ({ onClose }: { onClose: () => void }) => (
        <MergeLocaleDialog onClose={onClose} uid={model} documentId={documentId} locale={locale} />
      ),
    },
  };
};

export default mergeLocaleDocumentAction;
