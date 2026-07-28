import * as React from 'react';
import { Download } from '@strapi/icons';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

import { fetchContentToolsConfig } from '../utils/configClient';

/**
 * List-view bulk action: "Export selected".
 * Only shown when export is enabled for this content type in
 * Settings → Content Tools → Filters. Downloads a ZIP (entities + media +
 * folder structure); the archive is returned base64-encoded so it flows
 * through the authenticated fetch client, then decoded to a Blob.
 */
const exportBulkAction = ({ collectionType, model, documents }: any) => {
  const { post, get } = useFetchClient();
  const { toggleNotification } = useNotification();

  const [enabled, setEnabled] = React.useState(false);
  React.useEffect(() => {
    let cancelled = false;
    fetchContentToolsConfig(get).then((cfg) => {
      if (!cancelled) setEnabled(!!cfg[model]?.export);
    });
    return () => {
      cancelled = true;
    };
  }, [get, model]);

  if (collectionType !== 'collection-types' || !enabled) return null;
  if (!Array.isArray(documents) || documents.length === 0) return null;

  const documentIds = documents.map((d: any) => d?.documentId).filter(Boolean);
  if (documentIds.length === 0) return null;
  const locale = documents[0]?.locale;

  const download = async () => {
    try {
      const res = await post('/content-tools/export', { uid: model, documentIds, locale });
      const { filename, contentBase64, count, mediaCount } = (res.data as any) ?? {};

      const binary = atob(contentBase64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));

      const link = document.createElement('a');
      link.href = url;
      link.download = filename || 'export.zip';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);

      toggleNotification({
        type: 'success',
        message: `Exported ${count} entr${count === 1 ? 'y' : 'ies'} and ${mediaCount} media file(s).`,
      });
    } catch (err: any) {
      toggleNotification({
        type: 'danger',
        message: err?.response?.data?.error?.message ?? 'Export failed.',
      });
    }
  };

  return {
    label: 'Export selected',
    icon: <Download />,
    variant: 'secondary',
    onClick: download,
  };
};

export default exportBulkAction;
