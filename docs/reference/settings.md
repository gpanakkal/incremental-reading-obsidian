# Settings

Find these under **Settings → Community plugins → Incremental Reading**.

## Imports

### Default article priority

The priority that new articles get, from 1.0 to 5.0. Changing it doesn't affect articles you've already imported. See [Priority scheduling](/guide/scheduling#priority-scheduling).

**Default:** 3.0

### Show article import dialog

Shows a dialog on import where you can choose the scheduling method, priority or interval, and whether to copy the note. Turn it off to import straight away with your defaults.

**Default:** on

### Copy articles when importing

When on, importing copies the note into `incremental-reading/articles/` and leaves the original alone. When off, the note is imported where it is, and the plugin adds `ir-article` and `ir-id` to its frontmatter.

**Default:** off (import in place)

### Create empty articles in the current folder

When on, **Create empty article** puts the new article in the folder you're working in. When off, it goes in `incremental-reading/articles/`.

**Default:** on

## Reviews

### End-of-day shift

When the review day ends, in hours from midnight, from −12 to 12. Set it to a time you're usually asleep, so a late-night session counts as the same day. Items you skip stay hidden until this time.

**Default:** 4 (4 AM)

### Fuzz review ordering

Partly shuffles articles and snippets that are due on the same day, so they don't always come up in the same order. Cards aren't affected.

**Default:** on

### Skip home screen

Opening review goes straight to the first due item instead of the home screen.

**Default:** off

## Shortcuts

### Enable extra import hotkeys

Adds four commands: **Quick import**, **Open import dialog...**, **Import article as copy**, and **Import article in place**. See [Extra import commands](/reference/commands#extra-import-commands).

**Default:** off

### Show extra file menu entries for importing

Adds the same four options to the file menu.

**Default:** off

## Spaced repetition

These settings control how [FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm) schedules cards. They don't affect articles or snippets.

### Targeted retention

The share of cards you want to be able to recall when they come due, from 0.80 to 0.95. Higher values mean more frequent reviews. 0.9 is best for most people.

**Default:** 0.9

### Fuzz review intervals

Adds a little randomness to card intervals, so cards made at the same time don't always come due together.

**Default:** off

### Maximum review interval

The longest time between card reviews, in days. Fuzzing can go slightly over this limit.

**Default:** 36,500 days (about 100 years)

### Enable short-term card scheduling

When on, a card you grade below **Easy** can come back again within minutes, following the learning steps below.

**Default:** on

### Learning steps

The short intervals a new card goes through before FSRS starts scheduling it in days. Separate steps with commas, using `m` for minutes, `h` for hours, and `d` for days, for example `1m, 10m`.

**Default:** 1m, 10m

### Relearning steps

The same as learning steps, for cards you've forgotten.

**Default:** 10m
