# Obsidian Incremental Reading

> [!NOTE]
> This plugin is in early development. The core feature set is implemented, but expect bugs and feature limitations (see [Known limitations](#known-limitations-and-issues)).

This is a plugin for [Obsidian](https://obsidian.md) that enables incremental reading, a powerful, low-friction workflow for learning from texts.

It combines spaced repetition (using [FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm)) and a priority-based queuing system to allow users to:

- Easily build understanding through a divide-and-conquer approach that provides repeated exposures to learning material.
- Learn several subjects in parallel without having to manually schedule and keep track of their progress.
- Retain what they've learned indefinitely with spaced repetition cards.

Since this is integrated directly into Obsidian, your learning materials, snippets, and cards live alongside or even within your notes, making it convenient to work with all kinds of information.

For technical details, see [terminology](#terminology) and [how the incremental reading works in this plugin](#how-incremental-reading-works-in-this-plugin).

## Setup

### 1. Install and enable BRAT

Go to **Settings → Community plugins** → turn on community plugins (if you haven't already) → **Browse** → search for BRAT.

### 2. Install Incremental Reading

In the installed plugins list, open BRAT's settings → **Add beta plugin** → paste the link: https://github.com/gpanakkal/incremental-reading-obsidian → select "Latest version" in the dropdown, and confirm.

### 3. Configure Obsidian Sync

If you don't use Sync, skip this step.

Go to **Settings → Sync** → enable **Sync all other types**. Repeat this on each device.

> [!warning]
> Sync will overwrite the plugin's database if you use the plugin on a second device before enabling **Sync all other types**.
>
> You can easily recover the database if this happens: open the Files pane → find `incremental-reading/ir-user-data` and right-click (on mobile, tap and hold until it lights up) → select **Open version history** → select the newest version from your first device → select **Restore**.

## Use the plugin

1. Import learning material into an Obsidian note. See [Third-party tools](#third-party-tools) for HTML/PDF conversion.
2. Run **Import article** from the command palette to add the entire note to your study queue. Set a lower priority (for example, 1.5) if you want to review it frequently. See [Priority scheduling](#priority-scheduling) for more details.

> [!tip]
> You can also import notes from the editor context menu (three dots in the upper-right corner), or by right-clicking on the note in the Files tab and selecting **Import article**.

3. Set aside some time for a [study session](#study-sessions) each day, depending on how much you want to learn. Even 10 minutes is fine!

> [!tip]
> Set up keyboard shortcuts for the **Extract selection** and **Create spaced repetition card** commands, as these are frequently used in incremental reading.

### Study sessions

Once you've imported some material, begin a study session by selecting the **Incremental reading** button in the left ribbon (or perform **Incremental Reading: Learn** from the command palette).

1. The first item in the queue will be shown to you. Read as much as you like, extracting interesting or important passages to snippets as you go.
2. Select **Mark as reviewed** when you want to move on to the next item. Don't worry about losing track of the active item; it will be shown to you again in the future.

> [!tip]
> If you don't want to see an item again, select **Dismiss from future review** instead.

3. Cards you've made will appear in review on subsequent days. Mentally fill in the blank or answer the question, then show the answer. Grade yourself per [these criteria](#grading-cards).

> [!warning]
> For spaced repetition to work properly, make sure you're actually attempting to recall the answer before revealing it.

#### Revise snippets

You may find the phrasing of a snippet can be improved by revising wording, removing fluff, etc. This is a key step in incremental reading.

> [!tip]
> Wait until it's obvious what changes you want to make, and limit yourself to one simple revision per repetition.

#### Make cards

Once a snippet has been sufficiently trimmed down and revised, it's ready to be turned into one or more spaced repetition cards.

- Cards are created as fill-in-the-blank questions from text blocks — just select the part of the text that you want to be the answer, and run **Create spaced repetition card**.
- The entire paragraph or list item containing the selected text will be extracted to the card. Split paragraphs or list items up as needed to avoid including extra text.
- Cards should ideally be one or two sentences and have only one correct answer. The shorter the better, as long as it remains clear how to answer them.

#### Grade cards

After showing the answer for a card, you'll have four grading options to choose from.

Choose:

- **Easy** if you recalled the correct answer immediately
- **Good** if the correct answer came to you fairly quickly, but not effortlessly
- **Hard** if you were able to recall roughly the correct answer, but it took time and effort
- **Again** if you didn't recall the answer

### Other workflows

Snippets and cards can be created from any note, so don't feel limited to only doing this during study sessions.

This is especially handy for:

- Notes that only have one passage you want to learn from, which you can extract into a snippet directly instead of importing the whole note.
- Notes that are well-structured for direct conversion into cards, such as lists of atomic, self-contained information.

### More guides

- [A short guide to incremental reading](https://www.supermemo.wiki/en/learning/incremental-reading)
- How to make good cards: [20 rules of knowledge formulation](https://supermemo.guru/wiki/20_rules_of_knowledge_formulation)
- [The complete (and long) guide to incremental reading in SuperMemo](https://help.supermemo.org/wiki/Incremental_reading)

## Known limitations and issues

- Creating snippets and cards on partial code blocks, blockquotes, LaTeX, and other types of special formatting can break the formatting. It is recommended to include the entire formatted section (such as the entire code block) when making the snippet or card, and then editing it afterwards as desired.
- Importing, making snippets, and making cards only works on Markdown notes. Web page and PDF support is planned, but in the meantime, check out the suggested [third-party tools](#third-party-tools) to convert these into Markdown.

## Third-party tools

- [Obsidian Web Clipper](https://obsidian.md/clipper) — a browser extension to save webpages to your vault, from the Obsidian team. This is also built into Obsidian's web viewer; just select the overflow menu in the upper-right corner and select **Save to vault**.
- [MarkDownload browser extension](https://github.com/deathau/markdownload) — works better than Obsidian Web Clipper on some websites.
- [Marker](https://github.com/datalab-to/marker) — for PDF conversion.

## Terminology

- **SRS** — stands for Spaced Repetition System.
- **Review** — includes both your first exposure to learning material and subsequent re-visits.
- **Article** — a full text you've imported.
- **Snippet** — a section of text you have extracted.
- **Card** — a question and answer entry that is scheduled using the spaced repetition algorithm.
- **Item** — an article, snippet, or card.
- **Source** — an external note that (1) an article was imported from, or (2) a snippet or card was made from.
- **Parent** — the item that a snippet or card is made from.
- **Self-contained** — understandable by itself. This is vital for cards, which must have a unique and clear prompt for the spaced repetition algorithm to work as expected.
- **Atomic** — cannot be simplified without loss of meaning. Cards should be as atomic as possible. See [atomic memory](https://supermemo.guru/wiki/Atomic_memory).

## How incremental reading works in this plugin

During study sessions, articles, snippets, and cards that are due will be presented to you, interleaved with each other.

Imported articles are due immediately. New snippets are scheduled to be reviewed in one day.

When making a card, its content will be [embedded](https://help.obsidian.md/embeds) into its original location, so it can still be useful within its original note.

Cards are scheduled using the [FSRS algorithm](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm).

There are two scheduling methods available for articles and snippets: [priority-based scheduling](#priority-scheduling) and [fixed-interval scheduling](#fixed-interval-scheduling).

The default priority-based system is generally recommended, but fixed intervals can work better for long texts (like if you import an entire book as a single "article") or if you're studying for a deadline less than 3–4 weeks out.

### Priority scheduling

In this approach, items are scheduled for review using intervals that lengthen on each review, starting from one day. Priorities control how quickly these intervals grow.

Priorities range from **1** to **5**, where **1** means intervals grow extremely slowly, while **5** means each interval will be approximately 1.6 times the length of the previous one.

> [!tip]
> Use decimal priorities for fine-grained control. You can simply enter a two-digit number from 10 to 50. The decimal point will be inserted automatically.

Reducing priority will not make future intervals shorter; it only slows the growth.

Don't worry if setting priorities feels unintuitive at first. You'll develop a feel for it with practice.

### Fixed-interval scheduling

Articles can be configured to be reviewed on a fixed interval (e.g., daily or weekly) instead of using the priority system. Use the **Manage item scheduling** command to change the scheduling method.

### Plugin data

To avoid side effects, this plugin does not modify files outside its data folder, with one exception: it adds a source tag to note frontmatter when you make snippets from them.

Plugin data (items and the SQLite database) is stored in the `incremental-reading/` folder.

Importing a note as an article makes a copy inside the plugin data folder. Feel free to delete the original note if it's no longer needed.

When you make a snippet or card, a new note is created in the plugin data folder to hold its content.

The SQLite database stores scheduling data, FSRS parameters for cards, and repetition history.
