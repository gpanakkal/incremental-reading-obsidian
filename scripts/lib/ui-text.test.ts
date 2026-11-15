import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  diffCopy,
  escapeMd,
  extractCopy,
  wordDiff,
  type CopyEntry,
} from './ui-text.mjs';

// #region HELPERS
/** `[kind, text]` of every entry, which is what a reviewer reads. */
function copyOf(source: string, fileName = 'src/lib/x.tsx') {
  return extractCopy(source, fileName).map((e) => [e.kind, e.text]);
}

/** Undoes `escapeMd` and drops the `~~`/`**` word markers `wordDiff` adds. */
function plain(markdown: string) {
  let out = '';
  for (let i = 0; i < markdown.length; i++) {
    if (markdown[i] === '\\') out += markdown[++i];
    else if (/^(~~|\*\*)/.test(markdown.slice(i))) i++;
    else out += markdown[i];
  }
  return out;
}

// a small pool too, so the same string turns up on both sides and twice on one
const textArb = fc.oneof(
  fc.constantFrom('Open', 'Open note', 'Saved the note', 'the note', ''),
  fc.string({ maxLength: 30 })
);

const entryArb = fc.record({
  kind: fc.constantFrom('notify', 'jsx', 'prose?', 'label'),
  text: textArb,
  line: fc.nat(500),
  scope: fc.string({ maxLength: 5 }),
});

const notify = (text: string, line = 1, kind = 'notify'): CopyEntry => ({
  kind,
  text,
  line,
  scope: '',
});

/** What a diff reports, as `[change, old text, new text]`. */
const summary = (changes: ReturnType<typeof diffCopy>) =>
  changes.map((c) => [c.change, c.old?.text, c.new?.text]);

const wordsArb = fc.array(fc.stringMatching(/^[a-z]{1,5}$/), {
  minLength: 3,
  maxLength: 10,
});

const keyOf = (e: CopyEntry) => `${e.kind}\u0000${e.text}`;

/** Length of the longest common subsequence: the reference for wordDiff. */
function lcsLength(a: string[], b: string[]): number {
  const row = new Array<number>(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    b.forEach((y, j) => {
      const above = row[j + 1];
      row[j + 1] = x === y ? diagonal + 1 : Math.max(row[j + 1], row[j]);
      diagonal = above;
    });
  }
  return row[b.length];
}

/** The words a wordDiff side leaves unmarked, in order. */
const unmarked = (side: string) =>
  side.split(' ').filter((w) => w && !/^(~~|\*\*)/.test(w));

/** Multiset difference of entries by kind and text. */
function without(all: CopyEntry[], taken: CopyEntry[]) {
  const left = all.map(keyOf);
  for (const key of taken.map(keyOf)) {
    expect(left).toContain(key);
    left.splice(left.indexOf(key), 1);
  }
  return left.sort();
}
// #endregion

