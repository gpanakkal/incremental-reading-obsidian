// @vitest-environment jsdom

import type IncrementalReadingPlugin from '#/main';
import ReviewView from '#/views/ReviewView';
import fc from 'fast-check';
import type { Command } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initReviewCommands } from './review-commands';

// #region HELPERS

const TOGGLE_SOURCE_ID = 'toggle-source-mode';

/**
 * The editor `IREditor` publishes while an item is on screen, seen the way the
 * view sees it: the controller sitting in `activeEditor`, with the editor
 * itself on its `editMode`. `toggleSource` is the half of the switch Obsidian
 * owns, and flips the editor's own flag.
 */
function makeMountedEditor(sourceMode: boolean) {
  const editMode = {
    sourceMode,
    toggleSource: vi.fn(() => {
      editMode.sourceMode = !editMode.sourceMode;
    }),
  };
  return { editMode };
}

/**
 * A review tab the commands can act on. Constructing a real ReviewView is not
 * possible under the obsidian mock, whose `FileView` is an empty class with no
 * `register`, so the receiver carries only the fields the source-mode switch
 * reads and borrows the real methods off the prototype — the point being that
 * the command is measured against the actual `reviewEditor` and
 * `toggleSourceMode`, not against stand-ins that could drift from them.
 */
function makeReviewView(
  editor: ReturnType<typeof makeMountedEditor> | null,
  sourceMode: boolean
) {
  const receiver = { activeEditor: editor, sourceMode };
  Object.setPrototypeOf(receiver, ReviewView.prototype);
  return receiver as unknown as ReviewView & { sourceMode: boolean };
}

/**
 * Registers the review commands against a stub plugin and hands back what they
 * registered. Only `addCommand` and `getActiveReviewView` are reached, since
 * registration never runs a callback.
 */
function wireCommands(view: ReviewView | null) {
  const commands = new Map<string, Command>();
  const plugin = {
    addCommand: vi.fn((command: Command) => {
      commands.set(command.id, command);
      return command;
    }),
    getActiveReviewView: () => view,
  } as unknown as IncrementalReadingPlugin;

  initReviewCommands(plugin);
  return commands;
}

/** The registered source-mode command, wired to `view`. */
function toggleSourceCommand(view: ReviewView | null) {
  const command = wireCommands(view).get(TOGGLE_SOURCE_ID);
  if (!command?.checkCallback) {
    throw new Error(`${TOGGLE_SOURCE_ID} registered no checkCallback`);
  }
  return command.checkCallback;
}

/** A tab with an editor mounted, in a known mode, and the command over it. */
function mountedSetup(sourceMode: boolean) {
  const editor = makeMountedEditor(sourceMode);
  const view = makeReviewView(editor, sourceMode);
  return { editor, view, check: toggleSourceCommand(view) };
}

// #endregion

afterEach(() => {
  vi.restoreAllMocks();
});

describe('review source mode command', () => {
  it("registers under its own id, since Obsidian's editor:toggle-source cannot serve a FileView", () => {
    const command = wireCommands(null).get(TOGGLE_SOURCE_ID);

    expect(command).toMatchObject({
      id: TOGGLE_SOURCE_ID,
      name: 'Toggle live preview/source mode',
      icon: 'lucide-code-2',
    });
  });

  it('reports unavailable when no review tab is active', () => {
    fc.assert(
      fc.property(fc.boolean(), (checking) => {
        expect(toggleSourceCommand(null)(checking)).toBe(false);
      })
    );
  });

  it('reports unavailable while the review tab has no editor mounted', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (checking, sourceMode) => {
        const view = makeReviewView(null, sourceMode);

        expect(toggleSourceCommand(view)(checking)).toBe(false);
        // The remembered mode is the tab's, and outlives any one editor: a
        // command that declined to run must not have moved it.
        expect(view.sourceMode).toBe(sourceMode);
      })
    );
  });

  it('reports available while an editor is mounted', () => {
    fc.assert(
      fc.property(fc.boolean(), (sourceMode) => {
        expect(mountedSetup(sourceMode).check(true)).toBe(true);
      })
    );
  });

  it('never switches mode while only reporting availability', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.nat({ max: 12 }), (sourceMode, checks) => {
        const { editor, view, check } = mountedSetup(sourceMode);

        for (let i = 0; i < checks; i++) check(true);

        expect(view.sourceMode).toBe(sourceMode);
        expect(editor.editMode.sourceMode).toBe(sourceMode);
        expect(editor.editMode.toggleSource).not.toHaveBeenCalled();
      })
    );
  });

  it('switches both the editor on screen and the mode the tab remembers', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.nat({ max: 12 }), (sourceMode, runs) => {
        const { editor, view, check } = mountedSetup(sourceMode);

        for (let i = 0; i < runs; i++) expect(check(false)).toBeUndefined();

        const flipped = runs % 2 === 1;
        expect(view.sourceMode).toBe(flipped ? !sourceMode : sourceMode);
        expect(editor.editMode.sourceMode).toBe(view.sourceMode);
        expect(editor.editMode.toggleSource).toHaveBeenCalledTimes(runs);
      })
    );
  });
});
