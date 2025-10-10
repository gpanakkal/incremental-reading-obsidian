import type { ISnippetBase, ISnippetDisplay, SnippetRow } from './types';

export default class Snippet {
  static rowToBase(snippetRow: SnippetRow): ISnippetBase {
    return {
      ...snippetRow,
      dismissed: Boolean(snippetRow.dismissed),
    };
  }

  static rowToDisplay(snippetRow: SnippetRow): ISnippetDisplay {
    return {
      ...snippetRow,
      due: snippetRow.due ? new Date(snippetRow.due) : null,
      dismissed: Boolean(snippetRow.dismissed),
    };
  }

  static displayToRow(snippet: ISnippetDisplay): SnippetRow {
    return {
      ...snippet,
      due: snippet.due ? Date.parse(snippet.due.toISOString()) : null,
      dismissed: Number(snippet.dismissed),
    };
  }
}
