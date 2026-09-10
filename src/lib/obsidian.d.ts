import 'obsidian';

declare module 'obsidian' {
  interface Workspace extends Events {
    on(
      name: 'ir-highlights-changed',
      callback: (
        editor: Editor,
        info: MarkdownFileInfo | MarkdownView
      ) => unknown,
      ctx?: unknown
    ): EventRef;
  }

  /**
   * Undocumented, and missing from `obsidian-typings`: retitles a popout's own
   * OS window from its most recent leaf's `getDisplayText()`. The main window's
   * equivalent is `Workspace.updateTitle`.
   */
  interface WorkspaceWindow {
    updateTitle(): void;
  }

  /**
   * Undocumented, and missing from `obsidian-typings`. `titleParentEl` is the
   * `.view-header-title-parent` element holding the folder breadcrumb that
   * precedes `titleEl` inside `titleContainerEl`; `renderBreadcrumbs` empties it
   * and refills it from `this.file?.parent?.path`. Obsidian calls it from only
   * two places — `FileView.loadFile` and its vault-rename handler — so a view
   * that assigns `this.file` itself has to call it itself.
   */
  interface FileView {
    titleParentEl: HTMLElement;
    renderBreadcrumbs(): void;
  }
}
