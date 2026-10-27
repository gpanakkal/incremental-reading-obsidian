// @vitest-environment jsdom
import type { QueueRow } from '#/components/types';
import * as DeleteMissingItemModule from '#/lib/delete-missing-item';
import * as ItemContextModule from '#/lib/item-context';
import { ObsidianHelpers as Obsidian } from '#/lib/ObsidianHelpers';
import type { MaybeMissingItem, ReviewItem } from '#/lib/types';
import * as UnimportArticleModule from '#/lib/unimport-article';
import type { Menu, MenuItem } from '#/test/__mocks__/obsidian';
import * as RelinkModalModule from '#/views/RelinkModal';
import { SchedulingModal } from '#/views/SchedulingModal';
import fc from 'fast-check';
import type { TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueRowMenu } from './queue-row-menu';

// #region HELPERS

const TYPES = ['article', 'snippet', 'card'] as const;
type RowType = (typeof TYPES)[number];

function makeFile(path = 'notes/x.md'): TFile {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { path, basename: name.replace(/\.md$/, '') } as TFile;
}

function makeQueueRow(overrides: Partial<QueueRow> = {}): QueueRow {
  return {
    id: 'a1',
    type: 'article',
    file: makeFile('articles/a1.md'),
    due: new Date(2026, 6, 10),
    reference: 'articles/a1.md',
    parent: null,
    scheduling: { kind: 'priority', value: '30' },
    ...overrides,
  };
}

function makeItem(type: RowType, file: TFile | null = makeFile()) {
  return { data: { id: 'a1', type }, file } as unknown as ReviewItem;
}

/**
 * A plugin whose collaborators the menu reaches are spies: each lookup
 * answers `item`, and every leaf the workspace hands out is `leaf`.
 */
function makePlugin({
  item = null as MaybeMissingItem | null,
}: { item?: MaybeMissingItem | null } = {}) {
  const leaf = { openFile: vi.fn().mockResolvedValue(undefined) };
  const explorer = { revealInFolder: vi.fn() };
  return {
    leaf,
    explorer,
    app: {
      workspace: { getLeaf: vi.fn().mockReturnValue(leaf) },
      fileManager: { promptForDeletion: vi.fn().mockResolvedValue(true) },
      internalPlugins: {
        getEnabledPluginById: vi.fn().mockReturnValue(explorer),
      },
    },
    reviewManager: {
      getReviewItemFromId: vi.fn().mockResolvedValue(item),
      getItemOrMissingFromId: vi.fn().mockResolvedValue(item),
    },
    actions: {
      goToContext: vi.fn().mockResolvedValue(undefined),
      dismissItem: vi.fn().mockResolvedValue(undefined),
    },
  };
}

function menuFor(plugin: unknown, row: QueueRow): Menu {
  return queueRowMenu(plugin as never, row) as unknown as Menu;
}

function entry(menu: Menu, icon: string): MenuItem {
  const found = menu.items.find((item) => item.icon === icon);
  if (!found) throw new Error(`No ${icon} entry`);
  return found;
}

