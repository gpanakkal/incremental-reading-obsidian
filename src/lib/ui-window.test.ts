import fc from 'fast-check';
import type { App, Menu, MenuPositionDef, Modal } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  adoptWindow,
  openModal,
  showMenu,
  type UiOrigin,
  uiWindow,
} from './ui-window';

// #region HELPERS

/**
 * A stand-in for a browser window: whether it is closed, and whether its
 * document has OS focus. Its document points back at it, as a real one does.
 */
type FakeWindow = Window & { readonly label: number };

function makeWindow(label: number, focused: boolean, closed: boolean) {
  const win = { label, closed } as unknown as FakeWindow;
  const doc = {
    nodeType: 9,
    ownerDocument: null,
    hasFocus: () => focused,
    defaultView: win,
  };
  Object.assign(win, { document: doc });
  return win;
}

/** Window flags: whether it has focus, whether it is closed. */
const windowFlagsArb = fc.record({
  focused: fc.boolean(),
  closed: fc.boolean(),
});

/**
 * Where an action came from, as a recipe against the window pool: nothing,
 * an element or a document in one of the windows, an event from one of them
 * or from none (Obsidian's native menus build their own click event), or an
 * element whose document is in no window (`defaultView` null).
 */
type OriginRecipe =
  | { kind: 'none'; nil: null | undefined }
  | { kind: 'element' | 'document' | 'event'; at: number }
  | { kind: 'event-without-view' }
  | { kind: 'windowless-element' };

const originRecipeArb: fc.Arbitrary<OriginRecipe> = fc.oneof(
  fc.record({
    kind: fc.constant('none' as const),
    nil: fc.constantFrom(null, undefined),
  }),
  fc.record({
    kind: fc.constantFrom(
      'element' as const,
      'document' as const,
      'event' as const
    ),
    at: fc.nat(),
  }),
  fc.record({ kind: fc.constant('event-without-view' as const) }),
  fc.record({ kind: fc.constant('windowless-element' as const) })
);

function buildOrigin(recipe: OriginRecipe, pool: FakeWindow[]): UiOrigin {
  switch (recipe.kind) {
    case 'none':
      return recipe.nil;
    case 'element':
      return {
        nodeType: 1,
        ownerDocument: pool[recipe.at % pool.length].document,
      } as unknown as Node;
    case 'document':
      return pool[recipe.at % pool.length].document as unknown as Node;
    case 'event':
      return { view: pool[recipe.at % pool.length] } as unknown as UIEvent;
    case 'event-without-view':
      return { view: null } as unknown as UIEvent;
    case 'windowless-element':
      return {
        nodeType: 1,
        ownerDocument: { defaultView: null },
      } as unknown as Node;
  }
}

/** The window an origin recipe names, or null when it names none. */
function recipeWindow(recipe: OriginRecipe, pool: FakeWindow[]) {
  return recipe.kind === 'element' ||
    recipe.kind === 'document' ||
    recipe.kind === 'event'
    ? pool[recipe.at % pool.length]
    : null;
}

/**
 * A pool of windows (the first is the main `window`), which of them is
 * Obsidian's `activeWindow`, the windows of the workspace's leaves (any of
 * the pool, repeats and the main window included, in leaf order), and an
 * origin.
 */
const sceneArb = fc
  .array(windowFlagsArb, { minLength: 1, maxLength: 5 })
  .chain((flags) =>
    fc.record({
      flags: fc.constant(flags),
      active: fc.nat({ max: flags.length - 1 }),
      leaves: fc.array(fc.nat({ max: flags.length - 1 }), { maxLength: 6 }),
      origin: originRecipeArb,
    })
  );

type SceneSpec = {
  flags: { focused: boolean; closed: boolean }[];
  active: number;
  leaves: number[];
  origin: OriginRecipe;
};

type Scene = {
  pool: FakeWindow[];
  main: FakeWindow;
  active: FakeWindow;
  app: App;
  origin: UiOrigin;
  recipe: OriginRecipe;
  leafWindows: FakeWindow[];
};

/**
 * Install a scene: `window`, `activeWindow` and `activeDocument` as globals,
 * and an app whose workspace iterates the leaves.
 */
function installScene({ flags, active, leaves, origin }: SceneSpec): Scene {
  const pool = flags.map((f, i) => makeWindow(i, f.focused, f.closed));
  const main = pool[0];
  const leafWindows = leaves.map((i) => pool[i]);
  const app = {
    workspace: {
      iterateAllLeaves(callback: (leaf: unknown) => void) {
        for (const win of leafWindows) {
          callback({ getContainer: () => ({ win }) });
        }
      },
    },
  } as unknown as App;
  vi.stubGlobal('window', main);
  vi.stubGlobal('activeWindow', pool[active]);
  vi.stubGlobal('activeDocument', pool[active].document);
  return {
    pool,
    main,
    active: pool[active],
    app,
    origin: buildOrigin(origin, pool),
    recipe: origin,
    leafWindows,
  };
}

