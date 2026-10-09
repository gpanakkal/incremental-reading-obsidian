# Troubleshooting

## Sync overwrote my review data

If you use [Obsidian Sync](https://obsidian.md/sync) and your review history or queue suddenly looks empty or out of date on one device, Sync has probably overwritten the plugin's database with an older copy. This can happen if you used the plugin on a second device before turning on **Sync all other types** there.

To recover the database:

1. Open the file explorer and find `incremental-reading/ir-user-data.sqlite`.
2. Right-click it (on mobile, tap and hold until it's highlighted) and select **Open version history**.
3. Select the newest version from the device you used first, then select **Restore**.
4. On every device, go to **Settings → Sync** and turn on **Sync all other types** so it doesn't happen again.

> [!TIP]
> If you can't see the database file, turn on **Settings → Files and links → Show all file types**.

## A command is missing from the command palette

Some commands only appear in certain situations:

- **Review commands** such as **Review: show answer/mark reviewed** and the grading commands only work while the review tab is active.
- **Import article** is hidden while the review tab is active. Switch to the note you want to import first.
- **Extract selection to snippet** isn't available in reading view. Switch to live preview or source mode.
- **Quick import**, **Open import dialog...**, **Import article as copy**, and **Import article in place** only appear after you turn on **Enable extra import hotkeys** in [settings](/reference/settings#shortcuts).

See [Commands](/reference/commands) for the full list.

## A note says "Not in database"

A note has the plugin's tags (`ir-article`, `ir-text-snippet`, or `ir-card`) but no matching entry in the database. This usually means the database was reset or replaced, for example [by Sync](#sync-overwrote-my-review-data), or the note was copied from another vault.

If it's an article, run **Import article** on it again. If the database was overwritten by Sync, restore it using the steps above.

## "Text must be selected"

**Extract selection to snippet** and **Create spaced repetition card** both need selected text. For a card, select only the words that should be the answer, not the whole paragraph.

## Known limitations

- **Special formatting can break.** Making a snippet or card from part of a code block, blockquote, LaTeX block, or other special formatting can break that formatting. Include the whole block when you make the snippet or card, then edit it afterward.
- **Markdown notes only.** Importing, making snippets, and making cards only work on Markdown notes. Support for web pages and PDFs is planned. For now, [convert them to Markdown](/guide/importing) first.

## Report a problem

If something isn't covered here, [open an issue on GitHub](https://github.com/gpanakkal/incremental-reading-obsidian/issues). Include your plugin version, your Obsidian version, whether you're on desktop or mobile, and the steps to reproduce the problem.
