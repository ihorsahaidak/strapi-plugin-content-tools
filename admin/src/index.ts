import pluginId from './pluginId';
import RelocatedFilterBar from './components/RelocatedFilterBar';
import moveLocaleDocumentAction from './actions/moveLocaleDocumentAction';
import moveLocaleBulkAction from './actions/moveLocaleBulkAction';

export default {
  register(app: any) {
    app.createSettingSection(
      {
        id: pluginId,
        intlLabel: { id: `${pluginId}.settings.section`, defaultMessage: 'Content Tools' },
      },
      [
        {
          intlLabel: { id: `${pluginId}.settings.filters`, defaultMessage: 'Filters' },
          id: `${pluginId}-filters`,
          to: `${pluginId}/filters`,
          Component: () => import('./pages/Settings'),
        },
        {
          intlLabel: { id: `${pluginId}.settings.collection-dump`, defaultMessage: 'Collection Dump' },
          id: `${pluginId}-collection-dump`,
          to: `${pluginId}/collection-dump`,
          Component: () => import('./pages/CollectionDump'),
        },
        {
          intlLabel: { id: `${pluginId}.settings.data-transfer`, defaultMessage: 'Data Transfer' },
          id: `${pluginId}-data-transfer`,
          to: `${pluginId}/data-transfer`,
          Component: () => import('./pages/DataTransfer'),
        },
      ]
    );
  },

  bootstrap(app: any) {
    const cm = app.getPlugin('content-manager');
    if (!cm) return;

    // Sticky, configurable filters in the list toolbar.
    cm.injectComponent('listView', 'actions', {
      name: `${pluginId}-site-scope`,
      Component: RelocatedFilterBar,
    });

    // Move an entry to another language (edit panel + row menu + bulk).
    cm.apis.addDocumentAction((actions: any[]) => [...actions, moveLocaleDocumentAction]);
    cm.apis.addBulkAction((actions: any[]) => [...actions, moveLocaleBulkAction]);
  },
};
