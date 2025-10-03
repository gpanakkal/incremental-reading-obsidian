import { randomUUID } from 'crypto';
import type { ISRSCardReview, SRSCardReviewRow } from 'src/db/types';
import type { ReviewLog } from 'ts-fsrs';
import type { State } from 'ts-fsrs';

/**
 *
 */
export default class SRSCardReview implements ISRSCardReview {
  id: string;
  card_id: string;
  due: Date;
  review: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  last_elapsed_days: number;
  scheduled_days: number;
  rating: number;
  state: State;

  constructor(cardId: string, reviewLog: ReviewLog) {
    this.id = randomUUID();
    this.card_id = cardId;
    Object.assign(this, reviewLog);
  }

  static rowToDisplay(cardRow: SRSCardReviewRow): ISRSCardReview {
    const { due, review, ...rest } = cardRow;
    return {
      ...rest,
      due: new Date(due),
      review: new Date(review),
    };
  }

  static displayToRow(card: ISRSCardReview): SRSCardReviewRow {
    const { due, review, ...rest } = card;
    return {
      ...rest,
      due: Date.parse(due.toISOString()),
      review: Date.parse(review.toISOString()),
    };
  }
}