/** Let a picked entry's lookups and the action after them run. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const rowArb = fc.record({
  type: fc.constantFrom(...TYPES),
  hasFile: fc.boolean(),
  parent: fc.option(fc.constantFrom('notes/parent.md', 'https://x.test/a'), {
    nil: null,
  }),
});

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('queue row menu entries', () => {
  it('groups open, scheduling, file and destructive entries in that order', () => {
    const menu = menuFor(makePlugin(), makeQueueRow());

    expect(menu.sections).toEqual(['open', 'schedule', 'file', 'danger']);
  });

  it('offers each row the entries that apply to its type and file, destructive ones as warnings', () => {
    fc.assert(
      fc.property(rowArb, ({ type, hasFile, parent }) => {
        const row = makeQueueRow({
          type,
          file: hasFile ? makeFile() : null,
          parent,
        });

        const menu = menuFor(makePlugin(), row);

        const expected = [
          ...(hasFile ? [['lucide-file-plus', 'open', false, false]] : []),
          ...(hasFile && parent !== null
            ? [['lucide-corner-left-up', 'open', false, false]]
            : []),
          ...(hasFile && type !== 'article'
            ? [['lucide-locate', 'open', false, false]]
            : []),
          ...(hasFile ? [['lucide-folder-open', 'open', false, false]] : []),
          ...(hasFile && type !== 'card'
            ? [['lucide-calendar-sync', 'schedule', false, false]]
            : []),
          ['lucide-ban', 'schedule', false, false],
          ['link', 'file', hasFile, false],
          hasFile
            ? ['lucide-trash-2', 'danger', false, true]
            : ['trash-2', 'danger', false, true],
          ...(hasFile && type === 'article'
            ? [['file-x', 'danger', false, true]]
            : []),
        ];
        expect(
          menu.items.map((item) => [
            item.icon,
            item.section,
            item.disabled,
            item.warning,
          ])
        ).toEqual(expected);
      })
    );
  });

  it('does nothing until an entry is picked', () => {
    const relink = vi.spyOn(RelinkModalModule, 'openRelinkPicker');
    const deleteMissing = vi.spyOn(
      DeleteMissingItemModule,
      'deleteMissingItem'
    );
    const unimport = vi.spyOn(UnimportArticleModule, 'unimportArticle');
    fc.assert(
      fc.property(rowArb, ({ type, hasFile, parent }) => {
        const plugin = makePlugin();

        menuFor(
          plugin,
          makeQueueRow({ type, file: hasFile ? makeFile() : null, parent })
        );

        expect(plugin.app.workspace.getLeaf).not.toHaveBeenCalled();
        expect(plugin.app.fileManager.promptForDeletion).not.toHaveBeenCalled();
        expect(plugin.reviewManager.getReviewItemFromId).not.toHaveBeenCalled();
        expect(
          plugin.reviewManager.getItemOrMissingFromId
        ).not.toHaveBeenCalled();
        expect(plugin.actions.goToContext).not.toHaveBeenCalled();
        expect(plugin.explorer.revealInFolder).not.toHaveBeenCalled();
      })
    );
    expect(relink).not.toHaveBeenCalled();
    expect(deleteMissing).not.toHaveBeenCalled();
    expect(unimport).not.toHaveBeenCalled();
  });
});

describe('queue row menu actions', () => {
  it('opens the row’s note in a new, active tab', () => {
    const plugin = makePlugin();
    const file = makeFile('notes/row.md');

    entry(
      menuFor(plugin, makeQueueRow({ file })),
      'lucide-file-plus'
    ).callback?.(undefined);

    expect(plugin.app.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith('tab');
    expect(plugin.leaf.openFile).toHaveBeenCalledExactlyOnceWith(file, {
      active: true,
    });
  });

  it.each(TYPES)(
    'reveals the row’s note in the file explorer as Obsidian’s file menu does (%s)',
    (type) => {
      const plugin = makePlugin();
      const file = makeFile('notes/row.md');

      entry(
        menuFor(plugin, makeQueueRow({ type, file })),
        'lucide-folder-open'
      ).callback?.(undefined);

      expect(
        plugin.app.internalPlugins.getEnabledPluginById
      ).toHaveBeenCalledExactlyOnceWith('file-explorer');
      expect(plugin.explorer.revealInFolder).toHaveBeenCalledExactlyOnceWith(
        file
      );
    }
  );

  it.each([
    [undefined, false],
    [{ ctrlKey: true }, 'tab'],
  ])(
    'goes to a snippet’s or card’s context through review’s own action, where the click asks (%o)',
    (evt, newLeaf) => {
      for (const type of ['snippet', 'card'] as const) {
        const plugin = makePlugin();
        const file = makeFile();

        entry(
          menuFor(plugin, makeQueueRow({ type, file })),
          'lucide-locate'
        ).callback?.(evt);

        expect(plugin.actions.goToContext).toHaveBeenCalledExactlyOnceWith(
          file,
          newLeaf
        );
      }
    }
  );

  it('opens an article’s source note in a new tab', async () => {
    const source = makeFile('sources/book.md');
    const article = makeItem('article');
    const findSource = vi
      .spyOn(ItemContextModule, 'findArticleSource')
      .mockReturnValue({ file: source });
    const findContext = vi.spyOn(ItemContextModule, 'findContextFile');
    const plugin = makePlugin({ item: article });

    entry(
      menuFor(plugin, makeQueueRow({ id: 'a1', parent: source.path })),
      'lucide-corner-left-up'
    ).callback?.(undefined);
    await settle();

    expect(plugin.reviewManager.getReviewItemFromId).toHaveBeenCalledWith('a1');
    expect(findSource).toHaveBeenCalledExactlyOnceWith(plugin.app, article);
    expect(findContext).not.toHaveBeenCalled();
    expect(plugin.app.workspace.getLeaf).toHaveBeenCalledExactlyOnceWith('tab');
    expect(plugin.leaf.openFile).toHaveBeenCalledExactlyOnceWith(source, {
      active: true,
    });
  });

  it.each(['snippet', 'card'] as const)(
    'opens a %s’s parent note in a new tab',
    async (type) => {
      const parent = makeFile('notes/parent.md');
      const item = makeItem(type);
      const findContext = vi
        .spyOn(ItemContextModule, 'findContextFile')
        .mockResolvedValue(parent);
      const findSource = vi.spyOn(ItemContextModule, 'findArticleSource');
      const plugin = makePlugin({ item });

      entry(
        menuFor(plugin, makeQueueRow({ type, parent: parent.path })),
        'lucide-corner-left-up'
      ).callback?.(undefined);
      await settle();

      expect(findContext).toHaveBeenCalledExactlyOnceWith(
        plugin.app,
        plugin.reviewManager,
        item
      );
      expect(findSource).not.toHaveBeenCalled();
      expect(plugin.leaf.openFile).toHaveBeenCalledExactlyOnceWith(parent, {
        active: true,
      });
    }
  );

  it('says so, and opens nothing, when the item has no parent or source note left', async () => {
    const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
    vi.spyOn(ItemContextModule, 'findArticleSource').mockReturnValue({
      file: null,
      reason: 'outside-vault',
    });
    vi.spyOn(ItemContextModule, 'findContextFile').mockResolvedValue(null);
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...TYPES), async (type) => {
        notify.mockClear();
        const plugin = makePlugin({ item: makeItem(type) });
        const file = makeFile('notes/Row title.md');

        entry(
          menuFor(plugin, makeQueueRow({ type, file, parent: 'p.md' })),
          'lucide-corner-left-up'
        ).callback?.(undefined);
        await settle();

        expect(plugin.leaf.openFile).not.toHaveBeenCalled();
        expect(notify).toHaveBeenCalledTimes(1);
        expect(notify.mock.calls[0][0]).toContain('Row title');
      })
    );
  });

  it('says so, and does nothing else, when the row’s item is gone by the time an entry is picked', async () => {
    const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
    const findSource = vi.spyOn(ItemContextModule, 'findArticleSource');
    const findContext = vi.spyOn(ItemContextModule, 'findContextFile');
    const open = vi
      .spyOn(SchedulingModal.prototype, 'open')
      .mockImplementation(() => {});
    await fc.assert(
      fc.asyncProperty(rowArb, async ({ type, hasFile, parent }) => {
        notify.mockClear();
        const plugin = makePlugin({ item: null });
        const row = makeQueueRow({
          type,
          file: hasFile ? makeFile('notes/Row title.md') : null,
          reference: 'gone/Missing title.md',
          parent,
        });
        const menu = menuFor(plugin, row);
        const lookups: (string | null)[] = [
          'lucide-ban',
          'lucide-corner-left-up',
          'lucide-calendar-sync',
        ];
        const offered = menu.items.filter((item) =>
          lookups.includes(item.icon)
        );

        for (const item of offered) item.callback?.(undefined);
        await settle();

        expect(notify).toHaveBeenCalledTimes(offered.length);
        for (const [message] of notify.mock.calls) {
          expect(message).toContain(
            hasFile ? 'Row title' : 'gone/Missing title.md'
          );
        }
        expect(findSource).not.toHaveBeenCalled();
        expect(findContext).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(plugin.actions.dismissItem).not.toHaveBeenCalled();
        expect(plugin.leaf.openFile).not.toHaveBeenCalled();
      })
    );
  });

  it('cuts a long note name short in that notice', async () => {
    const notify = vi.spyOn(Obsidian, 'notify').mockImplementation(() => {});
    const plugin = makePlugin({ item: null });
    const name = 'x'.repeat(40) + 'y'.repeat(20);

    entry(
      menuFor(
        plugin,
        makeQueueRow({ file: makeFile(`notes/${name}.md`), parent: 'p.md' })
      ),
      'lucide-corner-left-up'
    ).callback?.(undefined);
    await settle();

    expect(notify.mock.calls[0][0]).toContain('x'.repeat(40) + 'yyyyyyy...');
    expect(notify.mock.calls[0][0]).not.toContain('y'.repeat(8));
  });

  it.each(['article', 'snippet'] as const)(
    'opens the scheduling dialog on the %s as it is now',
    async (type) => {
      const opened: SchedulingModal[] = [];
      vi.spyOn(SchedulingModal.prototype, 'open').mockImplementation(function (
        this: SchedulingModal
      ) {
        opened.push(this);
      });
      const item = makeItem(type);
      const plugin = makePlugin({ item });

      entry(
        menuFor(plugin, makeQueueRow({ id: 'a1', type })),
        'lucide-calendar-sync'
      ).callback?.(undefined);
      await settle();

      expect(plugin.reviewManager.getReviewItemFromId).toHaveBeenCalledWith(
        'a1'
      );
      expect(opened).toHaveLength(1);
      expect(opened[0].item).toBe(item);
      expect(opened[0].plugin).toBe(plugin);
    }
  );

  it('opens no scheduling dialog for an item that is no article or snippet', async () => {
    const open = vi
      .spyOn(SchedulingModal.prototype, 'open')
      .mockImplementation(() => {});
    const plugin = makePlugin({ item: makeItem('card') });

    entry(
      menuFor(plugin, makeQueueRow({ type: 'snippet' })),
      'lucide-calendar-sync'
    ).callback?.(undefined);
    await settle();

    expect(open).not.toHaveBeenCalled();
  });

  it('dismisses the row’s item through review’s own action, missing or not', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...TYPES),
        fc.boolean(),
        async (type, hasFile) => {
          const item = makeItem(type, hasFile ? makeFile() : null);
          const plugin = makePlugin({ item });

          entry(
            menuFor(
              plugin,
              makeQueueRow({ id: 'x', type, file: hasFile ? makeFile() : null })
            ),
            'lucide-ban'
          ).callback?.(undefined);
          await settle();

          expect(
            plugin.reviewManager.getItemOrMissingFromId
          ).toHaveBeenCalledExactlyOnceWith('x');
          expect(plugin.actions.dismissItem).toHaveBeenCalledExactlyOnceWith(
            item
          );
        }
      )
    );
  });

  it.each([
    ['article', 'article'],
    ['snippet', 'snippet'],
    ['card', 'srs_card'],
  ] as const)('relinks a missing %s from its own table', (type, table) => {
    const openRelinkPicker = vi
      .spyOn(RelinkModalModule, 'openRelinkPicker')
      .mockResolvedValue(null);
    const plugin = makePlugin();

    entry(
      menuFor(
        plugin,
        makeQueueRow({ id: 'x', type, reference: 'gone.md', file: null })
      ),
      'link'
    ).callback?.(undefined);

    expect(openRelinkPicker).toHaveBeenCalledExactlyOnceWith(plugin, {
      table,
      id: 'x',
      reference: 'gone.md',
    });
  });

  it('asks to delete the row’s note as review’s ⋮ menu does', () => {
    const plugin = makePlugin();
    const file = makeFile();

    entry(menuFor(plugin, makeQueueRow({ file })), 'lucide-trash-2').callback?.(
      undefined
    );

    expect(
      plugin.app.fileManager.promptForDeletion
    ).toHaveBeenCalledExactlyOnceWith(file);
  });

  it.each(TYPES)('permanently deletes a missing %s once picked', (type) => {
    const deleteMissingItem = vi
      .spyOn(DeleteMissingItemModule, 'deleteMissingItem')
      .mockResolvedValue(true);
    const plugin = makePlugin();
    const row = makeQueueRow({ id: 'x', type, file: null });

    entry(menuFor(plugin, row), 'trash-2').callback?.(undefined);

    expect(deleteMissingItem).toHaveBeenCalledExactlyOnceWith(plugin, row);
  });

  it('un-imports the row’s file once its entry is picked', () => {
    const unimportArticle = vi
      .spyOn(UnimportArticleModule, 'unimportArticle')
      .mockResolvedValue(true);
    const plugin = makePlugin();
    const file = makeFile();

    entry(menuFor(plugin, makeQueueRow({ file })), 'file-x').callback?.(
      undefined
    );

    expect(unimportArticle).toHaveBeenCalledExactlyOnceWith(plugin, file);
  });
});
