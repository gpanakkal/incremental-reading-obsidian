<script setup>
import { VPButton } from 'vitepress/theme';
</script>

# Quick start

From installing the plugin to finishing your first review session, all in a few minutes.

## Installation

<VPButton text="Install in Obsidian" href="obsidian://show-plugin?id=incremental-reading" target="_self" />

If the button doesn't work: Go to **Settings → Community plugins** in Obsidian. Enable community plugins if you haven't already, select **Browse**, search for "Incremental Reading", and install and enable it.

## Configuring Obsidian Sync

Skip this step if you don't use [Obsidian Sync](https://obsidian.md/sync).

The plugin stores scheduling and review data in a database file, and Sync ignores that file type by default. On **every** device, go to **Settings → Sync** and turn on **Sync all other types**.

## Hotkey setup

Optional, but recommended.

Go to **Settings → Hotkeys**, search for "Incremental Reading", and assign keys to:

- **Extract selection to snippet** (suggested: <kbd>Alt</kbd>+<kbd>X</kbd>)
- **Create spaced repetition card** (suggested: <kbd>Alt</kbd>+<kbd>Z</kbd>)

Note: Replace **Alt** with **Option** on Mac.
See [Recommended hotkeys](/reference/commands#recommended-hotkeys) for more.

## Importing learning material

1. From the Files view, Right-click the files you want to import in the Files view and select **Import article** (or **Import items...**, if you have multiple selected). Currently, only notes and PDFs are supported. See [importing material](/guide/importing) for how to handle webpages, videos, and more.
2. A dialog will appear with options for customizing the import. For now, simply select **Confirm**. See [scheduling](/guide/scheduling) for more info.

## Learning

1. Select the **Incremental reading** icon in the left ribbon, or run the **Incremental Reading: Learn** command.
2. Select **Begin Review**. This will open the first due item.
3. Read as much as you like. When you find a passage you want to revisit, select it and run **Extract selection to snippet** or click on the scissors icon on the action bar.
4. When you're ready to move on, select **Mark reviewed** (the green check mark). Don't worry about losing your place: the article will come back soon.
5. Repeat for the next item.

> [!TIP]
> For best results, set aside some time for a session each day. Even 10 minutes is enough to make steady progress.

## Next steps

- [Importing material](/guide/importing): bulk imports from the vault, automatic imports, and more.
- [Review sessions](/guide/review-sessions): revising snippets, making cards, and grading.
