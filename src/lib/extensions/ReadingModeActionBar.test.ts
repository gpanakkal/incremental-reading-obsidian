// @vitest-environment jsdom
/* eslint-disable obsidianmd/no-tfile-tfolder-cast -- test file */
import { ObsidianHelpers } from '#/lib/ObsidianHelpers';
import * as ActionBarExtension from '#/lib/extensions/ActionBarExtension';
import ReviewView from '#/views/ReviewView';
import { MarkdownView, type TFile, type WorkspaceLeaf } from 'obsidian';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerReadingModeActionBar } from './ReadingModeActionBar';

// #region HELPERS

type FakeLeaf = {
  view: MarkdownView & {
    getMode: ReturnType<typeof vi.fn>;
    file: TFile | null;
    previewMode: { containerEl: HTMLElement };
    getViewType: ReturnType<typeof vi.fn>;
  };
};

function makeContainerEl(): HTMLElement {
  return document.createElement('div');
}

function makeMarkdownLeaf(overrides: {
  mode?: string;
  file?: TFile | null;
  containerEl?: HTMLElement;
}): FakeLeaf {
  const containerEl = overrides.containerEl ?? makeContainerEl();
  const view = Object.assign(new (MarkdownView as new () => MarkdownView)(), {
    getMode: vi.fn().mockReturnValue(overrides.mode ?? 'preview'),
    file:
      overrides.file !== undefined
        ? overrides.file
        : ({ path: 'test.md' } as TFile),
    previewMode: { containerEl },
    getViewType: vi.fn().mockReturnValue('markdown'),
  });
  return { view } as unknown as FakeLeaf;
}

function makeNonMarkdownLeaf(viewType = 'other'): {
  view: { getViewType: ReturnType<typeof vi.fn> };
} {
  return {
    view: { getViewType: vi.fn().mockReturnValue(viewType) },
  };
}

function makePlugin(leaves: FakeLeaf[] = []) {
  const registeredCleanups: Array<() => void> = [];
  let layoutChangeHandler: (() => void) | null = null;

  const workspace = {
    iterateAllLeaves: vi.fn((cb: (leaf: WorkspaceLeaf) => void) => {
      for (const leaf of leaves) {
        cb(leaf as unknown as WorkspaceLeaf);
      }
    }),
    on: vi.fn((event: string, handler: () => void) => {
      if (event === 'layout-change') layoutChangeHandler = handler;
      return Symbol('event-ref');
    }),
    triggerLayoutChange: () => layoutChangeHandler?.(),
  };

  return {
    app: { workspace },
    registerEvent: vi.fn(),
    register: vi.fn((fn: () => void) => {
      registeredCleanups.push(fn);
    }),
    runCleanup: () => registeredCleanups.forEach((fn) => fn()),
    _leaves: leaves,
  };
}

// #endregion

