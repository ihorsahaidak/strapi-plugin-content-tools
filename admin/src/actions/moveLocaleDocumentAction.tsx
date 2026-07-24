import * as React from 'react';
import { Earth } from '@strapi/icons';

import MoveLocaleDialog from '../components/MoveLocaleDialog';

/**
 * "Move to another language" document action.
 * Shown in the edit-view action panel AND in each list-view row's "⋯" menu.
 * Only for localized collection-type entries that already exist.
 */
const moveLocaleDocumentAction = ({
  collectionType,
  model,
  documentId,
  document,
}: any) => {
  const sourceLocale: string | undefined = document?.locale;

  if (collectionType !== 'collection-types') return null;
  if (!documentId || !sourceLocale) return null;

  return {
    label: 'Move to another language',
    icon: <Earth />,
    position: ['panel', 'table-row'],
    variant: 'secondary',
    dialog: {
      type: 'modal',
      title: 'Move to another language',
      content: ({ onClose }: { onClose: () => void }) => (
        <MoveLocaleDialog
          onClose={onClose}
          uid={model}
          documentIds={[documentId]}
          sourceLocale={sourceLocale}
        />
      ),
    },
  };
};

export default moveLocaleDocumentAction;
