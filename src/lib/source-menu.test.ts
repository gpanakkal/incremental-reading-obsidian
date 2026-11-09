import type { SourceRoute } from '#/lib/item-source';
import fc from 'fast-check';
// The Vitest alias points `obsidian` at this same file, so the `Menu` built
// here is the one filled; importing it by path gives TS its recorded `items`
import { Keymap, Menu, type MenuItem } from '#/test/__mocks__/obsidian';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addSourceMenuItems } from './source-menu';

// #region HELPERS
/** Every way Go to source can open a source. */
const routeArb: fc.Arbitrary<SourceRoute> = fc.oneof(
  fc.constant({ kind: 'file', file: { path: 'sources/Book.pdf' } as TFile }),
  fc.webUrl().map((url) => ({
    kind: 'web-viewer' as const,
    url,
    viewer: { openUrl: vi.fn() },
  })),
  fc.webUrl().map((url) => ({ kind: 'browser' as const, url }))
);

/** A click on a menu entry: any button Obsidian reports one for, any keys. */
const menuClickArb = fc.record({
  button: fc.constantFrom(0, 1),
  ctrlKey: fc.boolean(),
  metaKey: fc.boolean(),
  altKey: fc.boolean(),
  shiftKey: fc.boolean(),
});

/**
 * Go to context and Go to source added to a fresh menu in `section` (the
 * default when not given) for `file`, whose item has a context when
 * `context` and opens its source by `route`.
 */
function raise(context: boolean, route: SourceRoute | null, section?: string) {
  const file = { path: 'ir/Snippet.md', basename: 'Snippet' } as TFile;
  const actions = {
    hasContext: vi.fn((_file: TFile) => context),
    sourceRoute: vi.fn((_file: TFile) => route),
    goToContext: vi.fn().mockResolvedValue(undefined),
    goToSource: vi.fn().mockResolvedValue(undefined),
  };
  const menu = new Menu();
  addSourceMenuItems({ actions }, menu as never, file, section);
  return { menu, actions, file };
}

/** The entry clicking which runs `action`, found by running each. */
function entryRunning(
  menu: Menu,
  actions: ReturnType<typeof raise>['actions'],
  action: 'goToContext' | 'goToSource'
): MenuItem | undefined {
  return menu.items.find((item) => {
    actions[action].mockClear();
    item.callback?.(undefined);
    const runs = actions[action].mock.calls.length > 0;
    actions[action].mockClear();
    return runs;
  });
}
// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('addSourceMenuItems', () => {
  it('property: offers Go to context only for an item with a context, and Go to source only for one with a source, in the section asked for', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.option(routeArb, { nil: null }),
        fc.option(fc.constantFrom('pane', 'incremental-reading', 'open'), {
          nil: undefined,
        }),
        (context, route, section) => {
          const { menu, actions, file } = raise(context, route, section);

          expect(actions.hasContext).toHaveBeenCalledWith(file);
          expect(actions.sourceRoute).toHaveBeenCalledWith(file);
          expect(menu.items).toHaveLength(Number(context) + Number(!!route));
          expect(entryRunning(menu, actions, 'goToContext') !== undefined).toBe(
            context
          );
          expect(entryRunning(menu, actions, 'goToSource') !== undefined).toBe(
            route !== null
          );
          for (const item of menu.items) {
            expect(item.section).toBe(section ?? 'incremental-reading');
          }
        }
      )
    );
  });

  it('property: names Go to source for leaving the app exactly when it opens the system browser, with an icon for where it goes', () => {
    fc.assert(
      fc.property(routeArb, (route) => {
        const { menu, actions } = raise(false, route);

        const entry = entryRunning(menu, actions, 'goToSource');

        expect(entry?.title).toMatch(
          route.kind === 'browser' ? /in system browser$/ : /^(?!.*browser)/
        );
        expect(entry?.icon).toBe(
          {
            file: 'lucide-file-symlink',
            'web-viewer': 'lucide-globe-2',
            browser: 'lucide-external-link',
          }[route.kind]
        );
      })
    );
  });

  it('property: opens each in place, or where a modified or middle click asks', () => {
    fc.assert(
      fc.property(menuClickArb, routeArb, (init, route) => {
        const { menu, actions, file } = raise(true, route);
        const [contextEntry, sourceEntry] = menu.items;

        contextEntry?.callback?.(init);
        sourceEntry?.callback?.(init);

        const pane = Keymap.isModEvent(init as unknown as MouseEvent);
        expect(actions.goToContext).toHaveBeenCalledExactlyOnceWith(file, pane);
        expect(actions.goToSource).toHaveBeenCalledExactlyOnceWith(file, pane);
      })
    );
  });

  it('gives Go to context its locate icon', () => {
    const { menu, actions } = raise(true, null);

    expect(entryRunning(menu, actions, 'goToContext')?.icon).toBe(
      'lucide-locate'
    );
  });
});
