# Scheduling

Cards are scheduled by [FSRS](https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm), based on how you grade them. Articles and snippets have two options instead: **priority scheduling** and **fixed intervals**.

Priority scheduling is the default and suits most material. Fixed intervals work better for:

- Very long texts, such as a whole book imported as a single article.
- Material you need to learn by a deadline less than 3–4 weeks away.

## Priority scheduling

With priority scheduling, the time between reviews starts at one day and grows a little after each review. The priority sets how fast it grows:

- **1** means the interval barely grows, so the item comes back almost every day.
- **5** means each interval is about 1.6 times the one before.

| Priority | Growth per review | Interval after 5 reviews | Interval after 10 reviews |
|---|---|---|---|
| 1 | ×1.01 | ~1 day | ~1 day |
| 2 | ×1.16 | ~2 days | ~4 days |
| 3 (default) | ×1.31 | ~4 days | ~15 days |
| 4 | ×1.46 | ~7 days | ~44 days |
| 5 | ×1.61 | ~11 days | ~117 days |

Use a lower priority for material you want to see often and a higher one for material that can wait. Don't worry if it feels arbitrary at first. You'll get a feel for it with practice.

New articles get the **Default article priority** from [settings](/reference/settings#imports) unless you change it in the import dialog. New snippets inherit their parent's priority.

### Entering decimal priorities

Priorities can have one decimal place, such as 2.5, for finer control. As a shortcut, type a two-digit number from 10 to 50 and the decimal point is added for you, so `25` becomes `2.5`.

### Changing priority

Change an item's priority in the priority field of the [action bar](/reference/action-bar#articles-and-snippets) during review, or with **Manage item scheduling**.

Lowering the priority doesn't shorten the next interval. It only slows how fast later intervals grow. To see an item sooner, switch it to a short fixed interval.

## Fixed-interval scheduling

With fixed intervals, an article or snippet comes back every set number of days, from 1 to 30.

To switch an item between priority and fixed intervals, select **Change scheduling strategy** (the calendar icon) in the action bar, or run **Manage item scheduling**. Both work for articles and snippets only. You can also choose **Fixed intervals** in the import dialog.

Snippets made from a fixed-interval article get a priority that keeps them ahead of the article's next few reviews.

## When the review day ends

Everything that's due by the end of the review day shows up in that day's reviews. The review day ends at 4 AM by default, so a late-night session still counts as the same day. Change this with **End-of-day shift** in [settings](/reference/settings#reviews).

## Review order within a day

By default, articles and snippets due on the same day are partly shuffled, so you don't always see them in the same order. Turn this off with **Fuzz review ordering**.

To randomize card intervals slightly as well, so cards you made together don't always come due together, turn on **Fuzz review intervals**.
