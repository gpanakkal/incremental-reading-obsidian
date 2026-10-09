# Plugin data

Articles, snippets, and cards are ordinary Markdown notes, and you can open, edit, link to, and search them like any other note. Scheduling and review history are kept in a database.

## The data folder

Everything the plugin creates goes in an `incremental-reading/` folder at the root of your vault:

| Path | Contents |
|---|---|
| `incremental-reading/articles/` | Articles imported as copies, and empty articles if **Create empty articles in the current folder** is off |
| `incremental-reading/snippets/` | One note per snippet |
| `incremental-reading/cards/` | One note per card |
| `incremental-reading/ir-user-data.sqlite` | The database |

Articles imported in place stay where they are. See [Import options](/guide/importing#import-options).

## The database

`ir-user-data.sqlite` is a SQLite database. It stores each item's schedule and priority, the review history, FSRS data for cards, and the location of each snippet in its source note.

Obsidian Sync ignores this file type unless **Sync all other types** is on. See [Set up Obsidian Sync](/quick-start#_2-set-up-obsidian-sync).

## Changes to your notes

The plugin only changes your own notes' frontmatter, in these cases:

- **Importing in place** adds `ir-article` to the note's tags and an `ir-id` property.
- **Making a snippet** from a note that isn't already an article, snippet, or card adds `ir-source` to its tags.
- **Making a card** replaces the paragraph or list item with an embed of the card. This one also changes the note's text.

Everything else stays inside the data folder.

## Tags and properties

| Name | Where it goes | What it means |
|---|---|---|
| `ir-article` (tag) | Articles | The note is an article. |
| `ir-text-snippet` (tag) | Snippets | The note is a snippet. |
| `ir-card` (tag) | Cards | The note is a card. |
| `ir-source` (tag) | Other notes | Snippets or cards have been made from this note. |
| `ir-id` (property) | Articles, snippets, cards | Links the note to its entry in the database. Don't edit or copy it. |
| `source` (property) | Snippets, cards | A link back to the note it was made from. |
| `delimiters` (property) | Cards | The characters that mark the answer. See [Card syntax](#card-syntax). |

## Card syntax

In a card note, the answer is wrapped in `(}` and `{)`:

```md
The capital of Australia is (}Canberra{).
```

::: v-pre
You can edit a card's text directly, as long as the delimiters stay around the answer. Cards made with older versions of the plugin used `{{` and `}}`. They're converted to the new delimiters automatically the next time they come up for review.
:::
