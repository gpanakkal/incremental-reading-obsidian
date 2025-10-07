import type { ArticleDisplay, ArticleRow, IArticleBase } from './types';

export default class Article {
  static rowToBase(articleRow: ArticleRow): IArticleBase {
    return {
      ...articleRow,
      dismissed: Boolean(articleRow.dismissed),
    };
  }

  static rowToDisplay(articleRow: ArticleRow): ArticleDisplay {
    return {
      ...articleRow,
      due: articleRow.due ? new Date(articleRow.due) : null,
      dismissed: Boolean(articleRow.dismissed),
    };
  }

  static displayToRow(article: ArticleDisplay): ArticleRow {
    return {
      ...article,
      due: article.due ? Date.parse(article.due.toISOString()) : null,
      dismissed: Number(article.dismissed),
    };
  }
}
