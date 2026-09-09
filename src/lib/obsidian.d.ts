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
}
