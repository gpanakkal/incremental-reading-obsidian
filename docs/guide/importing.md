# Importing material

The plugin works with Markdown notes. To learn from something, get it into a note first, then import that note as an article.

## Import a note as an article

Open the note and run **Incremental Reading: Import article** from the command palette. You can also:

- Right-click the note in the file explorer (on mobile, tap and hold) and select **Import article**.
- Open the note's **⋮** menu in the upper-right corner and select **Import article**.

Imported articles are due for review right away.

### Import options

By default, a dialog appears when you import, with two choices:

- **Priority scheduling** or **Fixed intervals.** Pick how the article is scheduled and set its priority (1 to 5) or interval (1 to 30 days). See [Scheduling](/guide/scheduling).
- **Import in place** or **Make a copy.**
  - **Import in place** (the default) leaves the note where it is and adds two properties to its frontmatter: an `ir-article` tag and an `ir-id`.
  - **Make a copy** copies the note into the `incremental-reading/articles/` folder and leaves the original unchanged.

To skip the dialog and always use your defaults, turn off **Show article import dialog** in [settings](/reference/settings#imports). The defaults are set by **Default article priority** and **Copy articles when importing**.

> [!TIP]
> Want to switch between the dialog and quick imports without changing settings? Turn on **Enable extra import hotkeys** to get the commands **Quick import**, **Open import dialog...**, **Import article as copy**, and **Import article in place**. See [Commands](/reference/commands#extra-import-commands).

### Start from an empty article

Run **Create empty article** to make a new, blank article that's already in your queue. It's created in the current folder, or in `incremental-reading/articles/` if you turn off **Create empty articles in the current folder**.

## Web pages

[Obsidian Web Clipper](https://obsidian.md/clipper) is a browser extension made by the Obsidian team. It saves web pages to your vault as Markdown.

1. Install Web Clipper for your browser and connect it to your vault.
2. On the page you want to read, open Web Clipper and save the page.
3. In Obsidian, open the new note and run **Import article**.

Obsidian's built-in web viewer can save pages too: open the **⋮** menu in the upper-right corner and select **Save to vault**.

If Web Clipper doesn't do a good job on a particular site, try the [MarkDownload](https://github.com/deathau/markdownload) browser extension.

## PDFs

The plugin can't import PDFs directly yet. Convert them to Markdown first. [Marker](https://github.com/datalab-to/marker) does a good job, including with tables and equations.

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
- **If you're away from your computer**, take notes on paper. Later, photograph them, convert them to text with OCR (optical character recognition), and paste the text into an empty article.
