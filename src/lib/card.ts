import { randomUUID } from 'crypto';
import type { ISRSCard } from 'src/db/types';
import { createEmptyCard, type State } from 'ts-fsrs';

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
    this.id = randomUUID();
    this.reference = reference;
    this.created_at = creationTime || new Date();
    const card = createEmptyCard(this.created_at);
    Object.assign(this, card);
  }
}
