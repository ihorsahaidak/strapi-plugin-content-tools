import * as React from 'react';
import { Earth } from '@strapi/icons';
import { useFetchClient } from '@strapi/strapi/admin';

import MoveLocaleDialog from '../components/MoveLocaleDialog';
import { useContentToolsFlag } from '../utils/configClient';

/**
 * List-view bulk action: "Move to another language".
 * Moves every selected entry from the current list language to the chosen
 * one; entries that already exist in the target language are skipped and
 * reported back. Only offered when enabled for this content type (Settings →
 * Content Tools → Always-on filters).
 */
const moveLocaleBulkAction = ({ collectionType, model, documents }: any) => {
  const { get } = useFetchClient();
  const enabled = useContentToolsFlag(get, model, 'moveLocale');

  if (!enabled) return null;
  if (collectionType !== 'collection-types') return null;
  if (!Array.isArray(documents) || documents.length === 0) return null;

  const sourceLocale: string | undefined = documents[0]?.locale;
  if (!sourceLocale) return null;

  const documentIds = documents
    .map((d: any) => d?.documentId)
    .filter(Boolean);
  if (documentIds.length === 0) return null;

  return {
    label: 'Move to another language',
    icon: <Earth />,
    variant: 'secondary',
    dialog: {
      type: 'modal',
      title: 'Move to another language',
      content: ({ onClose }: { onClose: () => void }) => (
        <MoveLocaleDialog
          onClose={onClose}
          uid={model}
          documentIds={documentIds}
          sourceLocale={sourceLocale}
        />
      ),
    },
  };
};

export default moveLocaleBulkAction;
