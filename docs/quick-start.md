# Quick start

This page takes you from installing the plugin to finishing your first review session. It only takes a few minutes.

## 1. Install the plugin

In Obsidian, go to **Settings → Community plugins**. Turn on community plugins if you haven't already, then select **Browse**, search for "Incremental Reading", and install and enable it.

## 2. Set up Obsidian Sync

Skip this step if you don't use [Obsidian Sync](https://obsidian.md/sync).

The plugin keeps its review data in a database file, and Sync ignores that file type by default. On **every** device, go to **Settings → Sync** and turn on **Sync all other types**.

> [!WARNING]
> If you use the plugin on a second device before turning this on, Sync can overwrite the database. You can recover it by following [Sync overwrote my review data](/troubleshooting#sync-overwrote-my-review-data).

## 3. Set up hotkeys

You'll extract snippets and make cards constantly, so give those two commands keyboard shortcuts. Go to **Settings → Hotkeys**, search for "Incremental Reading", and assign keys to:

- **Extract selection to snippet** (suggested: <kbd>Alt</kbd>+<kbd>X</kbd>)
- **Create spaced repetition card** (suggested: <kbd>Alt</kbd>+<kbd>Z</kbd>)

The plugin doesn't set any hotkeys for you. See [Recommended hotkeys](/reference/commands#recommended-hotkeys) for a complete set.

## 4. Import an article

1. Get the text you want to learn from into an Obsidian note. For web pages, [Obsidian Web Clipper](/guide/importing#web-pages) is the easiest way.
2. With the note open, run **Incremental Reading: Import article** from the command palette. You can also right-click the note in the file explorer, or open the note's **⋮** menu, and select **Import article**.
3. In the import dialog, pick a priority. Lower numbers bring the article back more often. The default of 3 is fine to start with. See [Priority scheduling](/guide/scheduling#priority-scheduling) for details.
4. Select **Confirm**.

Imported articles are due for review right away.

## 5. Do your first review session

1. Select the **Incremental reading** icon (an open book) in the left ribbon, or run **Incremental Reading: Learn**.
2. Select **Begin Review**. The first due item opens.
3. Read as much as you like. When you find a passage worth keeping, select it and run **Extract selection to snippet**.
4. When you're ready to move on, select **Mark reviewed** (the green check mark). Don't worry about losing your place: the article will come back.
5. Keep going until the queue is empty or you run out of time.

Snippets you create come up for review the next day. When a snippet is short and clear enough, [turn it into a card](/guide/review-sessions#make-cards).

> [!TIP]
> Set aside some time for a session each day. Even 10 minutes is enough to make steady progress.

## Next steps

- [Review sessions](/guide/review-sessions): revising snippets, making cards, and grading.
- [Importing material](/guide/importing): web pages, PDFs, videos, and notes on paper.
- [Feature overview](/features): what the plugin does and how it fits together.
