// Card, Snippet, ReviewLog, FSRSParameters
import type { Card, ReviewLog, StateType } from 'ts-fsrs';
import type { TABLE_NAMES } from '../lib/constants';
import type { SafeOmit } from 'src/lib/utility-types';
import type { TFile } from 'obsidian';

export interface ISRSCard extends Card {
  id: string;
  reference: string;
  created_at: Date;
}

export interface ISRSCardDisplay extends SafeOmit<ISRSCard, 'state'> {
  state: StateType;
}

export interface SRSCardRow
  extends SafeOmit<ISRSCard, 'created_at' | 'due' | 'last_review'> {
  created_at: number;
  due: number;
  last_review: number | null;
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

export interface ISnippetBase {
  id: string;
  reference: string;
  due: number | null;
  dismissed: boolean;
  priority: number;
  parent?: string;
}

export interface ISnippet extends ISnippetBase {
  id: string;
  reference: string;
  due: number;
  dismissed: false;
  priority: number;
  parent?: string;
}

export interface IDismissedSnippet extends ISnippetBase {
  due: null;
  dismissed: true;
}

export interface ISnippetReview {
  id: string;
  snippet_id: string;
  review_time: number; // Unix timestamp
}

export type TableName = (typeof TABLE_NAMES)[number];

export type RowTypes = ISnippet | ISnippetReview | SRSCardRow | ISRSCardReview;
export interface TableNameToRowType extends Record<TableName, RowTypes> {
  snippet: ISnippet;
  snippet_review: ISnippetReview;
  srs_card: SRSCardRow;
  srs_card_review: ISRSCardReview;
}

export type ReviewCard = {
  data: ISRSCardDisplay;
  file: TFile;
};

export type ReviewSnippet = {
  data: ISnippet;
  file: TFile;
};

export type ReviewItem = ReviewCard | ReviewSnippet;

export function isSnippet(value: ISnippet | ISRSCard): value is ISnippet {
  return 'dismissed' in value;
}

export function isSRSCard(value: ISnippet | ISRSCard): value is ISRSCard {
  return 'state' in value;
}

export function isReviewCard(value: ReviewItem): value is ReviewCard {
  return 'state' in value.data;
}
