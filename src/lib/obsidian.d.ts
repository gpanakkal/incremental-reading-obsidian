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
}
