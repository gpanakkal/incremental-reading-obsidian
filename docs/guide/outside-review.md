# Outside review

You don't have to be in a review session to use the plugin. You can extract snippets and make cards from any Markdown note in your vault.

This is especially useful for:

- **Notes with just one useful passage.** Extract that passage as a snippet instead of importing the whole note.
- **Notes that are already card-ready.** For example, a list of short, self-contained facts can be turned straight into cards.

## Make snippets from notes

1. Open any note and select the passage you want.
2. Run **Extract selection to snippet**.

The snippet goes into your queue and is due tomorrow. The passage stays highlighted in the original note, and clicking the highlight opens the snippet.

If the note isn't already an article, snippet, or card, it gets an `ir-source` tag in its frontmatter. This is the only change the plugin makes to a note you haven't imported. See [Plugin data](/reference/plugin-data#tags-and-properties).

> [!NOTE]
> **Extract selection to snippet** doesn't work in reading view. Switch to live preview or source mode first.

## Make cards from notes

1. Select the words that should be the answer.
2. Run **Create spaced repetition card**.

This works the same as it does [during review](/guide/review-sessions#make-cards). The whole paragraph or list item becomes the card, and the paragraph in your note is replaced with an embed of the card.

## Embed cards into other notes

Each card is its own note in `incremental-reading/cards/`, so you can embed it anywhere, like any other note. When you make a card, the plugin puts this embed in place of the original paragraph:

```md
![[Card note name|ir-hide-title]]
```

The `ir-hide-title` alias shows the card's text inline, without the card note's title or properties, so it reads like the rest of the note. A colored line in the margin marks it as embedded. Copy the embed into any note to show the card there too. It stays in sync, because there's only one copy of the card.

## The action bar on plugin notes

When you open an article, snippet, or card note outside the review tab, a small bar appears at the top:

- **Dismiss** / **Un-dismiss** takes the item out of your queue or puts it back. If the note has plugin tags but isn't in the database, the button reads **Not in database**.
- **Review** opens the item in the review tab.
