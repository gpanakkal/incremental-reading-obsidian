// @ts-check
// Warns, before an e2e run, when .obsidian-unpacked is behind the latest
// Obsidian desktop release. Always exits 0. OBSIDIAN_VERSION_CHECK=0 skips it.
import { fileURLToPath } from 'node:url';
import { checkObsidianVersion } from './lib/obsidian-version-check.mjs';

try {
  const notice = await checkObsidianVersion({
    root: fileURLToPath(new URL('..', import.meta.url)),
  });
  if (notice) console.warn(notice);
} catch {
  // Advisory only: never stop the run that comes after this
}
