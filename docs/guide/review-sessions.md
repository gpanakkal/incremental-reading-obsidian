# Review sessions

Most of your time with the plugin is spent in review sessions. Each session works through the items that are due today, one at a time.

## The short version

1. Select the **Incremental reading** icon in the left ribbon, or run **Incremental Reading: Learn**.
2. Select **Begin Review**.
3. For each item:
   - **Article or snippet:** read, extract snippets or make cards, then select **Mark reviewed**.
   - **Card:** try to recall the answer, select **Show answer**, then grade yourself.
4. Keep going until nothing is due, or stop whenever you like. Anything you didn't get to stays in the queue.

The rest of this page covers each step in more detail. For every button, see the [action bar reference](/reference/action-bar).

## Start a session

The ribbon icon and the **Learn** command both open the review tab on its home screen, which lists the items that are due. Select **Begin Review** to start. If nothing is due, the button is disabled.

When the queue runs out, a summary shows how many articles, snippets, and cards you reviewed and lists anything you skipped.

To go straight to the first due item instead, turn on **Skip home screen** in [settings](/reference/settings#reviews).

> [!TIP]
> Running **Learn** while the review tab is already focused switches between the home screen and the current item.

## Read and extract snippets

When an article or snippet comes up, read as much as you want. It doesn't have to be the whole thing. When a passage is interesting or important, select it and run **Extract selection to snippet**, or select the scissors icon in the action bar.

The snippet becomes a new note, and the passage stays highlighted in the original. It's scheduled for review the next day.

Extract generously early on. It's easier to throw away a snippet later than to go back and find a passage you skipped.

## Mark reviewed

Select **Mark reviewed** (the green check mark) when you're done with an item for now. It's rescheduled according to its [priority or interval](/guide/scheduling), and the next item opens.

You don't need to finish an article in one sitting. It will come back, and you can pick up where you left off.

## Skip or dismiss an item

- **Skip for current review session** moves on without reviewing the item. It stays due, but it won't come up again until the next review day starts (4 AM by default; see [End-of-day shift](/reference/settings#reviews)).
- **Stop scheduling this item for review** (dismiss) takes the item out of the queue for good. Use it when you've got everything you need from an article or snippet, or when a card isn't worth keeping.

Dismissing doesn't delete anything. To bring a dismissed item back, open its note and select **Un-dismiss** in the bar at the top. In the review tab, the same button is called **Restore item to queue**.

## Revise snippets

Each time a snippet comes back, you can improve it: cut filler, reword it, or split it into smaller pieces. This is one of the most important steps in incremental reading. Every pass makes the snippet shorter and clearer, until it's ready to become a card.

> [!TIP]
> Wait until it's obvious what to change, and make one simple revision per review. You'll understand the material better on later passes, and your edits will be better for it.

## Make cards

When a snippet is short and clear, turn it into one or more spaced repetition cards. Cards are fill-in-the-blank questions (sometimes called cloze deletions).

1. Select the words that should be the answer.
2. Run **Create spaced repetition card**, or select the card icon in the action bar.

The whole paragraph or list item containing your selection becomes the card, with your selection as the blank. In the original note, the paragraph is replaced with an embed of the card, so the note still reads the same. See [Embedding cards into other notes](/guide/outside-review#embed-cards-into-other-notes).

Tips for good cards:

- **Keep them short.** One or two sentences is ideal, as long as the question is still clear.
- **Have one correct answer.** If more than one answer would fit the blank, add context until only one does.
- **Split paragraphs first.** Everything in the paragraph or list item goes into the card, so break long ones up before you make a card.

For more, see [20 rules of knowledge formulation](https://supermemo.guru/wiki/20_rules_of_knowledge_formulation).

## Review and grade cards

When a card comes up, the answer is hidden. Try to recall it, then select **Show answer** (the eye icon).

> [!WARNING]
> Really try to recall the answer before you reveal it. Spaced repetition only works if the grades reflect what you actually remember.

## Grade cards

After you show the answer, choose a grade:

| Button | When to choose it |
|---|---|
| **🔁 Forgot** | You didn't recall the answer. (In the command list, this grade is called **Again**.) |
| **👎 Hard** | You recalled roughly the right answer, but it took time and effort. |
| **👍 Good** | The answer came to you fairly quickly, but not effortlessly. |
| **✅ Easy** | You recalled the answer immediately. |

The grade determines when the card comes back. Cards you forget can come back within the same session, a few minutes later. See the spaced repetition options in [settings](/reference/settings#spaced-repetition).

## Filter by item type

The three icons on the left of the action bar turn articles, snippets, and cards on or off for the session. For example, turn off articles and snippets on a busy day to review only your cards. Their tooltips show which types are included ("Reviewing cards", "Not reviewing articles", and so on).

The **Review: toggle reviewing cards only** command does the same with one keypress.

## Undo a mistake

Select **Undo** in the action bar or run **Undo last action**. You can undo marking an item reviewed, grading a card, skipping, dismissing, and creating a snippet or card. The button's tooltip tells you what will be undone.

## Change an item's schedule

For articles and snippets, the action bar shows the item's priority (or its fixed interval). Edit it there, or select **Change scheduling strategy** to switch between priority and fixed intervals. See [Scheduling](/guide/scheduling).
