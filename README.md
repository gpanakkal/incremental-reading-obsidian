# Incremental Reading
⚠ This plugin is in early development. Expect bugs and feature limitations (see [Known Limitations](#known-limitations-and-issues)). ⚠

This is a plugin for [Obsidian](https://obsidian.md) that enables incremental reading, a powerful, low-friction workflow for learning from texts. It combines spaced repetition (using [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)) and a priority-based queuing system to allow users to:
- Easily build understanding through a divide-and-conquer approach that provides repeated exposures to learning material.
- Learn on several parallel tracks without having to keep track of everything manually.
- Retain what they've learned indefinitely.

Since this is integrated directly into Obsidian, your learning materials, snippets, and flash cards live alongside or even within your notes, making it convenient to work with all kinds of information.

## Setup
[Install via BRAT](https://tfthacker.com/brat-quick-guide#Adding+a+beta+plugin).

### Optional, but recommended
- Create hotkeys for the `Extract selection` and `Create SRS card` commands.
- If using Obsidian Sync, enable "sync all other types". 
    - You can still use sync if you don't want to enable this, but you'll have to reload the vault to see new changes made on another device.


## Using the plugin
1. Import some learning material into an Obsidian note. See [Third Party Tools](#third-party-tools) for HTML/PDF conversion.
2. Run `Import article` to add the entire note to your study queue. Set a lower priority (e.g., 1.5) if you want to review it frequently. See [Priorities](#priorities) for more details.
    - If you already know which portions of the text you want to learn from, you can instead highlight those sections and run `Extract selection`.
3. Set aside some time for a study session each day, depending on how much you want to learn. Even 10 minutes is fine!

### Study Sessions
1. Begin a study session by clicking the `Incremental Reading` button in the left ribbon, or by running `Learn` from the command palette.
2. Full texts and snippets that you have previously extracted will be presented to you. Read as much as you like, extracting interesting snippets as you go. 
    - These snippets also enter your review queue and will be shown to you in the future.
3. Press `Continue` when you want to move on to the next item in the queue. Don't worry about losing track of the current text/snippet; it will be shown to you again in the future
    - If you're done with an item and don't want to see it again, press `Dismiss` instead.
4. As you build understanding, you may find the phrasing of a snippet can be improved by revising wording, removing fluff, etc. This is a key step in incremental reading, so feel free to do this.
    - The review interface supports editing just like a regular note.
    - Don't force this, however. It's generally best to limit yourself to one revision per repetition.
5. Once a snippet has been sufficiently trimmed down and revised, it's ready to be turned into one or more spaced repetition cards. Currently, all cards are created as fill-in-the-blank questions from text blocks - just select the part of the text that you want to be the answer, and run `Create SRS card`.
    - The entire paragraph or bullet point containing the selected text will be extracted to the card. Add newlines and split bullets up as needed to avoid including extra text.
    - Cards will also be shown to you in future study sessions, interleaved with snippets.
    - Ideally, each card will be one or two brief sentences, with only one correct answer. The shorter the better, as long as it remains unambiguous how to answer the question.

### Other Workflows
Snippets and cards can be created from any note, so don't feel limited to only doing this during incremental reading sessions. This is especially handy for notes that are already well-structured for conversion into cards, such as bullet lists of atomic information. The card's content will be [embedded](https://help.obsidian.md/embeds) into its original location, so it can perform double duty.

### Priorities
Articles and snippets have priorities ranging from `1` to `5`, where `1` is the highest. Priorities are used to determine how often material is shown to you; a snippet with priority `1` will be shown daily with very little growth in the time interval between reviews, while at priority `5`, each review interval will be ~1.6 times longer than the last.

Use decimal values for more fine-grained control of priorities (these are limited to a single decimal place).

### More Guides
- [A short guide to incremental reading](https://www.supermemo.wiki/en/learning/incremental-reading)
- [20 rules of knowledge formulation](https://supermemo.guru/wiki/20_rules_of_knowledge_formulation) (for making good cards)
- [The complete (and long) guide to incremental reading in SuperMemo](https://help.supermemo.org/wiki/Incremental_reading)

## Known Limitations and Issues
- Extracting snippets only works on markdown notes. Web page and PDF importing are planned features; in the meantime, there are third-party tools to convert these into markdown - see [Third-Party Tools](#third-party-tools).
- If you open the note for an article, snippet, or card in another tab while it's also open in the review interface, edits made to the note will not be reflected in the review interface until the next time it's loaded. I recommend making edits directly from the review interface to avoid this issue.
- Manual scheduling of reviews will be implemented in the future. For now, set priority to `1` if you wish to keep review intervals steady.

## Third-Party Tools
- [Obsidian Web Clipper](https://obsidian.md/clipper) (this is also built into Obsidian's web viewer; just click the overflow menu in the top right and select `Save to vault`)
- [MarkDownload browser extension](https://github.com/deathau/markdownload) - this works better than the Obsidian clipper on some websites
- [Marker](https://github.com/datalab-to/marker) for PDF conversion