# Importing material

The plugin imports Markdown notes and PDFs from your vault as articles, and web pages straight from Obsidian's web viewer. Bring your learning material into Obsidian in one of those forms, then import it. Material that can't be imported, like a video or a printed book, goes into an [empty article](#start-from-an-empty-article) that you take notes in.

## Import a note or PDF as an article {#import-a-note-as-an-article}

Open the note or PDF and run **Incremental Reading: Import article** from the command palette. You can also:

- Right-click the file in the Files view (on mobile, tap and hold) and select **Import article**.
- Open the file's **⋮** menu in the upper-right corner and select **Import article**.

Imported articles are due for review right away.

A note becomes an article through two properties added to its frontmatter: an `ir-article` tag and an `ir-id`. A PDF has no frontmatter, so nothing is written to it. The plugin tracks it by its path instead. See [Plugin data](/reference/plugin-data#changes-to-your-notes).

> [!NOTE]
> Move or rename a PDF article while Obsidian is open, so the plugin can follow it. If a PDF is moved while Obsidian is closed, the plugin loses track of it, along with the highlights of any snippets and cards made from it.

### Import options

By default, a dialog appears when you import, with two choices:

- **Priority scheduling** or **Fixed intervals.** Pick how the article is scheduled and set its priority (1 to 5) or interval (1 to 30 days). See [Scheduling](/guide/scheduling).
- **Import in place** or **Make a copy.**
  - **Import in place** (the default) leaves the file where it is.
  - **Make a copy** copies the note or PDF into the `incremental-reading/articles/` folder and leaves the original unchanged.

To skip the dialog and always use your defaults, turn off **Show article import dialog** in [settings](/reference/settings#imports). The defaults are set by **Default article priority** and **Copy articles when importing**.

Imported by mistake? Select **Undo** on the notice that confirms the import, or run **Undo last action**.

> [!TIP]
> Want to switch between the dialog and quick imports without changing settings? Turn on **Enable extra import hotkeys** to get the commands **Quick import**, **Open import dialog...**, **Import article as copy**, and **Import article in place**. See [Commands](/reference/commands#extra-import-commands).

## Import many files at once

The bulk import dialog imports any number of notes and PDFs with the same options. There are three ways to open it:

- **From a selection in the Files view.** Select several files or folders, right-click one of them, and select **Import N items…**, where N is how many you selected. Shift-click selects a range of files, and Alt-click (Option-click on Mac) adds or removes one file at a time.
- **From a folder.** Right-click a folder in the Files view and select **Import from folder…**. The dialog lists the files directly inside it.
- **From the review tab.** Select **Bulk import from vault** on the home screen, or run **Incremental Reading: Bulk import…**. A filter bar at the top of the dialog lets you choose files by **Folder**, by **Tags** (in frontmatter or the note body, as Obsidian's tag search finds them), or by **Search**, which takes the same queries as Obsidian's **Search in all files**.

Wherever the list comes from a folder, turn on **Include subfolders** to list files at any depth.

Every note and PDF that can be imported is listed and ticked. Untick anything you don't want. Folders in the list have a checkbox of their own that ticks or unticks everything under them. Files that are already articles, snippets, or cards are left out, and so is anything in the plugin's data folder.

The scheduling and copy options above the list apply to every ticked file. Select **Import** to finish. A notice says how many files were imported and lists any that couldn't be.

To reverse a bulk import right away, run **Undo last action**. Later on, [un-import](#un-import-articles) the articles instead.

## Automatic imports

The plugin can import files for you as they arrive, so clipping a page or dropping a PDF into a folder is all it takes to add it to your queue. Automatic imports are always in place, at the **Default article priority**.

### By tag

This is on by default. Add the `ir-import` tag to a note's frontmatter, and the note is imported as soon as the tag is saved. It makes no difference how the tag gets there: typed into the properties, written by a Web Clipper template, or synced from another device. The tag stays on the note after the import.

To use other tags, add them to **Trigger tags** in [settings](/reference/settings#imports). For example, Obsidian Web Clipper tags saved pages with `clippings` by default, so adding `clippings` as a trigger tag imports every page you clip. To turn this off, turn off **Auto-import notes by tag**.

Only frontmatter tags count. Tags in the note body are ignored. A note that already carries a tag when you add it to the trigger list is left alone until the note next changes, so to import those, use the **Tags** filter of the [bulk import dialog](#import-many-files-at-once).

### By folder

Turn on **Auto-import files added to folders** in [settings](/reference/settings#imports) and add one or more **Watched folders**. Any note or PDF that is created in, moved into, or synced into a watched folder or one of its subfolders is imported.

Only new arrivals count. Files that were already in the folder when you started watching it aren't imported. Use **Import from folder…** for those. The vault root and the plugin's own data folder can't be watched.

### While Obsidian is closed or syncing

Both kinds of automatic import catch up when Obsidian starts, so tags added and files moved while it was closed are imported then.

While Obsidian Sync is syncing, automatic imports wait for it to finish, so that a note un-imported on another device isn't imported again here. If Sync is paused, offline, or stuck for a long time, the plugin offers to import anyway.

## Un-import articles

Un-importing turns an article back into a plain file. The `ir-article` tag, the `ir-id`, and any trigger tags are removed from a note, and the article's review history is deleted. This can't be undone. Snippets and cards made from the article are kept.

- Right-click an article in the Files view, or open its **⋮** menu, and select **Un-import article**.
- Right-click a folder and select **Un-import from folder…**, or right-click a selection of files and select **Un-import N items…**. Both open a dialog like the bulk import one, listing the articles found.
- On the review tab's home screen, open the **⋮** menu and select **Bulk un-import…** to choose articles by folder, tag, or search.

To take an article out of your queue but keep its review history, [dismiss it](/guide/review-sessions#skip-or-dismiss-an-item) instead.

## Start from an empty article

Run **Create empty article** to make a new, blank article that's already in your queue. It's created in the current folder, or in `incremental-reading/articles/` if you turn off **Create empty articles in the current folder**.

## Web pages

There are two ways to get a web page into your queue.

**From Obsidian's web viewer** (desktop only). Open the page in the [web viewer](https://help.obsidian.md/plugins/web-viewer), then run **Import article** or select it from the tab's **⋮** menu. The page is converted to Markdown the same way the viewer's own **Save to vault** does, and saved as a new note in `incremental-reading/articles/`.

**From your browser.** [Obsidian Web Clipper](https://obsidian.md/clipper) is a browser extension made by the Obsidian team. It saves web pages to your vault as Markdown.

1. Install Web Clipper for your browser and connect it to your vault.
2. On the page you want to read, open Web Clipper and save the page.
3. In Obsidian, open the new note and run **Import article**. Or skip this step for good by adding `clippings` to your [trigger tags](#by-tag), so every clipped page imports itself.

If Web Clipper doesn't do a good job on a particular site, try the [MarkDownload](https://github.com/deathau/markdownload) browser extension.

## PDFs

Put the PDF in your vault and import it like a note: open it and run **Import article**, or right-click it in the Files view. PDFs can be [bulk imported](#import-many-files-at-once) and [auto-imported from watched folders](#by-folder) too.

In review, the PDF opens in Obsidian's PDF viewer. Select text on the page to extract snippets and make cards, just as in a note. See [Reading PDFs](/guide/review-sessions#reading-pdfs).

Keep in mind:

- A scanned PDF has no text to select, so nothing can be made from it. Run it through OCR (optical character recognition) first, or convert it to Markdown.
- A passage that runs onto the next page is highlighted only up to the end of its first page.
- Invisible characters in the PDF's text, such as soft hyphens, are left out of snippets and cards.

If you'd rather edit the text as you read, convert the PDF to Markdown first and import the note. [Marker](https://github.com/datalab-to/marker) does a good job, including with tables and equations.

## Videos

Video support is on the roadmap. For now:

1. Run **Create empty article**.
2. Add the video to the article as an embedded link, which is a Markdown link with `!` in front:

   ```md
   ![Talk title](https://www.youtube.com/watch?v=...)
   ```

3. Take notes underneath the video as you watch, and extract snippets from those notes.

> [!TIP]
> The [Auto Link Title](https://github.com/zolrath/obsidian-auto-link-title) plugin fetches a page's title for you when you paste a URL, which makes this quicker.

## When you can't import

Some material can't be imported, like a printed book, a lecture, or a paywalled page. You can still get it into your queue:

- **If you're at your computer**, run **Create empty article** and take notes in it as you go. The notes become the article.
- **If you're away from your computer**, take notes on paper. Later, photograph them, convert them to text with OCR, and paste the text into an empty article.
