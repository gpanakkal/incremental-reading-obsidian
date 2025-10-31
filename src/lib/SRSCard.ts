import type { ISRSCard, ISRSCardDisplay, SRSCardRow } from '#/lib/types';
import type { StateType } from 'ts-fsrs';
import { createEmptyCard, State } from 'ts-fsrs';
import { CARD_ANSWER_REPLACEMENT, CLOZE_GROUPS_PATTERN } from './constants';

/**
 *
 */
export default class SRSCard implements ISRSCard {
  id: string;
  reference: string;
  created_at: Date;
  due: Date;
  last_review?: Date;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  reps: number;
  lapses: number;
  state: State;

  constructor(reference: string, creationTime?: Date) {
    this.id = crypto.randomUUID();
    this.reference = reference;
    this.created_at = creationTime || new Date();
    const card = createEmptyCard(this.created_at);
    Object.assign(this, card);
  }

  static rowToDisplay(cardRow: SRSCardRow): ISRSCardDisplay {
    const { created_at, due, last_review, state, ...rest } = cardRow;
    return {
      ...rest,
      created_at: new Date(created_at),
      due: new Date(due),
      ...(last_review && {
        last_review: new Date(last_review),
      }),
      state: State[cardRow.state] as StateType,
    };
  }

  static displayToRow(card: ISRSCardDisplay): SRSCardRow {
    const { created_at, due, last_review, state, ...rest } = card;
    return {
      ...rest,
      created_at: Date.parse(created_at.toISOString()),
      due: Date.parse(due.toISOString()),
      last_review: last_review ? Date.parse(last_review?.toISOString()) : null,
      state: State[card.state],
    };
  }

  static cardToRow(card: ISRSCard): SRSCardRow {
    const { created_at, due, last_review, ...rest } = card;
    return {
      ...rest,
      created_at: Date.parse(created_at.toISOString()),
      due: Date.parse(due.toISOString()),
      last_review: last_review ? Date.parse(last_review?.toISOString()) : null,
    };
  }

  /** Format a card's text, replacing the answer with a placeholder */
  static hideAnswer(cardContent: string): string {
    const match = cardContent.match(CLOZE_GROUPS_PATTERN);
    if (!match) {
      throw new Error(`Valid cloze delimiters not found in: ${cardContent}`);
    }
    const [_, pre, _answer, post] = match;
    const formattedContent = pre + CARD_ANSWER_REPLACEMENT + post;
    return formattedContent;
  }
}
