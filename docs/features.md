# Feature overview

Incremental reading is a way to learn from texts in small steps. Instead of reading an article once from start to finish, you read part of it, pull out what matters, and come back to it later. Over several passes, the important parts get shorter and clearer until you can turn them into flashcards and keep them for good.

With this plugin, you can:

- Build understanding gradually, through repeated exposure to the same material.
- Learn several subjects in parallel without scheduling or tracking any of them by hand.
- Keep what you've learned indefinitely with spaced repetition cards.

Everything happens inside Obsidian, so your reading material, snippets, and cards sit alongside your other notes.

## One queue for everything

Articles, snippets, and cards that are due are shown one after another in a single review session, mixed together. You can [filter the session](/guide/review-sessions#filter-by-item-type) to show only some item types, for example only cards on a busy day.

The home screen shows what's due, and the queue can be browsed by page or by jumping to a date.

## Articles, snippets, and cards

- An **article** is a whole note you've imported, such as a clipped web page.
- A **snippet** is a passage you've extracted from an article or any other note. It becomes its own note, and the passage stays highlighted in the original. Clicking the highlight opens the snippet.
- A **card** is a fill-in-the-blank question. When you make a card, the paragraph it came from is replaced with an embed of the card, so the text still reads normally in the original note.

See the [glossary](/reference/glossary) for the full list of terms.

## Two ways to schedule reading

Cards are scheduled with [FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm), a spaced repetition algorithm that bases each card's next review on how well you've remembered it so far.

Articles and snippets have two options:

- **Priority scheduling** (the default). The time between reviews starts at one day and grows after each review. The priority controls how fast it grows.
- **Fixed intervals**. The item comes back every set number of days. This suits very long texts and material you have to learn before a deadline.

See [Scheduling](/guide/scheduling) for how to choose.

## Undo

Made a mistake? **Undo** in the action bar, or the **Undo last action** command, reverses the last thing you did in a review session: marking an item reviewed, grading a card, skipping, dismissing, or creating a snippet or card.

## Works in and out of review

You can extract snippets and make cards from any note, not just during review sessions. Notes that belong to the plugin also get a small action bar, so you can dismiss them or open them in review from wherever you are. See [Outside review](/guide/outside-review).

## Plain Markdown, on every device

Articles, snippets, and cards are ordinary Markdown notes in your vault. Review history and scheduling are stored in a SQLite database inside the plugin's folder. The plugin works on desktop and mobile, and syncs with Obsidian Sync. See [Plugin data](/reference/plugin-data).