const isFocused = (win: FakeWindow) => !win.closed && win.document.hasFocus();

/**
 * Where plugin UI belongs, spelled out: the open window the action came
 * from; else Obsidian's `activeWindow` while it is the main window or has
 * focus; else the first
 * focused window of the main window and the leaves'; else `activeWindow`,
 * or the main window should that be closed.
 */
function expectedWindow(scene: Scene): FakeWindow {
  const from = recipeWindow(scene.recipe, scene.pool);
  if (from && !from.closed) return from;
  if (scene.active === scene.main || isFocused(scene.active)) {
    return scene.active;
  }
  const focused = [scene.main, ...scene.leafWindows].find(isFocused);
  if (focused) return focused;
  return scene.active.closed ? scene.main : scene.active;
}

function makeModal(app: App) {
  const opened: { activeWindow: Window; activeDocument: Document }[] = [];
  const modal = {
    app,
    open: vi.fn(() => {
      opened.push({ activeWindow, activeDocument });
    }),
  } as unknown as Modal;
  return { modal, opened };
}

function makeMenu() {
  const shown: {
    position: MenuPositionDef;
    doc: Document | undefined;
    activeWindow: Window;
  }[] = [];
  const menu = {
    showAtPosition(this: Menu, position: MenuPositionDef, doc?: Document) {
      shown.push({ position, doc, activeWindow });
      return this;
    },
  } as unknown as Menu;
  return { menu, shown };
}

const positionArb: fc.Arbitrary<MenuPositionDef> = fc.record(
  {
    x: fc.integer(),
    y: fc.integer(),
    width: fc.integer(),
    overlap: fc.boolean(),
    left: fc.boolean(),
  },
  { requiredKeys: ['x', 'y'] }
);

// #endregion

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('uiWindow', () => {
  it('picks the open window the action came from, else the focused window, else activeWindow', () => {
    fc.assert(
      fc.property(sceneArb, (arb) => {
        const scene = installScene(arb);

        expect(uiWindow(scene.app, scene.origin)).toBe(expectedWindow(scene));
      })
    );
  });

  it('keeps the settings window when the action came from it', () => {
    const main = makeWindow(0, false, false);
    const settings = makeWindow(1, true, false);
    vi.stubGlobal('window', main);
    vi.stubGlobal('activeWindow', main);
    const button = { nodeType: 1, ownerDocument: settings.document };
    const app = { workspace: { iterateAllLeaves: () => {} } } as unknown as App;

    expect(uiWindow(app, button as unknown as Node)).toBe(settings);
  });

  it('leaves a stale activeWindow for the main window holding focus', () => {
    const main = makeWindow(0, true, false);
    const settings = makeWindow(1, false, false);
    vi.stubGlobal('window', main);
    vi.stubGlobal('activeWindow', settings);
    const app = { workspace: { iterateAllLeaves: () => {} } } as unknown as App;

    expect(uiWindow(app)).toBe(main);
  });
});

describe('adoptWindow', () => {
  it('makes the window plugin UI belongs in Obsidian’s activeWindow and activeDocument, and returns it', () => {
    fc.assert(
      fc.property(sceneArb, (arb) => {
        const scene = installScene(arb);
        const expected = expectedWindow(scene);

        expect(adoptWindow(scene.app, scene.origin)).toBe(expected);
        expect(activeWindow).toBe(expected);
        expect(activeDocument).toBe(expected.document);
      })
    );
  });
});

describe('openModal', () => {
  it('opens the modal once, in the window it belongs in', () => {
    fc.assert(
      fc.property(sceneArb, (arb) => {
        const scene = installScene(arb);
        const expected = expectedWindow(scene);
        const { modal, opened } = makeModal(scene.app);

        openModal(modal, scene.origin);

        expect(opened).toEqual([
          { activeWindow: expected, activeDocument: expected.document },
        ]);
      })
    );
  });
});

describe('showMenu', () => {
  it('shows the menu once, at the position, in the document of the window it belongs in', () => {
    fc.assert(
      fc.property(sceneArb, positionArb, (arb, position) => {
        const scene = installScene(arb);
        const expected = expectedWindow(scene);
        const { menu, shown } = makeMenu();

        const returned = showMenu(scene.app, menu, position, scene.origin);

        expect(returned).toBe(menu);
        expect(shown).toHaveLength(1);
        expect(shown[0].position).toBe(position);
        expect(shown[0].doc).toBe(expected.document);
        expect(shown[0].activeWindow).toBe(expected);
      })
    );
  });
});