describe('extractCopy', () => {
  it('names the sink each string goes to', () => {
    const source = `
      notify('Saved the note');
      new Notice('Imported 3 notes');
      setting.setName('Default priority').setDesc('For new imports');
      el.createEl('button', { text: 'Undo', cls: 'mod-cta warning' });
      btn.setAttribute('aria-label', 'Open the note');
      const s = { name: 'Fuzz intervals', desc: 'Adds randomness' };
      plugin.addCommand({ id: 'x', name: 'Review now', callback });
    `;
    expect(copyOf(source)).toEqual([
      ['notify', 'Saved the note'],
      ['Notice', 'Imported 3 notes'],
      ['setName', 'Default priority'],
      ['setDesc', 'For new imports'],
      ['text', 'Undo'],
      ['aria-label', 'Open the note'],
      ['setting name', 'Fuzz intervals'],
      ['desc', 'Adds randomness'],
      ['command name', 'Review now'],
    ]);
  });

  it('keeps interpolations, joins concatenations and splits branches', () => {
    const source = `
      notify(\`Deleted \${count} notes\`);
      notify('Moved ' + n + ' items to ' + folder);
      notify(one ? 'Removed the card' : \`Removed \${n} cards\`);
      notify(first + second);
    `;
    expect(copyOf(source)).toEqual([
      ['notify', 'Deleted ${count} notes'],
      ['notify', 'Moved ${n} items to ${folder}'],
      ['notify', 'Removed the card'],
      ['notify', 'Removed ${n} cards'],
    ]);
  });

  it('reads JSX text as one string per element, with its expressions', () => {
    const source = `const A = () => (
      <div aria-label="Review queue" className="ir queue-row">
        <p>
          Due {count} items,{' '}<b>today</b><br />{}<>x</>
        </p>
        <span>{busy ? 'Saving the note' : 'Save'}</span>
      </div>
    );`;
    expect(copyOf(source)).toEqual([
      ['aria-label', 'Review queue'],
      ['jsx', 'Due {count} items, <b><br/>{}'],
      ['jsx', 'today'],
      ['jsx', 'x'],
      ['jsx', 'Saving the note'],
      ['jsx', 'Save'],
    ]);
  });

  it('flags prose-like strings outside known sinks as prose?', () => {
    const source = `
      const reason = 'already an article';
      addButton(actions, 'Re-associate', ['x'], false);
      function f() { return \`\${n} item notes\`; }
      const paragraphs = ['The database will be replaced.', 'Backed up first.'];
    `;
    expect(copyOf(source)).toEqual([
      ['prose?', 'already an article'],
      ['prose?', 'Re-associate'],
      ['prose?', '${n} item notes'],
      // an array kept as it is, unlike a word list worked on in place
      ['prose?', 'The database will be replaced.'],
      ['prose?', 'Backed up first.'],
    ]);
  });

  it('flags prose? for strings that miss a sink by position or shape', () => {
    const source = `
      label = 'Some words here';
      notify(message, 'Second argument words');
      fakeconsole.warn('Logged words here');
      const o = { id: 'x', name: 'Not a command name' };
      const p = { name: 'No id here', callback };
    `;
    expect(copyOf(source)).toEqual([
      ['prose?', 'Some words here'],
      ['prose?', 'Second argument words'],
      ['prose?', 'Logged words here'],
      ['prose?', 'Not a command name'],
      ['prose?', 'No id here'],
    ]);
  });

  it('climbs only through the branches of a ternary or the fallback of ?? || &&', () => {
    const source = `
      notify('Shown words here' ? a : b);
      notify('Left side words' && message);
      notify(message ?? 'Right side words');
      notify(\`Removed \${one ? 'the only card' : 'all the cards'}\`);
    `;
    expect(copyOf(source)).toEqual([
      // a string as the condition is no branch: it stops the climb
      ['prose?', 'Shown words here'],
      ['notify', 'Right side words'],
      ['notify', "Removed ${one ? 'the only card' : 'all the cards'}"],
      ['prose?', 'the only card'],
      ['prose?', 'all the cards'],
    ]);
  });

  it('skips strings never shown: logs, errors, SQL, imports, word lists, types', () => {
    const source = `
      import { x } from './some module';
      console.error('Failed to load the item');
      throw new Error('Something went wrong here');
      class E extends Error { constructor() { super('Database load failed'); } }
      db.exec('SELECT id FROM article WHERE deleted = 0');
      const OPS = new Set(['sin cos tan', 'lim sup inf'].join(' ').split(' '));
      const SCRIPTS = ['Arabic', 'Syriac'].map((s) => 'Script=' + s);
      type T = 'Some literal type';
      if (mode === 'Reading mode') run();
      el.addClass('is active');
      const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"])';
      const KEYS = { 'label': value, 'Some quoted key': 1 };
    `;
    expect(copyOf(source)).toEqual([]);
  });

  it('leaves the database layer out of prose?, but not its sinks', () => {
    const source = `
      const description = 'Add a column to the table';
      notify('Database restored from backup');
    `;
    expect(copyOf(source, 'src/db/migrations.ts')).toEqual([
      ['notify', 'Database restored from backup'],
    ]);
  });

  it('judges prose? by the literal text, never by the code interpolated into it', () => {
    const source = `
      const row = \`|\${doc.slice(opening + 1, at)}\`;
      const prefix = \`\${closeAt(doc, block, at)}\`;
      const due = \`Due: \${formatQueueDate(due)}\`;
      const where = \`in \${path.slice(0, cut)}/\`;
      const message = \`\${error.message}\`;
      refusedWrite(repo, \`import "\${file.name}"\`);
      const cloze = pre + \`\${OPEN} \${answer} \${CLOSE}\` + post;
      const nested = \`\${f({ a }, 'inner words here')}\`;
      const ago = \`\${n}d ago\`;
    `;
    expect(copyOf(source)).toEqual([
      ['prose?', 'Due: ${formatQueueDate(due)}'],
      ['prose?', 'in ${path.slice(0, cut)}/'],
      ['prose?', 'import "${file.name}"'],
      ['prose?', 'inner words here'],
      // a leading value counts as a word: "3d ago"
      ['prose?', '${n}d ago'],
    ]);
  });

  it('skips SQL fragments, markup, selector lists and key names', () => {
    const source = `
      const set = 'state = $10, dismissed = CASE WHEN $11 THEN 1 ELSE dismissed END';
      query += ' ORDER BY due ASC';
      const same = \`i.\${c} IS m.\${c}\`;
      const svg = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 4"/></svg>';
      const CLICKABLE = 'button, a, [role="button"], .clickable-icon';
      scope.register([], 'Escape', close);
      log(\`Incremental Reading - reload \${ms} ms\`);
      <button className={withClass('ir-review-button clickable-icon', className)} />;
    `;
    expect(copyOf(source)).toEqual([]);
  });

  it('reads assignments: element text as copy, class names never, += like =', () => {
    const source = `
      dom.className = 'ir-action-bar ir-action-bar-panel';
      container.textContent = 'Priority';
      notice += ', but its frontmatter could not be updated';
    `;
    expect(copyOf(source)).toEqual([
      ['textContent', 'Priority'],
      ['prose?', ', but its frontmatter could not be updated'],
    ]);
  });

  it('reads a string child as part of its element text, or alone when the element has none', () => {
    const source = `const A = () => (
      <div>
        <p>Due {'today, then later'}</p>
        <p>
          {'Alone words'}
        </p>
        <b title={'save'} aria-label={'Open the note'} />
      </div>
    );`;
    expect(copyOf(source)).toEqual([
      ['jsx', 'Due today, then later'],
      ['jsx', 'Alone words'],
      ['title', 'save'],
      ['aria-label', 'Open the note'],
    ]);
  });

  it('puts JSX text at the line its text starts on', () => {
    const source =
      'const A = () => (\n  <p>\n    <b>x</b>\n    {y} words here\n  </p>\n);';
    expect(extractCopy(source, 'a.tsx').map((e) => [e.text, e.line])).toEqual([
      ['<b> {y} words here', 4],
      ['x', 3],
    ]);
  });

  it('gives each entry its line and enclosing declaration', () => {
    const source = `class A {\n  run() {\n    notify('Saved the note');\n  }\n}\nnotify(\`Moved \${n} notes to \${folder}\`);`;
    expect(extractCopy(source, 'a.ts')).toEqual([
      { kind: 'notify', text: 'Saved the note', line: 3, scope: 'run' },
      {
        kind: 'notify',
        text: 'Moved ${n} notes to ${folder}',
        line: 6,
        scope: '',
      },
    ]);
  });
});

