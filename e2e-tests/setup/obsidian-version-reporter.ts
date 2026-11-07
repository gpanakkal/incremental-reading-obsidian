import type { Reporter, Suite } from '@playwright/test/reporter';
import { fileURLToPath } from 'node:url';
import { cachedNotice } from '../../scripts/lib/obsidian-version-check.mjs';

/** Projects that run against `.obsidian-unpacked`. */
const DESKTOP_PROJECTS = new Set(['e2e', 'e2e-setup']);

/**
 * Repeats the stale-Obsidian warning from `scripts/check-obsidian-version.mjs`
 * after the run, where the copy printed before it has scrolled away. Reads the
 * cached answer only, so it never fetches.
 */
export default class ObsidianVersionReporter implements Reporter {
  private desktop = false;

  onBegin(_config: unknown, suite: Suite) {
    try {
      this.desktop = suite.suites.some((project) =>
        DESKTOP_PROJECTS.has(project.project()?.name ?? '')
      );
    } catch {
      // Advisory only: a reporter that throws fails the whole run
    }
  }

  async onEnd() {
    if (!this.desktop) return;
    try {
      const notice = await cachedNotice({
        root: fileURLToPath(new URL('../../', import.meta.url)),
      });
      if (notice) console.log(`\n${notice}`);
    } catch {
      // Advisory only
    }
  }

  printsToStdio() {
    return false;
  }
}
