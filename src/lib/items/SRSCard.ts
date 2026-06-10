import type { ISRSCard } from '#/lib/types';
import type { State } from 'ts-fsrs';
import { createEmptyCard } from 'ts-fsrs';

export default class SRSCard implements ISRSCard {
  id: string;
  type: 'card';
  reference: string;
  created_at: Date;
  due: Date;
  dismissed: boolean;
  deleted: boolean;
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
    this.type = 'card';
    this.reference = reference;
    this.created_at = creationTime || new Date();
    this.dismissed = false;
    this.deleted = false;
    const card = createEmptyCard(this.created_at);

    ({
      due: this.due,
      stability: this.stability,
      difficulty: this.difficulty,
      elapsed_days: this.elapsed_days,
      scheduled_days: this.scheduled_days,
      reps: this.reps,
      lapses: this.lapses,
      state: this.state,
      last_review: this.last_review,
    } = card);
  }
}