describe('diffCopy', () => {
  it('reports nothing when the copy only moved', () => {
    fc.assert(
      fc.property(
        fc
          .array(entryArb, { maxLength: 8 })
          .chain((before) =>
            fc
              .shuffledSubarray(before, { minLength: before.length })
              .map((after) => ({ before, after }))
          ),
        ({ before, after }) => {
          const moved = after.map((e, i) => ({ ...e, line: i }));
          expect(diffCopy(before, moved)).toEqual([]);
        }
      )
    );
  });

  it('accounts for every string exactly once, sorted by line', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { maxLength: 8 }),
        fc.array(entryArb, { maxLength: 8 }),
        (before, after) => {
          const changes = diffCopy(before, after);
          const olds = changes.flatMap((c) => (c.old ? [c.old] : []));
          const news = changes.flatMap((c) => (c.new ? [c.new] : []));
          // what no change mentions is what both sides share unchanged
          expect(without(before, olds)).toEqual(without(after, news));
          for (const c of changes) {
            expect(c.change).toBe(
              c.old && c.new ? 'changed' : c.old ? 'removed' : 'added'
            );
            expect(c.kind).toBe((c.new ?? c.old)?.kind);
          }
          const lines = changes.map((c) => (c.new ?? c.old)?.line ?? 0);
          expect(lines).toEqual([...lines].sort((a, b) => a - b));
        }
      )
    );
  });

  it('pairs a reworded string as changed, and unrelated ones as added and removed', () => {
    const entry = (text: string, line = 1): CopyEntry => ({
      kind: 'notify',
      text,
      line,
      scope: '',
    });
    expect(
      diffCopy(
        [entry('The ir-id of the note was removed'), entry('Open', 2)],
        [
          entry('The ID of the note was removed'),
          entry('Snooze until tomorrow', 2),
        ]
      ).map((c) => [c.change, c.old?.text, c.new?.text])
    ).toEqual([
      [
        'changed',
        'The ir-id of the note was removed',
        'The ID of the note was removed',
      ],
      ['removed', 'Open', undefined],
      ['added', undefined, 'Snooze until tomorrow'],
    ]);
  });
});

