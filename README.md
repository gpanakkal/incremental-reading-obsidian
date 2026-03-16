# Obsidian Incremental Reading
> [!NOTE]
> This plugin is in early development. Expect bugs and feature limitations (see [Known Limitations](#known-limitations-and-issues)).

This is a plugin for [Obsidian](https://obsidian.md) that enables incremental reading, a powerful, low-friction workflow for learning from texts. 

It combines spaced repetition (using [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)) and a priority-based queuing system to allow users to:
- Easily build understanding through a divide-and-conquer approach that provides repeated exposures to learning material.
- Learn several subjects in parallel without having to manually schedule and keep track of their progress.
- Retain what they've learned indefinitely with spaced repetition cards.

Since this is integrated directly into Obsidian, your learning materials, snippets, and cards live alongside or even within your notes, making it convenient to work with all kinds of information.

See [Technical Details](#technical-details) for key terminology and details on how the incremental reading process works in this plugin.

## Setup
> [!IMPORTANT]
> This plugin supports Obsidian Sync, but make sure to enable "sync all other types" on each device **before** installing the plugin.
> Sync may overwrite the plugin's database if you install the plugin first.
>
> You can easily recover the database if this happens: go to the Files pane, right click on `incremental-reading/ir-user-data.sqlite`, and select `Open version history`.

[Install via BRAT](https://tfthacker.com/brat-quick-guide#Adding+a+beta+plugin).

## Using the plugin
1. Import some learning material into an Obsidian note. See [Third-Party Tools](#third-party-tools) for HTML/PDF conversion.
2. Run `Import article` from the command palette to add the entire note to your study queue. Set a lower priority (e.g., 1.5) if you want to review it frequently. See [Priorities](#priorities) for more details.
> [!TIP]
> You can also import notes from the editor context menu (three dots in the top right corner), or by right-clicking on the note in the Files tab and selecting `Import article`.
3. Set aside some time for a [study session](#study-sessions) each day, depending on how much you want to learn. Even 10 minutes is fine!
> [!TIP]
> Bind hotkeys for the `Extract selection` and `Create SRS card` commands, as these are frequently used in incremental reading.

### Study Sessions
Once you've imported some material, begin a study session by clicking the `Incremental Reading` button in the left ribbon (or `Incremental Reading: Learn` from the command palette).
1. The first item in the queue will be shown to you. Read as much as you like, extracting interesting/important passages to snippets as you go.
2. Press `Continue` when you want to move on to the next item in the queue. Don't worry about losing track of the current item; it will be shown to you again in the future.
> [!TIP]
> If you don't want to see an item again, press `Dismiss` instead.
3. Cards you've made will show up in review on subsequent days. Mentally fill in the blank or answer the question, then click "Show Answer". Grade yourself per [these criteria](#grading-cards).
> [!WARNING]
> For spaced repetition to work properly, make sure you're actually attempting to recall the answer before revealing it.

#### Revising snippets
As you build understanding, you may find the phrasing of a snippet can be improved by revising wording, removing fluff, etc. This is a key step in incremental reading.
> [!TIP]
> Don't force this. Wait until it's obvious what changes you want to make, and limit yourself to one simple revision per repetition.

#### Making cards
Once a snippet has been sufficiently trimmed down and revised, it's ready to be turned into one or more spaced repetition cards. 
- Currently, all cards are created as fill-in-the-blank questions from text blocks - just select the part of the text that you want to be the answer, and run `Create SRS card`.
- The entire paragraph or bullet point containing the selected text will be extracted to the card. Add newlines and split bullets up as needed to avoid including extra text.
- Ideally, each card will be one or two brief sentences, with only one correct answer. The shorter the better, as long as it remains unambiguous how to answer the question.

> [!NOTE]
> Cards should have a unique prompt and ideally have only one answer.

#### Grading cards
After showing the answer for a card, you'll have four grading options to choose from.

Choose:
- **Easy** if you recalled the correct answer immediately
- **Good** if the correct answer came to you fairly quickly, but not effortlessly
- **Hard** if you were able to recall roughly the correct answer, but it took time and effort
- **Again** if you didn't recall the answer

### Other Workflows
Snippets and cards can be created from any note, so don't feel limited to only doing this during study sessions. 
This is especially handy for:
- notes that only have one passage you want to learn from, which you can extract into a snippet directly instead of importing the whole note.
- notes that are well-structured for immediate conversion into cards, such as bullet lists of atomic, self-contained information.

### More Guides
- [A short guide to incremental reading](https://www.supermemo.wiki/en/learning/incremental-reading)
- [20 rules of knowledge formulation](https://supermemo.guru/wiki/20_rules_of_knowledge_formulation) (for making good cards)
- [The complete (and long) guide to incremental reading in SuperMemo](https://help.supermemo.org/wiki/Incremental_reading)

## Known Limitations and Issues
- Importing and making snippets only works on Markdown files. Web page and PDF importing are planned features; in the meantime, there are third-party tools to convert these into markdown - see [Third-Party Tools](#third-party-tools).
- Manual scheduling of reviews is not yet implemented. For now, set priority to `1` if you wish to keep the time between reviews from increasing.

## Third-Party Tools
- [Obsidian Web Clipper](https://obsidian.md/clipper) (this is also built into Obsidian's web viewer; just click the overflow menu in the top right and select `Save to vault`)
- [MarkDownload browser extension](https://github.com/deathau/markdownload) - this works better than the Obsidian clipper on some websites
- [Marker](https://github.com/datalab-to/marker) for PDF conversion

## Technical Details
### Terminology
SRS stands for **Spaced Repetition System**.

Full texts you've imported are **articles**.

Sections of text that you have extracted are **snippets**.

**Cards** are question & answer notes. 

Articles, snippets, and cards are collectively called **items**.

**Sources** are notes that an article was imported from. If a snippet or card is made from a note that is not an item, that note becomes a source as well.

The article/snippet that a snippet or card is made from is its **parent**.

Information that is **self-contained** is understandable by itself. This is vital for cards, which must have a unique and clear prompt.

Information that is **atomic** cannot be simplified without loss of meaning. Cards should be as atomic as possible. See [atomic memory](https://supermemo.guru/wiki/Atomic_memory).

### How IR works in this plugin
During study sessions, articles, snippets, and cards that are due will be presented to you, interleaved with each other.

The spaced repetition algorithm is only used to schedule cards. Articles and snippets use the [priority](#priorities) system instead.

Imported articles are due immediately. New snippets are scheduled to be reviewed in one day.

When making a card, its content will be [embedded](https://help.obsidian.md/embeds) into its original location, so it can still be useful within its original note.

#### Priorities
Articles and snippets have priorities ranging from `1` to `5`, where `1` is the highest. 

Priorities are used to determine how often material is shown to you; a snippet with priority `1` will be shown daily with very little growth in the time interval between reviews, while at priority `5`, each review interval will be ~1.6 times longer than the last.

Prioritizing may feel unintuitive initially. Just remember that priority 1 roughly means "review every day", and try to prioritize relative to other items.
> [!TIP]
> Use decimal priorities for more fine-grained control. For convenience, you can simply enter a two digit number from 10 to 50. The decimal point will be inserted automatically.

### Plugin Data
To avoid side effects, this plugin (mostly) does not modify files outside its data folder. 
- The only exception is that it adds a source tag to note frontmatter when you make snippets from them.

Plugin data (items and the SQLite database) is stored in the incremental-reading/ directory.

Importing a note as an article makes a copy inside the plugin data folder. Feel free to delete the original note if it's no longer needed.

When you make a snippet or card, a new note is created in the plugin data folder to hold its content.

The SQLite database stores scheduling data, FSRS parameters for cards, and repetition history.
