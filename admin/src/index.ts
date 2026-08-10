import pluginId from './pluginId';
import RelocatedFilterBar from './components/RelocatedFilterBar';
import moveLocaleDocumentAction from './actions/moveLocaleDocumentAction';
import moveLocaleBulkAction from './actions/moveLocaleBulkAction';
import mergeLocaleDocumentAction from './actions/mergeLocaleDocumentAction';

export default {
  register(app: any) {
    // Settings → Content Tools
    app.createSettingSection(
      {
        id: pluginId,
        intlLabel: { id: `${pluginId}.settings.section`, defaultMessage: 'Content Tools' },
      },
      [
        {
          intlLabel: { id: `${pluginId}.settings.filters`, defaultMessage: 'Always-on filters' },
          id: `${pluginId}-filters`,
          to: `${pluginId}/filters`,
          Component: () => import('./pages/Settings'),
        },
        {
          intlLabel: { id: `${pluginId}.settings.language-tools`, defaultMessage: 'Language tools' },
          id: `${pluginId}-language-tools`,
          to: `${pluginId}/language-tools`,
          Component: () => import('./pages/LanguageTools'),
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

    // Feature 1 — configurable sticky filters in the list toolbar.
    cm.injectComponent('listView', 'actions', {
      name: `${pluginId}-site-scope`,
      Component: RelocatedFilterBar,
    });

    // Feature 2 — move a single entry to another language (edit view + row menu),
    // and move one language onto a different entry.
    cm.apis.addDocumentAction((actions: any[]) => [
      ...actions,
      moveLocaleDocumentAction,
      mergeLocaleDocumentAction,
    ]);

    // Feature 3 — bulk action: move selected entries to another language.
    cm.apis.addBulkAction((actions: any[]) => [...actions, moveLocaleBulkAction]);
  },
};
