// Card, Snippet, ReviewLog, FSRSParameters
import type { Primitive, SafeOmit } from '#/lib/utility-types';
import type { TAbstractFile, TFile } from 'obsidian';
import type { Card, ReviewLog, StateType } from 'ts-fsrs';
import type { SOURCE_PROPERTY_NAME, TABLE_NAMES } from './constants';

export interface IArticleBase {
  id: string;
  type: 'article';
  reference: string;
  due: number | null;
  due_fuzz: number | null;
  interval: number;
  dismissed: boolean;
  deleted: boolean;
  priority: number;
  fixed_interval_days: number | null;
  scroll_top: number;
}

export interface ArticleRow
  extends SafeOmit<IArticleBase, 'dismissed' | 'type'> {
  dismissed: number;
}

export interface ArticleDisplay extends SafeOmit<IArticleBase, 'due'> {
  due: Date | null;
}

export interface IArticleReview {
  id: string;
  article_id: string;
  review_time: number;
}

export interface ISnippetBase {
  id: string;
  type: 'snippet';
  reference: string;
  due: number | null;
  due_fuzz: number | null;
  interval: number;
  dismissed: boolean;
  deleted: boolean;
  priority: number;
  parent: string | null;
  start_offset: number | null;
  end_offset: number | null;
  scroll_top: number;
}

export interface SnippetRow
  extends SafeOmit<ISnippetBase, 'dismissed' | 'type'> {
  dismissed: number;
}

export interface ISnippetDisplay extends SafeOmit<ISnippetBase, 'due'> {
  due: Date | null;
}

export interface ISnippetReview {
  id: string;
  snippet_id: string;
  review_time: number; // Unix timestamp
}

export interface ISRSCard extends Card {
  id: string;
  type: 'card';
  reference: string;
  created_at: Date;
  dismissed: boolean;
  deleted: boolean;
}

export interface ISRSCardDisplay extends SafeOmit<ISRSCard, 'state'> {
  state: StateType;
}

export interface SRSCardRow
  extends SafeOmit<
    ISRSCard,
    'created_at' | 'due' | 'last_review' | 'dismissed' | 'type'
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

/** Any item subject to non-SRS scheduling */
export type ReviewText = ReviewArticle | ReviewSnippet;

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

export function isReviewText(value: ReviewItem): value is ReviewText {
  return isReviewSnippet(value) || isReviewArticle(value);
}

export function isSRSCard(value: ISnippetBase | ISRSCard): value is ISRSCard {
  return 'state' in value;
}

export function isReviewCard(value: ReviewItem): value is ReviewCard {
  return 'state' in value.data;
}

export type NoteType = ReviewItem['data']['type'];

export function getItemType(item: ReviewItem): NoteType {
  if (isReviewSnippet(item)) return 'snippet';
  else if (isReviewCard(item)) return 'card';
  else if (isReviewArticle(item)) return 'article';
  else
    throw new TypeError(
      `Type not identified for item:\n${JSON.stringify(item)}`
    );
}

/**
 * Frontmatter properties used by this plugin
 */
export type PluginFrontMatter = {
  [SOURCE_PROPERTY_NAME]?: string;
  'ir-id'?: string;
  tags?: string[];
  delimiters?: [string, string];
  created?: string;
};

export type FrontMatterUpdates = SafeOmit<PluginFrontMatter, 'tags'> & {
  tags?: string | string[];
};

export interface SQLiteRepository {
  query(query: string, params?: Primitive[]): RowTypes[] | Promise<RowTypes[]>;
  mutate(query: string, params?: Primitive[]): [][] | Promise<[][]>;
  _execSql(
    query: string,
    params?: Primitive[]
  ): RowTypes[][] | Promise<RowTypes[][]>;
  handleFileChange(file: TAbstractFile): Promise<void>;
}

export type SchedulingStrategy = 'priority' | 'fixed-interval';