describe('diffCopy pairing', () => {
  it('pairs a string with one word added or dropped as changed', () => {
    fc.assert(
      fc.property(wordsArb, fc.nat(), (words, at) => {
        const longer = [...words];
        longer.splice(at % (words.length + 1), 0, 'EXTRA');
        const [a, b] = [words.join(' '), longer.join(' ')];
        expect(summary(diffCopy([notify(a)], [notify(b)]))).toEqual([
          ['changed', a, b],
        ]);
        expect(summary(diffCopy([notify(b)], [notify(a)]))).toEqual([
          ['changed', b, a],
        ]);
      })
    );
  });

  it('never pairs strings that share no word', () => {
    fc.assert(
      fc.property(wordsArb, wordsArb, (x, y) => {
        const a = x.join(' ');
        const b = y.map((w) => w.toUpperCase() + '1').join(' ');
        expect(summary(diffCopy([notify(a)], [notify(b)]))).toEqual([
          ['removed', a, undefined],
          ['added', undefined, b],
        ]);
      })
    );
  });

  it('ignores case and punctuation when comparing words', () => {
    expect(
      summary(diffCopy([notify('Open the Note.')], [notify('open the note!')]))
    ).toEqual([['changed', 'Open the Note.', 'open the note!']]);
    expect(
      summary(diffCopy([notify('Foo, bar.')], [notify('Baz, qux.')]))
    ).toEqual([
      ['removed', 'Foo, bar.', undefined],
      ['added', undefined, 'Baz, qux.'],
    ]);
    expect(summary(diffCopy([notify('…')], [notify('!!!')]))).toEqual([
      ['removed', '…', undefined],
      ['added', undefined, '!!!'],
    ]);
  });

  it('compares the words of the copy, not of the code interpolated into it', () => {
    // sharing `${file.basename}` makes two messages no closer
    expect(
      summary(
        diffCopy(
          [notify('Canceled import of "${file.basename}"')],
          [notify('"${file.basename}" is the article\'s note again')]
        )
      )
    ).toEqual([
      ['removed', 'Canceled import of "${file.basename}"', undefined],
      ['added', undefined, '"${file.basename}" is the article\'s note again'],
    ]);
    expect(
      summary(
        diffCopy(
          [notify('Imported "${name}"')],
          [notify('Imported "${name}" as an article')]
        )
      )
    ).toEqual([
      ['changed', 'Imported "${name}"', 'Imported "${name}" as an article'],
    ]);
  });

  it('pairs at 45% shared words, with a bonus for the same kind', () => {
    const words = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => `w${from + i}`).join(' ');
    // 9 of 20 words shared each way: 18 / 40 = 0.45 exactly
    const a = words(0, 20);
    const b = `${words(0, 9)} ${words(100, 11)}`;
    expect(
      summary(diffCopy([notify(a, 1, 'jsx')], [notify(b, 1, 'label')]))
    ).toEqual([['changed', a, b]]);
    // 8 of 20: 0.4, enough only with the same-kind bonus
    const c = `${words(0, 8)} ${words(100, 12)}`;
    expect(summary(diffCopy([notify(a)], [notify(c)]))).toEqual([
      ['changed', a, c],
    ]);
    expect(
      summary(diffCopy([notify(a, 1, 'jsx')], [notify(c, 1, 'label')]))
    ).toEqual([
      ['removed', a, undefined],
      ['added', undefined, c],
    ]);
  });

  it('pairs each string once, with its closest match first', () => {
    const before = [notify('Open the note in a new tab', 1)];
    const after = [
      notify('Open the note in a tab', 2),
      notify('Open the note in a new tab now', 3),
    ];
    expect(summary(diffCopy(before, after))).toEqual([
      ['added', undefined, 'Open the note in a tab'],
      [
        'changed',
        'Open the note in a new tab',
        'Open the note in a new tab now',
      ],
    ]);
    // the same-kind bonus picks between two equally close matches
    expect(
      summary(
        diffCopy(
          [notify('Saved the note', 1)],
          [notify('Saved the notes', 2, 'label'), notify('Saved the notes', 3)]
        )
      )
    ).toEqual([
      ['added', undefined, 'Saved the notes'],
      ['changed', 'Saved the note', 'Saved the notes'],
    ]);
  });
});

