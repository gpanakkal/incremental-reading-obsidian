import { expect } from '@playwright/test';
import { executeCommandById, setDefaultEditingMode } from './helpers';
import { test } from './setup/fixtures';
import { createVaultCopy } from './setup/helpers';
import {
  bringSnippetsDue,
  confirmation,
  highlights,
  openNote,
  query,
  reviewing,
  select,
  snippetIds,
} from './setup/item-steps';
import {
  closeDevices,
  launchDevice,
  launchSecondDevice,
  waitForTakenOn,
  type Device,
} from './setup/two-device';

let deviceA: Device | undefined;
let deviceB: Device | undefined;

test.beforeEach(async () => {
  // One vault copy, two installs: each its own device to the plugin, each
  // seeing the other's saves through its own file watcher, as Sync delivers
  const vaultPath = await createVaultCopy('two-device');
  deviceA = await launchDevice(vaultPath);
  deviceB = await launchSecondDevice(vaultPath);
});

test.afterEach(async () => {
  await closeDevices([deviceA, deviceB]);
  deviceA = undefined;
  deviceB = undefined;
});

test('undoing a snippet another device has since reviewed asks first, and Cancel keeps it', async () => {
  const a = deviceA!.window;
  const b = deviceB!.window;

  // On A: make a snippet
  await setDefaultEditingMode(a, 'source');
  await openNote(a, 'Source note.md', 'Intro\n\nSpaced repetition text.');
  await select(a, 'repetition');
  await executeCommandById(a, 'incremental-reading:extract-selection');
  const [snippet] = await snippetIds(a, 1);
  await expect(highlights(a)).toHaveText(['repetition']);
  await bringSnippetsDue(a);
  await waitForTakenOn(a, b);

  // On B: review it, in the review tab
  expect(await snippetIds(b, 1)).toEqual([snippet]);
  await executeCommandById(b, 'incremental-reading:learn');
  await b.locator('css=#begin-review-button').click();
  await expect.poll(() => reviewing(b)).toBe(snippet);
  await executeCommandById(b, 'incremental-reading:mark-review');
  await expect
    .poll(async () =>
      (await query(b, 'SELECT snippet_id FROM snippet_review')).map(
        ({ snippet_id }) => String(snippet_id)
      )
    )
    .toEqual([snippet]);
  await waitForTakenOn(b, a);

  // On A: undo the snippet. The prompt names B's one review
  await executeCommandById(a, 'incremental-reading:undo');
  await expect(confirmation(a)).toBeVisible();
  await expect(confirmation(a).locator('li')).toHaveText([/^1 review$/]);

  // Cancel keeps it: the snippet and its highlight stay, and undo still
  // offers it
  await confirmation(a).locator('button.mod-cancel').click();
  await expect(confirmation(a)).toHaveCount(0);
  await expect(highlights(a)).toHaveText(['repetition']);
  expect(await snippetIds(a, 1)).toEqual([snippet]);
  await executeCommandById(a, 'incremental-reading:undo');
  await expect(confirmation(a)).toBeVisible();
  await confirmation(a).locator('button.mod-cancel').click();
  await expect(confirmation(a)).toHaveCount(0);
});
