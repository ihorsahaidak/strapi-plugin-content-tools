import * as React from 'react';
import { Earth } from '@strapi/icons';

import MergeLocaleDialog from '../components/MergeLocaleDialog';

/**
 * "Move this language to another entry" document action.
 *
 * Companion to moveLocaleDocumentAction: that one changes WHICH LANGUAGE an
 * entry is, this one changes WHICH ENTRY a language belongs to. Shown in the
 * edit-view panel and each list row's "⋯" menu, for localized collection-type
 * entries that already exist.
 */
const mergeLocaleDocumentAction = ({ collectionType, model, documentId, document }: any) => {
  const locale: string | undefined = document?.locale;

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
