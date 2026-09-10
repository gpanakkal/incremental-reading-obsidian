// @vitest-environment jsdom
import ReviewView from '#/views/ReviewView';
import { MarkdownView, type FileView, type TFile } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerFileExplorerActiveFileClick } from './FileExplorerActiveFileClick';

// #region HELPERS

const ITEM_PATH = 'IR/Articles/Under review.md';

/** Cleanups for the `document` listeners each `makePlugin` attaches. */
const teardown: Array<() => void> = [];

/**
 * A file explorer row, shaped like the DOM Obsidian builds: `data-path` and
 * `is-active` on the row itself, the clickable label nested inside it.
 */
function makeNavFileRow(
  path: string,
  { active = true }: { active?: boolean } = {}
): { row: HTMLElement; label: HTMLElement } {
  const row = document.createElement('div');
  row.className = `tree-item-self nav-file-title is-clickable${
    active ? ' is-active' : ''
  }`;
  row.setAttribute('data-path', path);
  const label = document.createElement('div');
  label.className = 'tree-item-inner nav-file-title-content';
  label.textContent = path;
  row.appendChild(label);
  document.body.appendChild(row);
  return { row, label };
}

/**
 * A `ReviewView` displaying `path`, built without running the constructor —
 * only `instanceof` and `file` matter here, and the real constructor wants a
 * leaf, a plugin and a review manager.
 */
function makeReviewView(path: string | null): ReviewView {
  const view = Object.create(ReviewView.prototype) as ReviewView;
  view.file = path === null ? null : ({ path } as TFile);
  return view;
}

/** An ordinary note tab holding `path`, for the "not our doing" cases. */
function makeMarkdownFileView(path: string): FileView {
  const view = new (MarkdownView as new () => MarkdownView)();
  return Object.assign(view, {
    file: { path } as TFile,
  }) as unknown as FileView;
}

function makePlugin({
  activeFileView = makeReviewView(ITEM_PATH),
  files = { [ITEM_PATH]: { path: ITEM_PATH } as TFile },
}: {
  activeFileView?: FileView | null;
  files?: Record<string, TFile>;
} = {}) {
  const openFile = vi.fn();
  const getLeaf = vi.fn(() => ({ openFile }));
  const plugin = {
    app: {
      workspace: {
        getActiveFileView: vi.fn(() => activeFileView),
        getLeaf,
      },
      vault: {
        getFileByPath: vi.fn((path: string) => files[path] ?? null),
      },
    },
    registerDomEvent: (
      el: Document,
      type: string,
      cb: EventListener,
      options?: AddEventListenerOptions
    ) => {
      el.addEventListener(type, cb, options);
      teardown.push(() => el.removeEventListener(type, cb, options));
    },
  };
  return { plugin, openFile, getLeaf };
}

function click(el: HTMLElement, init: MouseEventInit = {}): MouseEvent {
  const evt = new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
  el.dispatchEvent(evt);
  return evt;
}

// #endregion

