# Incremental Reading

This is a plugin for [Obsidian](https://obsidian.md) that enables incremental reading, a powerful, low-friction workflow for learning from texts. It combines spaced repetition (using [FSRS](https://github.com/open-spaced-repetition/free-spaced-repetition-scheduler)) and a priority-based queuing system to allow users to:
- Easily build understanding through a divide-and-conquer approach that provides repeated exposures to learning material.
- Learn on several parallel tracks without having to keep track of everything manually.
- Retain what they've learned indefinitely.

Additionally, since this is integrated directly into Obsidian, your learning materials, snippets, and flash cards live alongside or even within your notes, making it much more convenient to work with all kinds of information.

## Setup
1. [Install via BRAT](https://tfthacker.com/brat-quick-guide#Adding+a+beta+plugin).
2. (Optional but recommended) Create hotkeys for the `Extract selection` and `Create SRS card` commands.

## Using the plugin
1. Import some learning material into an Obsidian note
2. If you already know what specific information you want to learn, highlight those sections and extract them using `Extract selection`. Otherwise, select the entire note and extract it.
3. Set aside some time for a study session each day, depending on how much you want to learn. Even 10 minutes is fine!

### Study Sessions
1. Begin a study session by clicking the `Incremental Reading` button in the left ribbon, or by running `Learn` from the command palette.
2. Full texts and snippets that you have previously extracted will be presented to you. Read as much as you like, extracting interesting snippets as you go. 
    - These snippets also enter your review queue and will be shown to you in the future.
3. Press `Continue` when you want to move on to the next item in the queue - don't worry about losing track of the current text/snippet; it will be shown to you again in the future
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
Snippets have priorities ranging from `1` to `5`, where `1` is the highest. Priorities are used to determine how often material is shown to you; a snippet with priority `1` will be shown daily with very little growth in the time interval between reviews, while at priority `5`, each review interval will be ~1.6 times longer than the last.

For more fine-grained control of priorities, a single decimal place is allowed.

### More Guides
- [A short guide to incremental reading](https://www.supermemo.wiki/en/learning/incremental-reading)
- [20 rules of knowledge formulation](https://supermemo.guru/wiki/20_rules_of_knowledge_formulation) (for making good cards)
- [The complete (and long) guide to incremental reading in SuperMemo](https://help.supermemo.org/wiki/Incremental_reading)

## Known Limitations and Issues
- Texts cannot yet be imported as articles. For now, work around this by selecting the entire text and making a snippet.
- Extracting snippets only works on markdown notes. Web page and PDF importing is planned; in the meantime, there are many tools that convert these to markdown:
  - [Obsidian Web Clipper](https://obsidian.md/clipper) (this is also built into Obsidian's web viewer - just click the overflow menu in the top right and select `Save to vault`)
  - [MarkDownload browser extension](https://github.com/deathau/markdownload)
  - [Marker](https://github.com/datalab-to/marker) for PDFs
- When opening a snippet or card and directly editing the note, the changes will not be reflected in the review interface if that snippet/card is currently open in it. I recommend making edits directly from the review interface to avoid this issue.
- Manual scheduling of text/snippet reviews is planned. For now, set priority to `1` if you wish to keep review intervals steady.