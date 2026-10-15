import { configureSuccessNotices } from '#/lib/notices';
import type { SuccessNoticeLevel } from '#/lib/settings';

/** Every success notice level, as stored. */
export const SUCCESS_NOTICE_LEVELS: readonly SuccessNoticeLevel[] = [
  'all',
  'minimal',
  'none',
];

/**
 * Show success notices at `level`, inside review and out. Undo with
 * `configureSuccessNotices(null)` in `afterEach`: the setting is module state.
 */
export function showSuccessNotices(level: SuccessNoticeLevel) {
  configureSuccessNotices({
    settings: {
      successNoticesInReview: level,
      successNoticesOutsideReview: level,
    },
    getActiveReviewView: () => null,
  });
}