describe('registerReadingModeActionBar', () => {
  beforeEach(() => {
    vi.spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM').mockImplementation(() => {});
    vi.spyOn(ObsidianHelpers, 'getNoteType').mockReturnValue('article');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('initial syncAll on registration', () => {
    it('calls iterateAllLeaves immediately on registration', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      expect(plugin.app.workspace.iterateAllLeaves).toHaveBeenCalledTimes(1);
    });

    it('registers a layout-change event listener', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      expect(plugin.app.workspace.on).toHaveBeenCalledWith('layout-change', expect.any(Function));
      expect(plugin.registerEvent).toHaveBeenCalledTimes(1);
    });

    it('registers a cleanup callback', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);
      expect(plugin.register).toHaveBeenCalledTimes(1);
    });
  });

  describe('sync() — view is not a MarkdownView instance', () => {
    it('does not mount a bar when the leaf has a non-MarkdownView', () => {
      const leaf = makeNonMarkdownLeaf();
      const plugin = makePlugin([leaf as unknown as FakeLeaf]);
      registerReadingModeActionBar(plugin as never);
      expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
    });

    it('skips ReviewView leaves entirely (no controller created)', () => {
      const reviewLeaf = makeNonMarkdownLeaf(ReviewView.viewType);
      const plugin = makePlugin([reviewLeaf as unknown as FakeLeaf]);
      registerReadingModeActionBar(plugin as never);
      expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
    });
  });

  describe('sync() — MarkdownView, wrong mode', () => {
    it('does not mount when view mode is "source" (edit mode)', () => {
      const leaf = makeMarkdownLeaf({ mode: 'source' });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
    });

    it('does not mount when view mode is "live" (live preview)', () => {
      const leaf = makeMarkdownLeaf({ mode: 'live' });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
    });

    it.each(['source', 'live', '', 'other'])(
      'does not mount for mode %j (not "preview")',
      (mode) => {
        vi.spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM').mockImplementation(() => {});
        vi.spyOn(ObsidianHelpers, 'getNoteType').mockReturnValue('article');
        const leaf = makeMarkdownLeaf({ mode });
        const plugin = makePlugin([leaf]);
        registerReadingModeActionBar(plugin as never);
        expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
      }
    );
  });

  describe('sync() — MarkdownView in preview, file is null', () => {
    it('does not mount when view.file is null', () => {
      const leaf = makeMarkdownLeaf({ file: null });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
    });
  });

  describe('sync() — MarkdownView in preview, file present, noteType is null', () => {
    it('does not mount when getNoteType returns null', () => {
      vi.spyOn(ObsidianHelpers, 'getNoteType').mockReturnValue(null);
      const leaf = makeMarkdownLeaf({});
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);
      expect(ActionBarExtension.renderStandaloneActionBarDOM).not.toHaveBeenCalled();
    });
  });

  describe('sync() — happy path: mount', () => {
    it('mounts a bar with correct class names for a valid preview leaf', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      expect(ActionBarExtension.renderStandaloneActionBarDOM).toHaveBeenCalledOnce();
      const [calledFile, calledPlugin, calledBar] =
        (ActionBarExtension.renderStandaloneActionBarDOM as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledFile).toBe(leaf.view.file);
      expect(calledPlugin).toBe(plugin);
      expect(calledBar).toBeInstanceOf(HTMLElement);
      expect((calledBar as HTMLElement).className).toBe(
        'ir-action-bar ir-action-bar-panel ir-reading-mode-bar'
      );
    });

    it('prepends the bar element to the container', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      expect(containerEl.firstElementChild?.className).toContain('ir-reading-mode-bar');
    });

    it.each(['article', 'snippet', 'card'] as const)(
      'mounts for NoteType %j',
      (noteType) => {
        vi.spyOn(ActionBarExtension, 'renderStandaloneActionBarDOM').mockImplementation(() => {});
        vi.spyOn(ObsidianHelpers, 'getNoteType').mockReturnValue(noteType);
        const containerEl = makeContainerEl();
        const leaf = makeMarkdownLeaf({ containerEl });
        const plugin = makePlugin([leaf]);
        registerReadingModeActionBar(plugin as never);
        expect(ActionBarExtension.renderStandaloneActionBarDOM).toHaveBeenCalledOnce();
      }
    );
  });

  describe('mount() — idempotency', () => {
    it('does not mount a second bar if the bar is already in the container', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      plugin.app.workspace.triggerLayoutChange();

      // renderStandaloneActionBarDOM should only have been called once (first mount)
      expect(ActionBarExtension.renderStandaloneActionBarDOM).toHaveBeenCalledOnce();
    });

    it('re-mounts the bar if it was removed from the container', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      // Detach the bar from the DOM to simulate it being removed
      containerEl.innerHTML = '';

      plugin.app.workspace.triggerLayoutChange();

      expect(ActionBarExtension.renderStandaloneActionBarDOM).toHaveBeenCalledTimes(2);
    });
  });

  describe('unmount() — bar removal', () => {
    it('removes the bar element from the DOM when unmount is triggered via mode change', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      expect(containerEl.children.length).toBe(1);

      leaf.view.getMode.mockReturnValue('source');
      plugin.app.workspace.triggerLayoutChange();

      expect(containerEl.children.length).toBe(0);
    });

    it('removes the bar when view.file becomes null', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      leaf.view.file = null;
      plugin.app.workspace.triggerLayoutChange();

      expect(containerEl.children.length).toBe(0);
    });

    it('removes the bar when getNoteType changes to null', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      vi.spyOn(ObsidianHelpers, 'getNoteType').mockReturnValue(null);
      plugin.app.workspace.triggerLayoutChange();

      expect(containerEl.children.length).toBe(0);
    });
  });

  describe('layout-change — controller lifecycle', () => {
    it('creates a new controller for a leaf that appears after initial registration', () => {
      const plugin = makePlugin([]);
      registerReadingModeActionBar(plugin as never);

      const containerEl = makeContainerEl();
      const newLeaf = makeMarkdownLeaf({ containerEl });
      plugin._leaves.push(newLeaf);
      plugin.app.workspace.iterateAllLeaves.mockImplementation(
        (cb: (leaf: WorkspaceLeaf) => void) => {
          for (const l of plugin._leaves) cb(l as unknown as WorkspaceLeaf);
        }
      );
      plugin.app.workspace.triggerLayoutChange();

      expect(ActionBarExtension.renderStandaloneActionBarDOM).toHaveBeenCalledOnce();
    });

    it('unmounts and removes controllers for leaves that disappear', () => {
      const containerEl = makeContainerEl();
      const leaf = makeMarkdownLeaf({ containerEl });
      const plugin = makePlugin([leaf]);
      registerReadingModeActionBar(plugin as never);

      expect(containerEl.children.length).toBe(1);

      plugin._leaves.length = 0;
      plugin.app.workspace.iterateAllLeaves.mockImplementation(
        (cb: (leaf: WorkspaceLeaf) => void) => {
          for (const l of plugin._leaves) cb(l as unknown as WorkspaceLeaf);
        }
      );
      plugin.app.workspace.triggerLayoutChange();

      expect(containerEl.children.length).toBe(0);
    });
  });

  describe('cleanup callback', () => {
    it('unmounts all bars when the plugin cleanup runs', () => {
      const containers = [makeContainerEl(), makeContainerEl()];
      const leaves = containers.map((c) => makeMarkdownLeaf({ containerEl: c }));
      const plugin = makePlugin(leaves);
      registerReadingModeActionBar(plugin as never);

      expect(containers[0].children.length).toBe(1);
      expect(containers[1].children.length).toBe(1);

      plugin.runCleanup();

      expect(containers[0].children.length).toBe(0);
      expect(containers[1].children.length).toBe(0);
    });
  });
});