describe('wordDiff', () => {
  it('leaves a longest common run of words unmarked, the same on both sides', () => {
    const vocab = fc.array(fc.constantFrom('a', 'b', 'c'), { maxLength: 8 });
    fc.assert(
      fc.property(vocab, vocab, (x, y) => {
        const w = wordDiff(x.join(' '), y.join(' '));
        expect(unmarked(w.old)).toEqual(unmarked(w.new));
        expect(unmarked(w.old)).toHaveLength(lcsLength(x, y));
      })
    );
  });

  it('marks only the word that was inserted', () => {
    fc.assert(
      fc.property(wordsArb, fc.nat(), (words, at) => {
        const longer = [...words];
        longer.splice(at % (words.length + 1), 0, 'EXTRA');
        const w = wordDiff(words.join(' '), longer.join(' '));
        expect(w.old).toBe(words.join(' '));
        expect(w.new).toBe(
          longer.map((x) => (x === 'EXTRA' ? '**EXTRA**' : x)).join(' ')
        );
      })
    );
  });

  it('shows each side in full, marking only words the other lacks', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const w = wordDiff(a, b);
        expect(plain(w.old)).toBe(a);
        expect(plain(w.new)).toBe(b);
        expect(w.old.includes('**')).toBe(false);
        expect(/(^|[^\\])~~/.test(w.new)).toBe(false);
      })
    );
  });

  it('marks nothing when the text is unchanged', () => {
    fc.assert(
      fc.property(fc.string(), (a) => {
        expect(wordDiff(a, a)).toEqual({ old: escapeMd(a), new: escapeMd(a) });
      })
    );
  });

  it('marks the words that changed', () => {
    expect(wordDiff('the ir-id of a note', 'the ID of a note')).toEqual({
      old: 'the ~~ir-id~~ of a note',
      new: 'the **ID** of a note',
    });
  });
});
