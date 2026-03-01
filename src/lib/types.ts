// Card, Snippet, ReviewLog, FSRSParameters
import type { Card, ReviewLog, StateType } from 'ts-fsrs';
import type { TABLE_NAMES } from './constants';
import type { SafeOmit } from 'src/lib/utility-types';
import type { TFile } from 'obsidian';

export interface IArticleBase {
  id: string;
  reference: string;
  due: number | null;
  dismissed: boolean;
  priority: number;
  scroll_top: number;
}

export interface ArticleRow extends SafeOmit<IArticleBase, 'dismissed'> {
  dismissed: number;
}

export interface ArticleDisplay extends SafeOmit<IArticleBase, 'due'> {
  due: Date | null;
}

export interface IArticleActive extends IArticleBase {
  due: number;
  dismissed: false;
}

export interface IArticleDismissed extends IArticleBase {
  due: null;
  dismissed: true;
}

export interface IArticleReview {
  id: string;
  article_id: string;
  review_time: number;
}

export interface ISnippetBase {
  id: string;
  reference: string;
  due: number | null;
  dismissed: boolean;
  priority: number;
  parent: string | null;
  start_offset: number | null;
  end_offset: number | null;
  scroll_top: number;
}

export interface SnippetRow extends SafeOmit<ISnippetBase, 'dismissed'> {
  dismissed: number;
}

export interface ISnippetDisplay extends SafeOmit<ISnippetBase, 'due'> {
  due: Date | null;
}

export interface ISnippetActive extends ISnippetBase {
  due: number;
  dismissed: false;
}

export interface ISnippetDismissed extends ISnippetBase {
  due: null;
  dismissed: true;
}

export interface ISnippetReview {
  id: string;
  snippet_id: string;
  review_time: number; // Unix timestamp
}

export interface ISRSCard extends Card {
  id: string;
  reference: string;
  created_at: Date;
  dismissed: boolean;
}

export interface ISRSCardDisplay extends SafeOmit<ISRSCard, 'state'> {
  state: StateType;
  showAnswer: boolean;
}

export interface SRSCardRow
  extends SafeOmit<
    ISRSCard,
    'created_at' | 'due' | 'last_review' | 'dismissed'
  > {
  created_at: number;
  due: number;
  last_review: number | null;
  dismissed: number;
}
export interface ISRSCardReview extends ReviewLog {
  id: string;
  card_id: string;
}

export interface SRSCardReviewRow
  extends SafeOmit<ISRSCardReview, 'due' | 'review'> {
  due: number;
  review: number;
}

export type TableName = (typeof TABLE_NAMES)[number];

export type RowTypes =
  | ArticleRow
  | IArticleReview
  | SnippetRow
  | ISnippetReview
  | SRSCardRow
  | ISRSCardReview;

export interface TableNameToRowType extends Record<TableName, RowTypes> {
  article: ArticleRow;
  article_review: IArticleReview;
  snippet: SnippetRow;
  snippet_review: ISnippetReview;
  srs_card: SRSCardRow;
  srs_card_review: ISRSCardReview;
}

export type ReviewArticle = {
  data: IArticleBase;
  file: TFile;
};

export type ReviewSnippet = {
  data: ISnippetBase;
  file: TFile;
};

export type ReviewCard = {
  data: ISRSCardDisplay;
  file: TFile;
};

export type ReviewItem = ReviewArticle | ReviewSnippet | ReviewCard;

export function isArticle(
  value: IArticleBase | ISnippetBase | ISRSCard
): value is IArticleBase {
  return 'dismissed' in value && !('parent' in value);
}

export function isReviewArticle(value: ReviewItem): value is ReviewArticle {
  return (
    'dismissed' in value.data &&
    !('parent' in value.data) &&
    !('state' in value.data)
  );
}

export function isSnippet(
  value: ISnippetBase | ISRSCard
): value is ISnippetBase {
  return 'dismissed' in value;
}

export function isReviewSnippet(value: ReviewItem): value is ReviewSnippet {
  return !isReviewCard(value) && 'parent' in value.data;
}

export function isSRSCard(value: ISnippetBase | ISRSCard): value is ISRSCard {
  return 'state' in value;
}

export function isReviewCard(value: ReviewItem): value is ReviewCard {
  return 'state' in value.data;
}

export type NoteType = 'article' | 'snippet' | 'card';
