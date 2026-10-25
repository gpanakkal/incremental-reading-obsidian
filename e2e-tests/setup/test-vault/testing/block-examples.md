# Block examples

To test imputation of Markdown formatting delimiters when making cards and snippets from selections containing one or zero delimiters applying formatting to the selection.

## 1. Code block followed by a paragraph

Select from the middle of the code block to the middle of the paragraph below it, then extract a snippet. The snippet should start with the full fence line and end with paragraph text. Repeat with a selection that starts on `py` inside the opening fence line.

```python
def greet(name):
    message = f"Hello, {name}"
    print(message)
    return message


for who in ["Ada", "Grace", "Linus"]:
    greet(who)
```

This paragraph sits right after the code block. A selection that starts inside the code and ends somewhere in this sentence should keep the code fenced and leave this text as prose.

## 2. Code block for selection-mode cards

Make a selection-mode card from the middle of this block to the end of the paragraph after it. In the source note the code above the embed should still be closed, the embed should render, and the paragraph tail should remain prose.

```javascript
function sum(values) {
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return total;
}

console.log(sum([1, 2, 3]));
```

Trailing paragraph for the selection-mode card. Only part of this sentence needs to be selected.

## 3. Code block for cursor-line cards

Put the cursor on the `return area;` line and make a card (cursor line plus answer). The embed should render between two code blocks, and the card note should show that line fenced. Undo the card afterwards and check the source has no stray fence lines.

```typescript
export function circleArea(radius: number): number {
  const area = Math.PI * radius * radius;
  return area;
}

export function circumference(radius: number): number {
  return 2 * Math.PI * radius;
}
```

## 4. Math block

Select from the middle of the math block (for example from `b^2` onward) into the line after it and extract a snippet. The snippet should render the math.

$$
a^2 + b^2 = c^2
\quad\text{and}\quad
e^{i\pi} + 1 = 0
$$

Line after the math block.

## 5. Comment block

Select from the middle of the hidden comment into the line after it and extract a snippet. The commented text should stay hidden in the snippet.

%%
This text is a hidden comment.
It spans several lines so a selection can start in the middle.
%%

Line after the comment block.

## 6. Table

Select text inside a body cell (for example part of `Spaced repetition`) and extract a snippet. The snippet should show a table with the header row, the separator row, and the text in its own column.

| Technique          | Purpose                     | Interval |
| ------------------ | --------------------------- | -------- |
| Spaced repetition  | Remember facts over time    | Growing  |
| Incremental reading | Work through long articles | Daily    |
| Cloze deletion     | Recall a missing word       | Varies   |

## 7. Callout

Select text inside the callout body and extract a snippet. The snippet should be a callout with the same type and title.

> [!tip] Reading tip
> Read the abstract first, then skim the headings.
> Come back to the details only once the shape of the argument is clear.

## 8. Nested quote

Select part of the innermost line and extract a snippet. The snippet should keep the nesting.

> Outer quote line.
> > Inner quote line, select part of this one.
> > It continues here.
> Back to the outer quote.

## 9. Plain paragraph

Select part of this paragraph and extract a snippet, then a card. Both should match the behaviour from before 0153: no extra blank lines and the same title as before.

Plain prose with nothing special around it. The quick brown fox jumps over the lazy dog, and the sentence is long enough to select a middle portion without touching either end.
