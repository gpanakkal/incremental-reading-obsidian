import type { ISRSCardReview, SRSCardReviewRow } from '#/lib/types';
import type { ReviewLog, State } from 'ts-fsrs';

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
    this.id = crypto.randomUUID();
    this.card_id = cardId;
    ({
      due: this.due,
      review: this.review,
      stability: this.stability,
      difficulty: this.difficulty,
      elapsed_days: this.elapsed_days,
      last_elapsed_days: this.last_elapsed_days,
      scheduled_days: this.scheduled_days,
      rating: this.rating,
      state: this.state,
    } = reviewLog);
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