describe('registerFileExplorerActiveFileClick', () => {
  afterEach(() => {
    teardown.splice(0).forEach((fn) => fn());
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  describe('the reviewed note is clicked', () => {
    it('opens the clicked note in a new tab', () => {
      const { plugin, openFile, getLeaf } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const { row } = makeNavFileRow(ITEM_PATH);

      click(row);

      expect(getLeaf).toHaveBeenCalledWith('tab');
      expect(openFile).toHaveBeenCalledWith(
        { path: ITEM_PATH },
        { active: true }
      );
    });

    it('opens when the click lands on the label inside the row', () => {
      const { plugin, openFile } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const { label } = makeNavFileRow(ITEM_PATH);

      click(label);

      expect(openFile).toHaveBeenCalledOnce();
    });

    it("stops the event before the explorer's own row handler swallows it", () => {
      const { plugin } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const { row, label } = makeNavFileRow(ITEM_PATH);
      const rowHandler = vi.fn();
      row.addEventListener('click', rowHandler);

      const evt = click(label);

      expect(rowHandler).not.toHaveBeenCalled();
      expect(evt.defaultPrevented).toBe(true);
    });

    it('opens the note even while the review tab shows the home screen', () => {
      // `file` legitimately stays pointed at the last item off the review page,
      // and the explorer keeps the row marked active, so the click still dies.
      const { plugin, openFile } = makePlugin({
        activeFileView: makeReviewView(ITEM_PATH),
      });
      registerFileExplorerActiveFileClick(plugin as never);
      const { row } = makeNavFileRow(ITEM_PATH);

      click(row);

      expect(openFile).toHaveBeenCalledOnce();
    });
  });

  describe('clicks Obsidian already handles', () => {
    it.each([
      ['mod-click', { ctrlKey: true }],
      ['cmd-click', { metaKey: true }],
      ['middle click', { button: 1 }],
      ['alt-click', { altKey: true }],
      ['shift-click', { shiftKey: true }],
      ['right click', { button: 2 }],
    ])('leaves %s alone', (_label, init) => {
      const { plugin, openFile } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const { row } = makeNavFileRow(ITEM_PATH);
      const rowHandler = vi.fn();
      row.addEventListener('click', rowHandler);

      click(row, init);

      expect(openFile).not.toHaveBeenCalled();
      expect(rowHandler).toHaveBeenCalledOnce();
    });

    it('leaves a row that is not the active file alone', () => {
      const { plugin, openFile } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const { row } = makeNavFileRow('IR/Articles/Other.md', { active: false });
      const rowHandler = vi.fn();
      row.addEventListener('click', rowHandler);

      click(row);

      expect(openFile).not.toHaveBeenCalled();
      expect(rowHandler).toHaveBeenCalledOnce();
    });

    it('leaves clicks outside the file explorer alone', () => {
      const { plugin, openFile } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const stray = document.body.appendChild(document.createElement('div'));

      click(stray);

      expect(openFile).not.toHaveBeenCalled();
    });
  });

  describe('the review view is not what made the row active', () => {
    it('leaves the click alone when an ordinary note tab holds the file', () => {
      const { plugin, openFile } = makePlugin({
        activeFileView: makeMarkdownFileView(ITEM_PATH),
      });
      registerFileExplorerActiveFileClick(plugin as never);
      const { row } = makeNavFileRow(ITEM_PATH);
      const rowHandler = vi.fn();
      row.addEventListener('click', rowHandler);

      click(row);

      expect(openFile).not.toHaveBeenCalled();
      expect(rowHandler).toHaveBeenCalledOnce();
    });

    it('leaves the click alone when there is no active file view', () => {
      const { plugin, openFile } = makePlugin({ activeFileView: null });
      registerFileExplorerActiveFileClick(plugin as never);

      click(makeNavFileRow(ITEM_PATH).row);

      expect(openFile).not.toHaveBeenCalled();
    });

    it('leaves the click alone when the review view holds a different file', () => {
      const { plugin, openFile } = makePlugin({
        activeFileView: makeReviewView('IR/Articles/Elsewhere.md'),
      });
      registerFileExplorerActiveFileClick(plugin as never);

      click(makeNavFileRow(ITEM_PATH).row);

      expect(openFile).not.toHaveBeenCalled();
    });

    it('leaves the click alone when the review view holds no file', () => {
      const { plugin, openFile } = makePlugin({
        activeFileView: makeReviewView(null),
      });
      registerFileExplorerActiveFileClick(plugin as never);

      click(makeNavFileRow(ITEM_PATH).row);

      expect(openFile).not.toHaveBeenCalled();
    });
  });

  describe('the path does not resolve', () => {
    it('does not open anything when the vault has no file at that path', () => {
      const { plugin, openFile, getLeaf } = makePlugin({ files: {} });
      registerFileExplorerActiveFileClick(plugin as never);

      click(makeNavFileRow(ITEM_PATH).row);

      expect(getLeaf).not.toHaveBeenCalled();
      expect(openFile).not.toHaveBeenCalled();
    });

    it('does not open anything when the active row has no data-path', () => {
      const { plugin, openFile } = makePlugin();
      registerFileExplorerActiveFileClick(plugin as never);
      const { row } = makeNavFileRow(ITEM_PATH);
      row.removeAttribute('data-path');

      click(row);

      expect(openFile).not.toHaveBeenCalled();
    });
  });
});
