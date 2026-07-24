import * as React from 'react';
import { Download } from '@strapi/icons';
import { useFetchClient, useNotification } from '@strapi/strapi/admin';

/**
 * List-view bulk action: "Export selected".
 * Downloads a ZIP (entities + media + folder structure) of the selected
 * entries. The archive is returned base64-encoded so it flows through the
 * authenticated fetch client, then decoded to a Blob for download.
 */
const exportBulkAction = ({ collectionType, model, documents }: any) => {
  const { post } = useFetchClient();
  const { toggleNotification } = useNotification();

  if (collectionType !== 'collection-types') return null;
  if (!Array.isArray(documents) || documents.length === 0) return null;

  const documentIds = documents.map((d: any) => d?.documentId).filter(Boolean);
  if (documentIds.length === 0) return null;
  const locale = documents[0]?.locale;

  const download = async () => {
    try {
      const res = await post('/content-tools/export', { uid: model, documentIds, locale });
      const { filename, contentBase64, count, mediaCount } = res.data ?? {};

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
