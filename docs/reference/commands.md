# Commands and hotkeys

Run any of these from the command palette. They all start with **Incremental Reading:**. The plugin doesn't set any hotkeys for you. Assign them in **Settings → Hotkeys** (search for "Incremental Reading").

## Recommended hotkeys

These are the shortcuts the plugin was designed around. They use <kbd>Alt</kbd> to avoid clashing with Obsidian's defaults, but any keys you like will work.

| Command | Suggested hotkey |
|---|---|
| Extract selection to snippet | <kbd>Alt</kbd>+<kbd>X</kbd> |
| Create spaced repetition card | <kbd>Alt</kbd>+<kbd>Z</kbd> |
| Review: show answer/mark reviewed | <kbd>Alt</kbd>+<kbd>A</kbd> |
| Review: skip for current session | <kbd>Alt</kbd>+<kbd>S</kbd> |
| Review: dismiss from future review | <kbd>Alt</kbd>+<kbd>D</kbd> |
| Review: un-dismiss | <kbd>Alt</kbd>+<kbd>D</kbd> |
| Review: grade card 1 (again) | <kbd>Alt</kbd>+<kbd>1</kbd> |
| Review: grade card 2 (hard) | <kbd>Alt</kbd>+<kbd>2</kbd> |
| Review: grade card 3 (good) | <kbd>Alt</kbd>+<kbd>3</kbd> |
| Review: grade card 4 (easy) | <kbd>Alt</kbd>+<kbd>4</kbd> |

Dismiss and un-dismiss can share a key because only one of them is available at a time.

If you only set up two, pick **Extract selection to snippet** and **Create spaced repetition card**.

## General commands

These work anywhere.

### Learn

Opens the review tab. If the review tab is already focused, switches between the home screen and the current item. The **Incremental reading** ribbon icon does the same thing.

### Import article

Adds the current note to your queue as an article. Hidden while the review tab is active. See [Importing material](/guide/importing#import-a-note-as-an-article).

### Create empty article

Creates a new, blank article that's already in your queue.

### Extract selection to snippet

Creates a snippet from the selected text. Works in the review tab and in any Markdown note, but not in reading view. See [Read and extract snippets](/guide/review-sessions#read-and-extract-snippets).

### Create spaced repetition card

Creates a fill-in-the-blank card. The selected text becomes the answer, and the paragraph or list item around it becomes the card. See [Make cards](/guide/review-sessions#make-cards).

### Undo last action

Reverses the last thing you did in the review tab: marking an item reviewed, grading, skipping, dismissing, or creating a snippet or card.

## Review commands

These only work while the review tab is active.

### Review: show answer/mark reviewed

On a card, shows the answer. On an article or snippet, marks it reviewed and moves on.

### Review: skip for current session

Moves on without reviewing the current item. It won't come up again until the next review day.

### Review: dismiss from future review

Takes the current item out of the queue. Nothing is deleted.

### Review: un-dismiss

Puts a dismissed item back in the queue.

### Review: grade card 1 (again)

Grades the current card as **Forgot**. The four grade commands only work after the answer is shown. See [Grade cards](/guide/review-sessions#grade-cards).

### Review: grade card 2 (hard)

Grades the current card as **Hard**.

### Review: grade card 3 (good)

Grades the current card as **Good**.

### Review: grade card 4 (easy)

Grades the current card as **Easy**.

### Review: toggle reviewing cards only

Switches between reviewing only cards and reviewing everything. See [Filter by item type](/guide/review-sessions#filter-by-item-type).

### Manage item scheduling

Opens the scheduling dialog for the current article or snippet, where you can switch between priority and fixed intervals and change the value. See [Scheduling](/guide/scheduling).

### Toggle live preview/source mode

Switches the review tab's editor between live preview and source mode.

## Extra import commands

These appear only when **Enable extra import hotkeys** is on in [settings](/reference/settings#shortcuts). Each one skips a step of the normal import.

### Quick import

Imports the current note using your default settings, without showing the import dialog.

### Open import dialog...

Imports the current note and always shows the import dialog, even if **Show article import dialog** is off.

### Import article as copy

Imports a copy of the current note into `incremental-reading/articles/` without showing the dialog.

### Import article in place

Imports the current note where it is, without showing the dialog.

To add these four options to the file menu as well, turn on **Show extra file menu entries for importing**.
