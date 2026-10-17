/**
 * Why a `SQLiteRepository.bulkMutate` run stopped short, and how far it got:
 * its first `committed` statements, of `total`, are in the database to stay,
 * and none after them is. `cause` is what stopped it: a failing statement,
 * writes being refused, or a save that failed after its chunk committed.
 *
 * The message leaves `cause` out, which a console shows with it anyway: text
 * made of whatever was thrown could throw in turn, and lose the count.
 */
export class BulkMutateError extends Error {
  constructor(
    readonly committed: number,
    total: number,
    cause: unknown
  ) {
    super(`Stopped after committing ${committed} of ${total} statements`, {
      cause,
    });
    this.name = 'BulkMutateError';
  }
}
