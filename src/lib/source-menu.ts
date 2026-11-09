import { Keymap, type Menu, type TFile } from 'obsidian';
import type { Actions } from './Actions';
import { goToSourceTitle, type SourceRoute } from './item-source';

/** The icon of Go to source's entry: where it takes the user. */
const SOURCE_ICONS: Record<SourceRoute['kind'], string> = {
  file: 'lucide-file-symlink',
  'web-viewer': 'lucide-globe-2',
  browser: 'lucide-external-link',
};

/**
 * Add Go to context and Go to source to `menu` for the item at `file`, each
 * only when it has something to open: a context for a snippet or card with
 * a parent (see `Actions.hasContext`), a source for any item whose article
 * has one (see `Actions.sourceRoute`), named for whether it leaves the app.
 * A modified or middle click opens in a new tab, split or window, as
 * `Keymap.isModEvent` answers.
 */
export function addSourceMenuItems(
  plugin: {
    actions: Pick<
      Actions,
      'hasContext' | 'goToContext' | 'sourceRoute' | 'goToSource'
    >;
  },
  menu: Menu,
  file: TFile,
  section = 'incremental-reading'
): void {
  const { actions } = plugin;
  if (actions.hasContext(file)) {
    menu.addItem((item) =>
      item
        .setTitle('Go to context')
        .setIcon('lucide-locate')
        .setSection(section)
        .onClick((evt) => {
          void actions.goToContext(file, Keymap.isModEvent(evt));
        })
    );
  }
  const route = actions.sourceRoute(file);
  if (route) {
    menu.addItem((item) =>
      item
        .setTitle(goToSourceTitle(route))
        .setIcon(SOURCE_ICONS[route.kind])
        .setSection(section)
        .onClick((evt) => {
          void actions.goToSource(file, Keymap.isModEvent(evt));
        })
    );
  }
}
