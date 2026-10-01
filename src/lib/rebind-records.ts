import { MS_PER_DAY } from './constants';
import type { SQLiteRepository } from './types';

/**
 * How long a startup rebind stays open to being taken back. A rebind goes by
 * filename, so it can pick an unrelated namesake while the article's own file
 * is still on its way — Sync downloading it, most often. If that file turns up
 * at the old path within this window, the row goes back to it.
 *
 * A week covers a device that stays offline, or a vault left unopened, over a
 * few days. Much longer and the window starts to catch a *new* file of the
 * same name that the user put at the old path on purpose after a real move.
 */
export const RECLAIM_WINDOW_MS = 7 * MS_PER_DAY;

/** The log (see `appendLog`) that rebinds and reclaims are written to. */
export const REBIND_LOG_TOPIC = 'rebinds';

/** An article row moved from one path to another, by id. */
export interface PathMove {
  id: string;
  from: string;
  to: string;
}

/** A recorded rebind, next to where its article is now. */
export interface RebindState {
  articleId: string;
  oldReference: string;
  newReference: string;
  reboundAt: number;
  /** The article's reference now, or `null` when the article is gone. */
  reference: string | null;
  deleted: boolean;
}

/**
 * Whether `record` can still be taken back: recent enough, and its article
 * still where the rebind put it — deleted there or not, since deleting the
 * stand-in is no reason to give up on the article's own file. Once the
 * article has been moved on, or has sat at its new path for longer than the
 * window, the rebind has been lived with, and a file turning up at the old
 * path is a new one.
 */
export function isReclaimable(record: RebindState, now: number): boolean {
  return (
    record.reboundAt >= now - RECLAIM_WINDOW_MS &&
    record.reference === record.newReference
  );
}

/** Every recorded rebind, with where its article is now. */
export async function readRebinds(
  repo: Pick<SQLiteRepository, 'query'>
): Promise<RebindState[]> {
  const rows = (await repo.query(
    `SELECT r.article_id, r.old_reference, r.new_reference, r.rebound_at,
            a.reference, a.deleted
     FROM rebind r LEFT JOIN article a ON a.id = r.article_id
     ORDER BY r.article_id`,
    []
  )) as unknown as {
    article_id: string;
    old_reference: string;
    new_reference: string;
    rebound_at: number;
    reference: string | null;
    deleted: number | null;
  }[];
  return rows.map((row) => ({
    articleId: row.article_id,
    oldReference: row.old_reference,
    newReference: row.new_reference,
    reboundAt: row.rebound_at,
    reference: row.reference,
    deleted: row.deleted !== 0,
  }));
}

/**
 * Record that the startup scan rebound an article. An earlier rebind of the
 * same article still in its window keeps its old path and its time: the
 * article's own file is still expected there, and a stand-in going missing in
 * turn is no news of it. A lapsed one is simply replaced.
 */
export async function recordRebind(
  repo: Pick<SQLiteRepository, 'mutate'>,
  move: PathMove,
  at: number
): Promise<void> {
  await repo.mutate(
    `INSERT INTO rebind (article_id, old_reference, new_reference, rebound_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (article_id) DO UPDATE SET
       new_reference = excluded.new_reference,
       old_reference = CASE WHEN rebound_at >= $5
         THEN old_reference ELSE excluded.old_reference END,
       rebound_at = CASE WHEN rebound_at >= $5
         THEN rebound_at ELSE excluded.rebound_at END`,
    [move.id, move.from, move.to, at, at - RECLAIM_WINDOW_MS]
  );
}

/**
 * Drop an article's rebind record — only the one made at `reboundAt`, when
 * given, so a record written since is kept.
 */
export async function forgetRebind(
  repo: Pick<SQLiteRepository, 'mutate'>,
  articleId: string,
  reboundAt?: number
): Promise<void> {
  if (reboundAt === undefined) {
    await repo.mutate('DELETE FROM rebind WHERE article_id = $1', [articleId]);
    return;
  }
  await repo.mutate(
    'DELETE FROM rebind WHERE article_id = $1 AND rebound_at = $2',
    [articleId, reboundAt]
  );
}

/**
 * A file has turned up at `path`: if that is where a still-reclaimable rebind
 * took an article from, and no row names the path now, put the article back.
 * By the master plan's rule a PDF *is* its path, so the file at the article's
 * old path is its own, and the namesake it was rebound to was a stand-in.
 *
 * Reads first, so the many files that are no old path cost no write.
 * @returns the move made, or `null` for none
 */
export async function reclaimAtPath(
  repo: Pick<SQLiteRepository, 'query' | 'mutate' | 'transaction'>,
  path: string,
  now: number
): Promise<PathMove | null> {
  // Two articles rebound away from one path, at different times: no telling
  // which of them this file is
  const claimOf = async () => {
    const claims = (await repo.query(
      `SELECT r.article_id, r.new_reference FROM rebind r
       JOIN article a ON a.id = r.article_id
       WHERE r.old_reference = $1 AND r.rebound_at >= $2
         AND a.reference = r.new_reference`,
      [path, now - RECLAIM_WINDOW_MS]
    )) as unknown as { article_id: string; new_reference: string }[];
    return claims.length === 1 ? claims[0] : null;
  };
  if ((await claimOf()) === null) return null;

  return repo.transaction(async () => {
    // Asked again where nothing else can commit, now that it is worth a write
    const claim = await claimOf();
    if (claim === null) return null;
    // Whatever names the path now got there after the article left, so its
    // claim is the newer one; a tombstone there is restored by its own handler
    const holders = (await repo.query(
      `SELECT id FROM article WHERE reference = $1
       UNION ALL SELECT id FROM snippet WHERE reference = $1
       UNION ALL SELECT id FROM srs_card WHERE reference = $1`,
      [path]
    )) as unknown as { id: string }[];
    if (holders.length > 0) return null;

    const { article_id: id, new_reference: from } = claim;
    // A stand-in deleted meanwhile took the article with it; its own file
    // brings it back
    await repo.mutate(
      'UPDATE article SET reference = $1, deleted = 0 WHERE id = $2',
      [path, id]
    );
    await forgetRebind(repo, id);
    return { id, from, to: path };
  });
}

// #region LOG ENTRIES

export const describeRebind = ({ id, from, to }: PathMove) =>
  `rebound article ${id} by filename: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`;

export const describeReclaim = ({ id, from, to }: PathMove) =>
  `reclaimed article ${id}, whose own file turned up at its old path: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`;

export const describeAmbiguous = ({
  id,
  reference,
}: {
  id: string;
  reference: string;
}) =>
  `left article ${id} missing at ${JSON.stringify(reference)}: another missing article or more than one untracked file shares its filename`;

// #endregion
