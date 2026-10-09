# Action bar

The action bar runs along the top of the review tab. Its buttons change depending on what's open. Hover over a button to see its name.

The bar has three parts:

- **Left:** navigation, the item type filter, and undo.
- **Middle:** actions for the current item.
- **Right:** the **⋮** menu (desktop only).

## Left side

These are always shown.

| Button | Icon | What it does |
|---|---|---|
| Navigate back / Navigate forward | ← → | Moves through the review tab's history. Desktop only. On mobile, use Obsidian's own navigation. |
| Go to home screen | House | Returns to the home screen. Hidden when you're already there. |
| Articles / Snippets / Cards filter | Page, scissors, card | Turns each item type on or off for this session. The tooltip says "Reviewing …" or "Not reviewing …". See [Filter by item type](/guide/review-sessions#filter-by-item-type). |
| Undo | Curved arrow | Undoes your last action. The tooltip says what will be undone, or "Nothing to undo". |

## Home screen

| Button | What it does |
|---|---|
| **Begin Review** | Starts reviewing the queue. Disabled if nothing is due ("Nothing due for review"). |

## Articles and snippets

| Button | Icon | What it does |
|---|---|---|
| Mark reviewed | Green check mark | Reschedules the item and moves to the next one. |
| Skip for current review session | Skip forward | Moves on without reviewing. The item won't come up again until the next review day. |
| Extract selected text to a new snippet | Scissors | Same as **Extract selection to snippet**. |
| Create card | Card | Same as **Create spaced repetition card**. |
| Priority / Every … days | Number field | The item's priority (1–5) or fixed interval (1–30 days). Edit it and press <kbd>Enter</kbd>. See [Scheduling](/guide/scheduling). |
| Change scheduling strategy | Calendar with arrows | Switches between priority and fixed intervals. |
| Stop scheduling this item for review | Amber circle with line | Dismisses the item. |
| Restore item to queue | Box with up arrow | Shown instead of the dismiss button on a dismissed item. Puts it back in the queue. |

## Cards

Before you show the answer:

| Button | Icon | What it does |
|---|---|---|
| Show answer | Green eye | Reveals the answer and the grade buttons. |
| Skip for current review session | Skip forward | Moves on without grading. |

After you show the answer, the grade buttons take their place:

| Button | FSRS grade | Choose when |
|---|---|---|
| 🔁 Forgot | Again | You didn't recall the answer. |
| 👎 Hard | Hard | You recalled it, but with effort. |
| 👍 Good | Good | You recalled it fairly quickly. |
| ✅ Easy | Easy | You recalled it immediately. |

Cards also have **Extract selected text to a new snippet**, **Create card**, and **Stop scheduling this item for review** / **Restore item to queue**, which work the same as for articles and snippets.

## ⋮ menu

On desktop, **More options** (⋮) on the right opens the review tab's menu:

- **Source mode** / **Live preview:** switch how the note is edited.
- **Open in new tab**
- **Reveal file in navigation**
- **Rename...**
- **Delete**
- Obsidian's usual copy and linked-view options.

## Action bar outside review

Notes that belong to the plugin get a smaller bar when you open them in a normal tab. See [The action bar on plugin notes](/guide/outside-review#the-action-bar-on-plugin-notes).
