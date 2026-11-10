import { Keymap, type Menu, type TFile } from 'obsidian';
import type { Actions } from './Actions';
import { goToSourceTitle, type SourceRoute } from './item-source';

/**
 * How a Go to context or Go to source control reads: its name and its icon
 * (an Obsidian icon id). One for the menus' entries and the review bar's
 * buttons alike, so the two never tell the user different things.
 */
export type SourceControl = { label: string; icon: string };

/** Go to context's control. */
export const GO_TO_CONTEXT: SourceControl = {
  label: 'Go to context',
  icon: 'lucide-locate',
};

/** The icon of Go to source's control: where it takes the user. */
const SOURCE_ICONS: Record<SourceRoute['kind'], string> = {
  file: 'lucide-file-symlink',
  'web-viewer': 'lucide-globe-2',
  browser: 'lucide-external-link',
};

/**
 * Go to source's control for a source opened by `route`: named for whether
 * it leaves the app (see `goToSourceTitle`), drawn for where it goes.
 */
export function goToSourceControl(route: SourceRoute): SourceControl {
  return { label: goToSourceTitle(route), icon: SOURCE_ICONS[route.kind] };
}

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
        .setTitle(GO_TO_CONTEXT.label)
        .setIcon(GO_TO_CONTEXT.icon)
        .setSection(section)
        .onClick((evt) => {
          void actions.goToContext(file, Keymap.isModEvent(evt));
        })
    );
  }
  const route = actions.sourceRoute(file);
  if (route) {
    const { label, icon } = goToSourceControl(route);
    menu.addItem((item) =>
      item
        .setTitle(label)
        .setIcon(icon)
        .setSection(section)
        .onClick((evt) => {
          void actions.goToSource(file, Keymap.isModEvent(evt));
        })
    );
  }
}
