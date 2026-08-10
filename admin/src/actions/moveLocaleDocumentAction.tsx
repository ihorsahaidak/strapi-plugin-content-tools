import * as React from 'react';
import { Earth } from '@strapi/icons';
import { useFetchClient } from '@strapi/strapi/admin';

import MoveLocaleDialog from '../components/MoveLocaleDialog';
import { useContentToolsFlag } from '../utils/configClient';

/**
 * "Move to another language" document action.
 * Shown in the edit-view action panel AND in each list-view row's "⋯" menu.
 * Only for localized collection-type entries that already exist, and only
 * when enabled for this content type (Settings → Content Tools → Always-on
 * filters).
 */
const moveLocaleDocumentAction = ({
  collectionType,
  model,
  documentId,
  document,
}: any) => {
  const { get } = useFetchClient();
  const enabled = useContentToolsFlag(get, model, 'moveLocale');
  const sourceLocale: string | undefined = document?.locale;

  if (!enabled) return null;
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
