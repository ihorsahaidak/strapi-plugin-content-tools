import pluginId from './pluginId';
import RelocatedFilterBar from './components/RelocatedFilterBar';
import ImportButton from './components/ImportButton';
import moveLocaleDocumentAction from './actions/moveLocaleDocumentAction';
import moveLocaleBulkAction from './actions/moveLocaleBulkAction';
import exportBulkAction from './actions/exportBulkAction';

export default {
  register(app: any) {
    // Settings → Content Tools → Filters
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

    // Import button in the list toolbar.
    cm.injectComponent('listView', 'actions', {
      name: `${pluginId}-import`,
      Component: ImportButton,
    });

    // Feature 2 — move a single entry to another language (edit view + row menu).
    cm.apis.addDocumentAction((actions: any[]) => [...actions, moveLocaleDocumentAction]);

    // Feature 3 — bulk actions: move to another language + export selected.
    cm.apis.addBulkAction((actions: any[]) => [
      ...actions,
      moveLocaleBulkAction,
      exportBulkAction,
    ]);
  },
};
