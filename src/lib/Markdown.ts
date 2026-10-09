/** Assumes that the bullet's indent level has been validated */
const BULLET_ITEM_PATTERN = /^(\s*(?:-|\d+\.)\s)(\s*\[.\]\s)?(.*)/;

/** Location of footnote text, which must be preceded by a newline and may have list and checkbox formatting. */
// const FOOTNOTE_PATTERN = /\n\s*?((?:-|\d\.)\s*?)?(\[.\]\s)?\[\^([\w\d]+)\]:/g;

/** link to a footnote defined elsewhere */
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([\w\d]+)\](?!:)/g;

// const INLINE_FOOTNOTE_PATTERN = /\^\[([\w\d]+)\]/g;

/** Embedded note: `![[target]]`, `![[target#heading|alias]]` */
const EMBED_PATTERN = /!\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;

/** Wikilink: `[[target]]`, `[[target|alias]]` */
const WIKILINK_PATTERN = /\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g;

/** Image, inline or by reference: `![alt](url)`, `![alt][ref]` */
const IMAGE_PATTERN = /!\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;

/** Link, inline or by reference: `[label](url)`, `[label][ref]` */
const LINK_PATTERN = /\[([^\]]*)\](?:\([^)]*\)|\[[^\]]*\])/g;

/** Keeps the label of a pattern that captures one. `replace` types its
 * replacer's groups as `any`, so they are annotated here rather than inline. */
const keepLabel = (_match: string, label: string) => label;

/** Keeps the alias of a wikilink-shaped pattern, or its target when it has
 * no alias. An empty alias — `[[Note|]]` — stays empty. */
const keepAliasOrTarget = (_match: string, target: string, alias?: string) =>
  alias ?? target;

/**
 * The HTML entities a browser decodes without their `;`, even as the start of
 * a longer word (`&notice` reads `¬ice`): a fixed list in the HTML standard.
 * Obsidian's reading view decodes them so, case and all (`&AMP`, not `&Amp`).
 */
export const LEGACY_ENTITIES: readonly string[] = (
  'AElig AMP Aacute Acirc Agrave Aring Atilde Auml COPY Ccedil ETH Eacute ' +
  'Ecirc Egrave Euml GT Iacute Icirc Igrave Iuml LT Ntilde Oacute Ocirc ' +
  'Ograve Oslash Otilde Ouml QUOT REG THORN Uacute Ucirc Ugrave Uuml Yacute ' +
  'aacute acirc acute aelig agrave amp aring atilde auml brvbar ccedil ' +
  'cedil cent copy curren deg divide eacute ecirc egrave eth euml frac12 ' +
  'frac14 frac34 gt iacute icirc iexcl igrave iquest iuml laquo lt macr ' +
  'micro middot nbsp not ntilde oacute ocirc ograve ordf ordm oslash otilde ' +
  'ouml para plusmn pound quot raquo reg sect shy sup1 sup2 sup3 szlig ' +
  'thorn times uacute ucirc ugrave uml uuml yacute yen yuml'
).split(' ');

/**
 * The characters escaped wherever they are. Obsidian reads each as syntax
 * even where CommonMark wouldn't: a lone backtick as code in live preview, a
 * `*` between spaces as emphasis in reading view, and a bare `[x]` as a link
 * in live preview. `]` is never escaped: with every `[` escaped, nothing it
 * closes can open.
 */
const ALWAYS = new Set('`*[|');

/** The characters that are syntax only doubled: comments, highlights, strikethrough. */
const DOUBLED = new Set('%=~');

/**
 * The characters some rule escapes only beside others. Beside an end of an
 * answer, where a cloze delimiter or the hidden answer's `<mark>` will stand,
 * the neighbour is unknown, and they are escaped there regardless.
 */
const CONTEXTUAL = new Set('\\{})#$<^%=~_&@:./-+');

const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * A character of a word, as Obsidian's emphasis reads one: `_` between two is
 * never emphasis. Only ASCII: a letter of any other script closes it.
 */
const WORD_CHAR = /[A-Za-z\d]/;

/**
 * What can't end an email address's name before its `@`: reading view takes
 * only ASCII there, but live preview takes any character but these.
 */
const NOT_ADDRESS_LOCAL = /[\s<>()[\]\\,;:@"]/;
/** A character that can start an email address's domain. */
const ADDRESS_DOMAIN = /[\w.-]/;

/**
 * A URI scheme live preview links when a `:` and then a letter, digit, `%` or
 * `/` follow it, as `doi:10.1000/1` or `tel:555`. Undocumented: the list in
 * the URL pattern of Obsidian 1.13.7's live preview, which also links a
 * `www.` host with up to three digits after `www`, and a domain name before
 * a `/`, as `arxiv.org/abs`. A scheme is matched at the end of the text
 * before the `:`, wherever its word starts.
 */
export const URI_SCHEME =
  /(?:aaas?|about|acap|adiumxtra|af[ps]|aim|apt|attachment|aw|beshare|bitcoin|bolo|callto|cap|chrome(?:-extension)?|cid|coap|com-eventbrite-attendee|content|crid|cvs|data|dav|dict|dlna-(?:playcontainer|playsingle)|dns|doi|dtn|dvb|ed2k|facetime|feed|file|finger|fish|ftp|geo|gg|git|gizmoproject|go|gopher|gtalk|h323|hcp|https?|iax|icap|icon|im|imap|info|ipn|ipp|irc[6s]?|iris(?:\.beep|\.lwz|\.xpc|\.xpcs)?|itms|jar|javascript|jms|keyparc|lastfm|ldaps?|magnet|mailto|maps|market|message|mid|mms|ms-help|msnim|msrps?|mtqp|mumble|mupdate|mvn|news|nfs|nih?|nntp|notes|oid|opaquelocktoken|palm|paparazzi|platform|pop|pres|proxy|psyc|query|res(?:ource)?|rmi|rsync|rtmp|rtsp|secondlife|service|session|sftp|sgn|shttp|sieve|sips?|skype|sm[bs]|snmp|soap\.beeps?|soldat|spotify|ssh|steam|svn|tag|teamspeak|tel(?:net)?|tftp|things|thismessage|tip|tn3270|tv|udp|unreal|urn|ut2004|vemmi|ventrilo|view-source|webcal|wss?|wtai|wyciwyg|xcon(?:-userid)?|xfire|xmlrpc\.beeps?|xmpp|xri|ymsgr|z39\.50[rs]?)$/i;

/** The longest text {@link URI_SCHEME} needs before a `:`. */
const LONGEST_SCHEME = 32;

const isLineBreak = (char: string) => char === '\n' || char === '\r';

/** JavaScript's whitespace, which is what Obsidian takes for it. */
const isBlank = (char: string) => /\s/.test(char);

/** The rest of the line in `text` from `i`, without its line break. */
const restOfLine = (text: string, i: number) =>
  text.slice(i).split(/[\r\n]/, 1)[0];

/**
 * Whether the character before `i` in `text` is a backslash that escapes the
 * one at `i`: the last of an odd run of them.
 */
function escapesNext(text: string, i: number): boolean {
  let run = 0;
  while (text[i - 1 - run] === '\\') run++;
  return run % 2 === 1;
}

/**
 * The index of the character in `text` that marks the line starting at `i` as
 * a list item, a rule or a heading's underline, if any: `-` or `+` before
 * whitespace (of any kind: live preview takes them all), the `.` or `)` of
 * `N.` or `N)` before whitespace, or the first of a line of only `-` and `=`.
 *
 * @param endsMarker whether what is at an index lets a marker end there
 */
function markerAt(
  text: string,
  i: number,
  endsMarker: (index: number) => boolean
): number | undefined {
  const line = restOfLine(text, i);
  // It starts with what isn't whitespace: `-` or `=`, if this holds
  if (/^[-=\s]*$/.test(line)) return i;
  const char = text[i];
  if ((char === '-' || char === '+') && endsMarker(i + 1)) return i;
  const number = /^\d+[.)]/.exec(line);
  if (!number) return undefined;
  const end = i + number[0].length - 1;
  return endsMarker(end + 1) ? end : undefined;
}

/**
 * What can stand before a block on its line and still let it start there:
 * up to three spaces of indent (more is code, or a paragraph's lazy
 * continuation), quote markers, list markers before whitespace, and a
 * task's checkbox. `- # x` holds a heading, `> - x` a list.
 */
const CONTAINERS = /^ {0,3}(?:(?:>|(?:[-+*]|\d+[.)])\s(?:\s*\[.\]\s)?)\s*)*$/;

/** Whether what stands at `i` in `text` starts a block, as at a line's start. */
function startsBlock(text: string, i: number): boolean {
  const lineStart =
    Math.max(text.lastIndexOf('\n', i - 1), text.lastIndexOf('\r', i - 1)) + 1;
  return CONTAINERS.test(text.slice(lineStart, i));
}

/**
 * The indices of what makes the line starting at `i` in `text` a block that
 * text cut from mid-line would start without being one in its source:
 * besides {@link markerAt}'s, a quote, a heading, a `*` list, a `*` or `_`
 * rule, a code fence, and a link or footnote definition. An escaped note
 * escapes every `*`, `` ` ``, `[` and doubled `~`; an ordinary note holds them
 * bare.
 */
function blockMarks(text: string, i: number): number[] {
  const line = restOfLine(text, i);
  if (line === '') return [];
  const marker = markerAt(text, i, (index) => isBlank(text[index] ?? ' '));
  if (marker !== undefined) return [marker];
  // A backtick fence's info string holds no backtick. Read the run once:
  // a lookahead after `{3,} retries the rest of the line at each length
  const backticks = /^`{3,}/.exec(line)?.[0].length;
  const block =
    line[0] === '>' ||
    /^#{1,6}(?:\s|$)/.test(line) ||
    (backticks !== undefined && !line.includes('`', backticks)) ||
    line.startsWith('~~~') ||
    (line[0] === '*' && isBlank(line[1] ?? ' ')) ||
    /^([*_])(?:\s*\1){2,}\s*$/.test(line) ||
    /^\[[^\]]+\]:/.test(line);
  return block ? [i] : [];
}

/** A line from where the search starts, and the line break after it, if any. */
const LINE = /([^\r\n]*)(\r\n?|\n)?/y;

/** The line of `text` that starts at `i`, without its line break. */
function lineAt(text: string, i: number): string {
  LINE.lastIndex = i;
  return LINE.exec(text)![1];
}

/**
 * The index in `text` where the line holding `i` starts. Read back along the
 * line only: a search for each kind of line break could read to the start.
 */
function lineStartOf(text: string, i: number): number {
  let start = i;
  while (start > 0 && !isLineBreak(text[start - 1])) start--;
  return start;
}

/**
 * Where the content of a line starts past its quote and list markers, in any
 * order and to any depth (`- > - x`): its index, how deep in quotes it is,
 * whether a list marker comes after the last quote, and, in columns past
 * that quote (a tab reaching the next multiple of four), where the content
 * starts and where the whitespace right after the quote ends.
 */
type LineContent = {
  at: number;
  quotes: number;
  listed: boolean;
  column: number;
  indent: number;
  /** Whether a list marker comes anywhere before it. */
  inList: boolean;
};

/** A list marker before whitespace, at the start of what is searched. */
const LIST_MARKER = /(?:[-+*]|\d{1,9}[.)])[ \t]+/y;

/** A fence's run, at the start of what is searched. */
const FENCE_RUN = /`{3,}|~{3,}/y;

/**
 * Where the content of `line` starts: see {@link LineContent}. A `>` after
 * more than three columns of indent at its start is a quote's only in a list
 * item, `inList`, whose lines indent it so (`1.  > x` over `    > y`);
 * elsewhere it is code's, or text's.
 */
function contentOf(line: string, inList = false): LineContent {
  let at = 0;
  let quotes = 0;
  let base = 0;
  let listed = false;
  let marked = false;
  for (;;) {
    let next = at;
    while (line[next] === ' ' || line[next] === '\t') next++;
    if (
      line[next] === '>' &&
      (inList || at > 0 || columnsOf(line, 0, next) <= 3)
    ) {
      quotes++;
      at = next + 1;
      // The space or tab after a `>` is its own
      if (line[at] === ' ' || line[at] === '\t') at++;
      base = at;
      listed = false;
      continue;
    }
    LIST_MARKER.lastIndex = next;
    if (!LIST_MARKER.test(line)) {
      at = next;
      break;
    }
    listed = true;
    marked = true;
    at = LIST_MARKER.lastIndex;
  }
  let indent = base;
  while (line[indent] === ' ' || line[indent] === '\t') indent++;
  return {
    at,
    quotes,
    listed,
    column: columnsOf(line, base, at),
    indent: columnsOf(line, base, Math.min(indent, at)),
    inList: marked || inList,
  };
}

/**
 * How many columns `line` takes from `from` to `to`, a tab reaching the
 * next multiple of four.
 */
function columnsOf(line: string, from: number, to: number): number {
  let column = 0;
  for (let k = from; k < to; k++) {
    column = line[k] === '\t' ? column + 4 - (column % 4) : column + 1;
  }
  return column;
}

/**
 * A fence that could open or close a fenced code block: its run, where it
 * stands (see {@link LineContent}), and what follows it on its line.
 */
type Fence = LineContent & { run: string; rest: string };

/**
 * The fence `line` holds, if any, past quote and list markers, in a list
 * item if `inList` (see {@link contentOf}).
 */
function fenceOf(line: string, inList = false): Fence | undefined {
  const content = contentOf(line, inList);
  FENCE_RUN.lastIndex = content.at;
  const run = FENCE_RUN.exec(line)?.[0];
  if (run === undefined) return undefined;
  return { ...content, run, rest: line.slice(content.at + run.length) };
}

/**
 * Where what follows its `<!--` starts, if `line` opens an HTML block with
 * a comment, which reading view and the cache read as no Markdown to its end,
 * in a list or quote too (the probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts); -1 if it doesn't.
 */
function commentAt(line: string): number {
  const content = contentOf(line);
  return (content.listed || content.column <= 3) &&
    line.startsWith('<!--', content.at)
    ? content.at + 4
    : -1;
}

/**
 * The fence `line` opens a code block with, if any: indented less than code
 * unless list markers hold it, and for backticks, no backtick after it.
 */
function opensFence(line: string): Fence | undefined {
  const fence = fenceOf(line);
  if (
    !fence ||
    (!fence.listed && fence.column > 3) ||
    (fence.run[0] === '`' && fence.rest.includes('`'))
  ) {
    return undefined;
  }
  return fence;
}

/**
 * Whether `line` closes the code block `open` opened, as Obsidian 1.13.7
 * reads it (the probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts): a fence of its char, as long or longer
 * and alone, in as many quotes, with no list marker, and indented as its
 * opener's list item holds it, or less than code.
 */
function closesFence(line: string, open: Fence): boolean {
  const fence = fenceOf(line, open.inList);
  return (
    !!fence &&
    !fence.listed &&
    fence.quotes === open.quotes &&
    fence.run[0] === open.run[0] &&
    fence.run.length >= open.run.length &&
    fence.rest.trim() === '' &&
    (open.listed
      ? fence.column >= open.column && fence.column <= open.column + 3
      : fence.column <= 3)
  );
}

/**
 * Whether `line` ends the quote or list item a code block was opened in,
 * and with it the block: code holds no lazy line.
 */
function leavesFence(line: string, open: Fence): boolean {
  if (line.trim() === '') return false;
  const { quotes, indent } = contentOf(line, open.inList);
  return quotes < open.quotes || (open.listed && indent < open.column);
}

/**
 * The fenced code block left open after `line`, `open` before it: closed by
 * its closing fence, ended by a line out of the quote or list item it was
 * opened in (which may open another), or opened by `line`.
 */
function readFence(open: Fence | undefined, line: string): Fence | undefined {
  if (open === undefined) return opensFence(line);
  if (closesFence(line, open)) return undefined;
  return leavesFence(line, open) ? opensFence(line) : open;
}

/**
 * Whether `line` is code in the block `open`, open before it: not its
 * closing fence, nor a line out of the quote or list item it was opened in.
 */
const inBlock = (open: Fence | undefined, line: string) =>
  open !== undefined && !closesFence(line, open) && !leavesFence(line, open);

/** The fenced code block open before the line starting at `lineStart` in `source`, if any. */
function fenceBefore(source: string, lineStart: number): Fence | undefined {
  let open: Fence | undefined;
  for (let i = 0; i < lineStart; ) {
    LINE.lastIndex = i;
    const [whole, line] = LINE.exec(source)!;
    open = readFence(open, line);
    i += whole.length;
  }
  return open;
}

/**
 * Whether the line starting at `lineStart` in `source` lies in a fenced code
 * block opened above it: never closed, it runs to the end. Its closing fence
 * is no code, nor is a line that leaves the quote or list item it was opened
 * in.
 */
const inFence = (source: string, lineStart: number) =>
  inBlock(fenceBefore(source, lineStart), lineAt(source, lineStart));

/**
 * Whether index `k` of `line` lies inside inline code, math or an HTML
 * comment on it, delimiters aside, as Obsidian 1.13.7 reads them (the
 * probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts): whichever opens first holds what follows
 * to its closer, other delimiters included. Code is a run of backticks to
 * the next run as long; math a `$` before what isn't whitespace to the next
 * `$` after what isn't a space or a tab nor before a digit, or `$$` to
 * `$$`; a comment `<!--` to `-->`. A delimiter never closed is text, as is
 * one escaped. Spans over several lines are not seen. A `%%` comment is left
 * out: the metadata cache reads a tag in one, so it was one in the source
 * too.
 */
function inInlineSpan(line: string, k: number): boolean {
  // The starts of each length of backtick run, in order, and how far each
  // list has been read: openers are met in order, so each is read once
  const runs = new Map<number, { starts: number[]; read: number }>();
  for (let i = 0; i < line.length; ) {
    const start = i;
    while (line[i] === '`') i++;
    if (i === start) {
      i++;
      continue;
    }
    const list = runs.get(i - start) ?? { starts: [], read: 0 };
    list.starts.push(start);
    runs.set(i - start, list);
  }
  const runAfter = (from: number, length: number) => {
    const list = runs.get(length);
    if (!list) return -1;
    while ((list.starts[list.read] ?? Infinity) < from) list.read++;
    return list.starts[list.read] ?? -1;
  };
  // The first `$` at or after each index that could close math
  const closer = new Int32Array(line.length + 1).fill(-1);
  let slashes = 0;
  const escaped: boolean[] = [];
  for (let j = 0; j < line.length; j++) {
    escaped.push(slashes % 2 === 1);
    slashes = line[j] === '\\' ? slashes + 1 : 0;
  }
  for (let j = line.length - 1; j > 0; j--) {
    const closes =
      line[j] === '$' &&
      !escaped[j] &&
      !/[ \t]/.test(line[j - 1]) &&
      !/\d/.test(line[j + 1] ?? '');
    closer[j] = closes ? j : closer[j + 1];
  }
  // Where a search for a comment's closer found none, to the line's end:
  // openers after it are not searched again
  let unclosed = Infinity;
  // A span that holds `k` opens before it
  for (let i = 0; i < k; ) {
    const char = line[i];
    const next = line[i + 1] ?? '';
    if (char === '\\' && ASCII_PUNCTUATION.test(next)) {
      i += 2;
      continue;
    }
    let open = 1;
    let close = -1;
    // Its closer's length, where it isn't its opener's
    let shut = 0;
    if (char === '`') {
      while (line[i + open] === '`') open++;
      close = runAfter(i + open, open);
    } else if (char === '$' && next === '$') {
      // Where none is found, none is left to open another
      open = 2;
      close = line.indexOf('$$', i + 2);
    } else if (char === '$' && !isBlank(next || ' ')) {
      close = closer[i + 1];
    } else if (line.startsWith('<!--', i)) {
      open = 4;
      shut = 3;
      if (i < unclosed) {
        close = line.indexOf('-->', i + 4);
        if (close < 0) unclosed = i;
      }
    }
    if (close < 0) {
      i += open;
    } else if (k < close) {
      return k >= i + open;
    } else {
      i = close + (shut || open);
    }
  }
  return false;
}

/**
 * Whether `at` in `source` lies in code, math or an HTML comment, where
 * nothing shows as syntax: a fenced code block above, a line that opens
 * with a comment, or a span on its line (see {@link inInlineSpan}).
 */
function inCode(source: string, at: number): boolean {
  const lineStart = lineStartOf(source, at);
  const line = lineAt(source, lineStart);
  const comment = commentAt(line);
  return (
    inFence(source, lineStart) ||
    // A line that opens with a comment is an HTML block, to its end
    (comment >= 0 && at - lineStart >= comment) ||
    inInlineSpan(line, at - lineStart)
  );
}

/**
 * A line that could underline the one before into a heading, in live
 * preview at least: a run of `-` or of `=`, indented less than code.
 */
const UNDERLINE = /^ {0,3}(?:-+|=+)[ \t]*$/;

/**
 * A heading by `#`, and a rule. Reading view takes no rule, nor underline,
 * with a tab after it: `---\t` is text (the probe "reads tags in spans, and
 * underlines…" in e2e-tests/child-start.spec.ts).
 */
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,} *$/;

/** An underline as reading view and the cache take one: unindented, nothing after it. */
const READ_UNDERLINE = /^(?:-+|=+)$/;

/** A line that starts a block other than a paragraph, or holds a list or a quote, but for a fence. */
const NO_PARAGRAPH =
  /^ {0,3}(?:>|[-+*](?:\s|$)|\d{1,9}[.)](?:\s|$)|\[[^\]]+\]:)/;

/**
 * A link or footnote definition, which starts no block in a paragraph, and
 * is its text there.
 */
const DEFINITION = /^ {0,3}\[[^\]]+\]:/;

/** Whether `line` is indented as code: by four spaces or more, a tab, or other whitespace. */
const isIndented = (line: string) =>
  line.trim() !== '' && !/^ {0,3}\S/.test(line);

/** Whether `line` can be a paragraph's: indented less than code, and starting no other block. */
const isParagraphLine = (line: string) =>
  /^ {0,3}\S/.test(line) &&
  !NO_PARAGRAPH.test(line) &&
  !ATX.test(line) &&
  !RULE.test(line) &&
  opensFence(line) === undefined;

/**
 * Whether `line` is an HTML block of a comment closed on it, which ends a
 * paragraph above it, as `<!-- c --> x` doesn't. Reading view still
 * underlines it into a heading, as a paragraph (the probe "reads tags in
 * spans, and underlines…" in e2e-tests/child-start.spec.ts).
 */
const isCommentBlock = (line: string) =>
  commentAt(line) >= 0 && line.trimEnd().endsWith('-->');

/**
 * A line that starts an HTML block that interrupts a paragraph: one of
 * CommonMark's type-6 tags, opening or closing, of any case, as Obsidian
 * 1.13.7 reads them (but `search`; see the probe "reads tags in spans, and
 * underlines…" in e2e-tests/child-start.spec.ts). The lines after it to a
 * blank line are the block's, which no underline makes a heading.
 */
const HTML_BLOCK =
  /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[\s>]|\/>|$)/i;

/**
 * How a paragraph stands, past the lines read so far: the lines of the one
 * open, or one of these (the probe "reads tags in spans, and underlines…" in
 * e2e-tests/child-start.spec.ts has what Obsidian 1.13.7 reads).
 */
const NO_PARAGRAPH_OPEN = 0;
/** A list or quote's lines, lazy ones too, which nothing underlines. */
const IN_LIST = -1;
/** An HTML block's lines, to a blank line, which nothing underlines. */
const IN_HTML = -2;
/**
 * Past a comment alone on its line, which a line of `-` or `=` underlines as
 * a paragraph of one line, and which ends what it was in.
 */
const AFTER_COMMENT = -3;
/**
 * Past a line that opens an HTML block where no paragraph was open, which a
 * line of `-` or `=` underlines as a paragraph of one line; the block holds
 * any other line after it.
 */
const AFTER_HTML = -4;

/**
 * How a paragraph stands after `line`, not in code, `open` before it: the
 * lines of the one open, or {@link NO_PARAGRAPH_OPEN}, {@link IN_LIST},
 * {@link IN_HTML}, {@link AFTER_COMMENT} or {@link AFTER_HTML}.
 */
function readParagraph(open: number, line: string): number {
  if (line.trim() === '') return NO_PARAGRAPH_OPEN;
  if (open === IN_HTML) return IN_HTML;
  const underlines =
    open === 1 || open === AFTER_COMMENT || open === AFTER_HTML;
  // A heading of a paragraph of one line, which it ends
  if (underlines && READ_UNDERLINE.test(line)) return NO_PARAGRAPH_OPEN;
  if (open === AFTER_HTML) return IN_HTML;
  const before = open === AFTER_COMMENT ? NO_PARAGRAPH_OPEN : open;
  if (ATX.test(line) || RULE.test(line) || opensFence(line) !== undefined) {
    return NO_PARAGRAPH_OPEN;
  }
  if (isCommentBlock(line)) return AFTER_COMMENT;
  // Code where no paragraph is open, a paragraph's text where one is
  if (isIndented(line)) return before > 0 ? before + 1 : before;
  if (HTML_BLOCK.test(line)) {
    return before === NO_PARAGRAPH_OPEN ? AFTER_HTML : IN_HTML;
  }
  // A paragraph's text in one; unprobed after none, where what follows is
  // taken for its paragraph's, which nothing underlines
  if (DEFINITION.test(line)) {
    return before >= 0 ? Math.max(before + 1, 2) : before;
  }
  if (!isParagraphLine(line)) return IN_LIST;
  return before >= 0 ? before + 1 : before;
}

/**
 * Where `line` stands in a paragraph, `open` before it (see
 * {@link readParagraph}), `code` if it is code: its first line, which an
 * underline makes a heading in reading view, the metadata cache and live
 * preview alike; a later line, which only live preview underlines; or
 * neither, as a line of code, a list or quote, an HTML block, an underline,
 * or of none.
 */
function paragraphState(
  open: number,
  line: string,
  code: boolean
): 'first' | 'later' | 'none' {
  if (code || open === IN_HTML || open === AFTER_HTML) return 'none';
  // The underline of a heading is no paragraph's
  const underlines = open === 1 || open === AFTER_COMMENT;
  if (underlines && READ_UNDERLINE.test(line)) return 'none';
  if (isCommentBlock(line)) return 'first';
  const before = open === AFTER_COMMENT ? NO_PARAGRAPH_OPEN : open;
  if (before === IN_LIST) return 'none';
  if (HTML_BLOCK.test(line)) return before === 0 ? 'first' : 'none';
  // A paragraph's later line may be indented, or a definition
  const text =
    isParagraphLine(line) ||
    (before > 0 && (isIndented(line) || DEFINITION.test(line)));
  if (!text) return 'none';
  return before === 0 ? 'first' : 'later';
}

/**
 * How a paragraph and a fenced code block stand before the line starting at
 * `lineStart` in `source`, read down from its start.
 */
function stateBefore(source: string, lineStart: number) {
  let open = NO_PARAGRAPH_OPEN;
  let fence: Fence | undefined;
  for (let i = 0; i < lineStart; ) {
    LINE.lastIndex = i;
    const [whole, line] = LINE.exec(source)!;
    open = inBlock(fence, line) ? NO_PARAGRAPH_OPEN : readParagraph(open, line);
    fence = readFence(fence, line);
    i += whole.length;
  }
  return { open, fence };
}

/**
 * Where a character stands in the escaped note, as the rules need to know.
 */
type Context = {
  /**
   * The character before it as the escaped note reads: a line break, not the
   * whitespace dropped after one, or `''` at the start.
   */
  prev: string;
  /** Whether it is the first character its line keeps. */
  atLineStart: boolean;
  /** Whether the character before it is escaped. */
  afterEscape: boolean;
  /** Whether an end of an answer lies in an index range, both ends in. */
  boundaryWithin: (from: number, to: number) => boolean;
  /** Whether no whitespace follows an index before its line ends. */
  isLastWord: (from: number) => boolean;
};

/**
 * Whether the character at `i` in `text` has to be escaped to read as itself,
 * line markers aside (see {@link markerAt}).
 */
function isSyntax(text: string, i: number, context: Context): boolean {
  const { prev, atLineStart } = context;
  const char = text[i];
  const next = text[i + 1] ?? '';
  const after = text.slice(i + 1);
  if (ALWAYS.has(char)) return true;
  if (DOUBLED.has(char) && (prev === char || next === char)) return true;
  switch (char) {
    // An escape, or a hard line break
    case '\\':
      return next === '' || isLineBreak(next) || ASCII_PUNCTUATION.test(next);
    // The cloze delimiters, `(}` and `{)`, and the old `{{` and `}}`: an
    // escape inside each hides it from the plugin, which reads them as text
    case '}':
      return prev === '(' || prev === '}';
    case '{':
    case ')':
      return prev === '{';
    case '#':
      return (
        atLineStart ||
        isTagStart(
          text,
          i,
          isBlank(prev) || context.afterEscape,
          context.boundaryWithin
        )
      );
    // Math closes at a `$` after anything but a space or a tab, even a line
    // break: one after a space opens, and only display math, `$$`, needs no
    // closer of that kind
    case '$':
      return !(prev === ' ' && next !== '$');
    // HTML, comments, declarations and autolinks
    // Reading view links `<` before an escape too (`<\<https\://e.x>`), so
    // only what no tag, comment or link starts with is left: whitespace, a
    // digit, `=` or `-`, as in `x < 5`, `<5`, `<=` and `<-`
    case '<':
      return !(next === '' || /[\s\d=-]/.test(next));
    case '>':
      return atLineStart;
    // An inline footnote, or a block id: the last word of its line
    case '^':
      return next === '[' || context.isLastWord(i + 1);
    // Templater runs `<% … %>` in a note it sees made, escaped or not
    case '%':
      return prev === '<';
    case '_':
      return !(WORD_CHAR.test(prev) && WORD_CHAR.test(next));
    // An entity, by number, by name with its `;`, or one of those a browser
    // reads without
    case '&':
      return (
        next === '#' ||
        /^[A-Za-z][A-Za-z\d]*;/.test(after) ||
        LEGACY_ENTITIES.some((name) => after.startsWith(name))
      );
    case '@':
      return (
        prev !== '' &&
        !NOT_ADDRESS_LOCAL.test(prev) &&
        ADDRESS_DOMAIN.test(next)
      );
    // A scheme's `://` or `scheme:x`, and a Dataview field's `::`
    case ':':
      return (
        prev === ':' ||
        next === ':' ||
        after.startsWith('//') ||
        // One slash links too, as `javascript:/x/` or `https:/e.x`
        (/[a-z\d%/]/i.test(next) &&
          URI_SCHEME.test(text.slice(Math.max(0, i - LONGEST_SCHEME), i)))
      );
    // Obsidian links `www.` even inside a word, and `www1.` to `www999.`
    case '.':
      return /www\d{0,3}$/i.test(text.slice(Math.max(0, i - 6), i));
    // A domain name before a `/` is a link in live preview: `arxiv.org/abs`
    case '/':
      return /[a-z\d.-]\.[a-z]{2,4}$/i.test(text.slice(Math.max(0, i - 6), i));
    default:
      return false;
  }
}

/**
 * Whether the `#` at `i`, not at the start of its line, could start a tag:
 * one `afterBlank`, after whitespace or after an escape (reading view starts
 * a tag there too), before a character a tag can hold. Obsidian doesn't read
 * a number as a tag, so `#1` before whitespace, `,`, `.`, `)` or `\` is
 * left, unless an end of the answer could change what follows it. A tag
 * stops at a `\`: Obsidian 1.13.7's own tag pattern, in its app.js, leaves
 * it out (an internal, not a documented API).
 */
function isTagStart(
  text: string,
  i: number,
  afterBlank: boolean,
  boundaryWithin: Context['boundaryWithin']
): boolean {
  // The end of the text ends a tag as whitespace does
  if (!afterBlank || isBlank(text[i + 1] ?? ' ')) {
    return false;
  }
  const number = /^\d+/.exec(text.slice(i + 1));
  if (!number) return true;
  const end = i + 1 + number[0].length;
  return (
    !/^(?:[\s,.)\\]|$)/.test(text.slice(end)) || boundaryWithin(i + 2, end)
  );
}

/**
 * `text` escaped to read as plain text, and where each of its characters
 * went, by index: one past the last for `text.length`. The ends of an answer
 * are `boundaries`, offsets in `text`. See {@link Markdown.escape}.
 */
function escapeWithMap(
  text: string,
  boundaries: readonly number[] = []
): { text: string; at: number[] } {
  const boundaryWithin = (from: number, to: number) =>
    boundaries.some((boundary) => boundary >= from && boundary <= to);
  // The end of the text ends a marker as whitespace does
  const endsMarker = (index: number) =>
    isBlank(text[index] ?? ' ') || boundaries.includes(index);
  /** The index of the first whitespace at or after the last index asked about. */
  let blank = -1;
  // Asked in order along the text, so each stretch is searched once
  const isLastWord = (from: number) => {
    if (blank < from) {
      const search = /\s/g;
      search.lastIndex = from;
      blank = search.exec(text)?.index ?? text.length;
    }
    return blank === text.length || isLineBreak(text[blank]);
  };
  let out = '';
  const at: number[] = [];
  let lineStart = true;
  /** The index of the last character kept, a line break included. */
  let kept = -1;
  /**
   * Whether the last character kept, not a line break, was escaped. Only a
   * `#` within a line asks, so it is never read at the start of one.
   */
  let afterEscape = false;
  /** The index of the character that marks a list item, if any. */
  let marker: number | undefined;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    at.push(out.length);
    // CommonMark ends a line at a carriage return too
    if (isLineBreak(char)) {
      out += char;
      lineStart = true;
      kept = i;
      continue;
    }
    // Indented text is code, in live preview by whitespace of any kind, and
    // less indent shows nothing
    if (lineStart && isBlank(char)) continue;
    const atLineStart = lineStart;
    if (lineStart) {
      lineStart = false;
      marker = markerAt(text, i, endsMarker);
    }
    const prev = kept < 0 ? '' : text[kept];
    const besideBoundary =
      boundaryWithin(kept + 1, i) || boundaries.includes(i + 1);
    const escapes: boolean =
      i === marker ||
      (besideBoundary && CONTEXTUAL.has(char)) ||
      isSyntax(text, i, {
        prev,
        atLineStart,
        afterEscape,
        boundaryWithin,
        isLastWord,
      });
    out += escapes ? `\\${char}` : char;
    afterEscape = escapes;
    kept = i;
  }
  at.push(out.length);
  return { text: out, at };
}

/** Utilities for parsing Obsidian-flavored Markdown */
export class Markdown {
  /**
   * `text` escaped so that it reads as itself, as plain text, wherever it is
   * put in a note: nothing in it becomes a link, an embed, a tag, a heading,
   * a list, HTML, math or any other syntax, Templater runs none of it, and
   * the cloze delimiters are never in it. Each character Obsidian would read
   * as syntax where it stands gets a backslash, which only hides; whitespace
   * that starts a line, which shows nothing, is dropped.
   *
   * Only what could form syntax is escaped, so that the note is found by
   * searching for most of the PDF's text: `C#`, `#1`, `$5` after a space,
   * `x < 5`, `AT&T`, `-5` and `1.5` starting a line stay as they are. Where
   * the rules come from: task 0032's audit of Obsidian 1.13.7.
   */
  static escape(text: string): string {
    return escapeWithMap(text).text;
  }

  /**
   * {@link escape} `text`, and find where `range`, offsets in `text`, lies in
   * what it escapes to: a character's escape goes with it. What a rule could
   * escape beside either end of the range is escaped there, since a cloze
   * delimiter will stand beside it.
   */
  static escapeAround(
    text: string,
    [start, end]: readonly [number, number]
  ): { text: string; range: [number, number] } {
    const escaped = escapeWithMap(text, [start, end]);
    return { text: escaped.text, range: [escaped.at[start], escaped.at[end]] };
  }

  /**
   * `[from, to]`, a selection in `text`, widened so that neither end falls
   * between a backslash and the ASCII punctuation it escapes: a start moves
   * back before the backslash, an end past the escaped char. Text taken from
   * the selection then reads as it did in `text`. Split, it would start with
   * bare syntax (`#tag` of `\#tag`) or end in a backslash that escapes
   * whatever comes after it.
   *
   * A backslash escapes only when an even run of them comes before it, so
   * the `#` of `\\#` is no escape's.
   *
   * Code spans and blocks are snapped too, though a backslash in them is
   * literal: text cut from one at a selection edge is no longer code there.
   *
   * @param options.delimited the selection is a card's answer, which a cloze
   *   delimiter will open: its start moves back off a backslash before
   *   anything, punctuation or not, which would otherwise escape the
   *   delimiter (`C:\(} Users {)`), and with it the hidden answer's `<mark>`.
   */
  static snapOffEscapes(
    text: string,
    [from, to]: readonly [number, number],
    { delimited = false }: { delimited?: boolean } = {}
  ): [number, number] {
    const splits = (at: number) =>
      escapesNext(text, at) && ASCII_PUNCTUATION.test(text[at] ?? '');
    const start =
      (delimited && escapesNext(text, from)) || splits(from) ? from - 1 : from;
    return [start, splits(to) ? to + 1 : to];
  }

  /**
   * The text from `from` to `to` in `source`, a note's source, cut out to
   * start a new note (`'note'`: a snippet, or a card's text before its
   * answer), or to stand after a cloze delimiter and a space (`'answer'`),
   * with its start escaped where it would form syntax that it didn't form in
   * `source`. Escaped text leaves some characters bare where they form
   * nothing (`word#evil`), and cut from mid-line, they could: `#evil` alone
   * is a tag, `# x` a heading, `> x` a quote, `- x` and `1. x` lists, and an
   * ordinary note's `* x`, `***`, a fence or `[a]: x` blocks of their own.
   * What `source` formed there is kept: `#tag` cut from `see #tag` is still a
   * tag, as it was. Run it after {@link snapOffEscapes}; a start that splits
   * an escape pair is escaped again all the same.
   *
   * Only the start changes: whitespace from mid-line that would start a note,
   * and indent it, is dropped, and the first char is escaped if it needs it,
   * as is what follows an escape that would form a tag after it (reading view
   * starts one there: `\##tag`). The rest of the cut reads as it did: run
   * {@link escapeCutUnderline} on a note made of it, whose second line could
   * underline its first. A cut that starts a block in `source`, at the start
   * of its line, after list and quote markers, or inside the number of a
   * list's, is escaped nowhere.
   *
   * Cut from mid-line inside inline code, math or an HTML comment on its
   * line, a line that opens with a comment, or a fenced code block, its
   * start was no syntax at all, and is escaped wherever it would form some:
   * `#tag` of `` `see #tag` `` is no tag. A tag in a `%%` comment
   * was one, as the metadata cache reads it.
   *
   * Left bare: a `$` out of code, since math opens after anything in
   * Obsidian, and one that closed math leaves its pair split, as an end
   * does (`$a$b c$` from the second `$`); the rest of a span cut in half;
   * spans over several lines, which the line scan doesn't see; a cut from
   * the start of a line in a code block.
   */
  static escapeCutStart(
    source: string,
    [from, to]: readonly [number, number],
    into: 'note' | 'answer'
  ): string {
    const text = source.slice(from, to);
    const midLine = from > 0 && !isLineBreak(source[from - 1]);
    const first = into === 'note' && midLine ? text.search(/[\S\r\n]|$/) : 0;
    const at = from + first;
    // In code, math or a comment, nothing was syntax. A cut from the start of
    // a line in a code block is left as it is: a partial code block
    const coded = midLine && inCode(source, at);
    // There it reads as at a line's start: as it does where it goes, or
    // after a space, where it forms nothing a line's start doesn't
    if (!coded && startsBlock(source, at)) return text.slice(first);
    // Cut from inside a list's number, it starts the list `source` held
    let number = at;
    while (/\d/.test(source[number - 1] ?? '')) number--;
    if (
      !coded &&
      startsBlock(source, number) &&
      /^\d{1,9}[.)](?:\s|$)/.test(lineAt(source, number))
    ) {
      return text.slice(first);
    }
    const nowhere = () => false;
    const lastWord = (of: string) => (i: number) =>
      !/\s/.test(restOfLine(of, i));
    // The first char as `source` reads it, and as it reads after whitespace,
    // as a line's start does for a tag: the marks find what a line's start
    // makes a block. A `$` closes no math after either
    const context: Context = {
      // Never the start of `source`, a block's start
      prev: source[at - 1],
      atLineStart: false,
      afterEscape:
        escapesNext(source, at - 1) && ASCII_PUNCTUATION.test(source[at - 1]),
      boundaryWithin: nowhere,
      isLastWord: lastWord(source),
    };
    // An escape stays one, though code shows its backslash: escaped, the
    // backslash would leave what it escaped bare. A backslash before
    // anything else was code's text
    const escape =
      source[at] === '\\' && ASCII_PUNCTUATION.test(source[at + 1] ?? '');
    const wasSyntax =
      (!coded || escape) &&
      !escapesNext(source, at) &&
      isSyntax(source, at, context);
    const isSyntaxNow =
      isSyntax(text, first, {
        ...context,
        prev: ' ',
        isLastWord: lastWord(text),
      }) ||
      // Math opens after anything, and code held none
      (coded && text[first] === '$' && !isBlank(text[first + 1] ?? ' '));
    const escapes = new Set(into === 'note' ? blockMarks(text, first) : []);
    if (isSyntaxNow && !wasSyntax) escapes.add(first);
    // Reading view starts a tag after an escape: one `source` didn't hold,
    // unless the char before it was escaped there too
    let next = Math.max(-1, ...escapes) + 1;
    while (
      next > 0 &&
      text[next] === '#' &&
      isTagStart(text, next, true, nowhere) &&
      !escapesNext(source, from + next - 1)
    ) {
      escapes.add(next++);
    }
    let out = '';
    for (let i = first; i < text.length; i++) {
      out += escapes.has(i) ? `\\${text[i]}` : text[i];
    }
    return out;
  }

  /**
   * `child`, text cut from `source` at `from` to start a note, its first
   * line escaped as needed (see {@link escapeCutStart}) or holding a card's
   * cloze delimiters, with its first paragraph kept from becoming a heading
   * that `source` didn't show there, and its lines from joining a paragraph
   * they weren't in there (the probe "reads tags in spans, and underlines…"
   * in e2e-tests/child-start.spec.ts has what Obsidian 1.13.7 reads).
   *
   * Reading view and the metadata cache underline a paragraph of one line
   * only, and live preview one of any length, by a line of `-` or `=` alone
   * (a lone `-` under a longer one is a list there too). So a line cut from
   * a list item, a quote, a heading, code or a longer paragraph can gain a
   * heading: each line down the first paragraph that could underline it
   * keeps what it was in `source`, read whole though the cut may end in it.
   * An underline of a heading `source` showed stays one; a rule (`---`) is
   * set apart by a blank line before it, and stays a rule; anything else
   * (`===`, `--`, a list's `-`, a line in code) is escaped, reads as text,
   * and the line after it is read in turn. So lines past the second can
   * change.
   *
   * A second line that started a paragraph of its own in `source`, as after a
   * heading (`# h foo\nbar` cut from `foo`), is set apart by a blank line too,
   * so the first line doesn't join it: the paragraph reads as it did.
   *
   * Line breaks before each line must be those of `source` from `from`:
   * escapes and delimiters added to the first line hold none.
   */
  static escapeCutUnderline(
    source: string,
    from: number,
    child: string
  ): string {
    // Blank lines first underline nothing: what follows them is the first
    // line, read where `source` holds it
    let first = 0;
    let lineStart = lineStartOf(source, from);
    let sourceAt = from;
    for (;;) {
      LINE.lastIndex = first;
      const [whole, line, lineBreak] = LINE.exec(child)!;
      if (lineBreak === undefined) return child;
      if (line.trim() !== '') break;
      first += whole.length;
      LINE.lastIndex = sourceAt;
      sourceAt += LINE.exec(source)![0].length;
      lineStart = sourceAt;
    }
    // Down its lines, where `source` holds each too: how a paragraph and a
    // fenced code block stand there is read once, and then line by line
    let { open, fence } = stateBefore(source, lineStart);
    let out = child.slice(0, first);
    let at = first;
    let sourceLine = lineStart;
    /** The lines of the child's paragraph so far: 0 for none open. */
    let lines = 0;
    /** Whether its first is a comment or an HTML block's line, which end it. */
    let head: 'comment' | 'html' | undefined;
    /** How `source` stands at the line above: see {@link paragraphState}. */
    let above: ReturnType<typeof paragraphState> = 'none';
    let lineBreak = '';
    for (;;) {
      LINE.lastIndex = at;
      const [whole, line, nextBreak] = LINE.exec(child)!;
      LINE.lastIndex = sourceLine;
      const [sourceWhole, held] = LINE.exec(source)!;
      const code = inBlock(fence, held);
      const state = paragraphState(open, held, code);
      if (lines === 0) {
        // Only a paragraph is underlined
        if (!isParagraphLine(line)) return out + child.slice(at);
        lines = 1;
        head = isCommentBlock(line)
          ? 'comment'
          : HTML_BLOCK.test(line)
            ? 'html'
            : undefined;
        out += line;
      } else if (
        UNDERLINE.test(line) &&
        !(lines > 1 && /^ {0,3}-[ \t]*$/.test(line))
      ) {
        // A line live preview underlines a paragraph of any length with,
        // and reading view one of one line, but for a lone `-` under a
        // longer one, which is a list there too. Kept where it reads as it
        // did: by reading view as by live preview for one line, and for a
        // longer one where live preview underlined the line above in `source`
        if (
          UNDERLINE.test(held) &&
          (lines > 1
            ? above !== 'none'
            : above === 'first' &&
              READ_UNDERLINE.test(held) === READ_UNDERLINE.test(line))
        ) {
          return out + child.slice(at);
        }
        // A rule, cut short or not, stays one; `RULE` takes only `-` here.
        // In code or HTML, it was text
        if (
          RULE.test(held) &&
          RULE.test(line) &&
          !code &&
          open !== IN_HTML &&
          open !== AFTER_HTML
        ) {
          return out + lineBreak + child.slice(at);
        }
        // Escaped, it is the paragraph's text, and the next line is read
        const dash = line.search(/[-=]/);
        out += `${line.slice(0, dash)}\\${line.slice(dash)}`;
        lines++;
        head = undefined;
      } else if (head) {
        // An HTML block holds the lines after it to a blank one, which
        // nothing underlines. A comment ends there: this line starts the
        // next paragraph, read as the first of one
        if (head === 'html') return out + child.slice(at);
        lines = 0;
        continue;
      } else if (
        isCommentBlock(line) ||
        HTML_BLOCK.test(line) ||
        !(isIndented(line) || isParagraphLine(line) || DEFINITION.test(line))
      ) {
        return out + child.slice(at);
      } else if (lines === 1 && state === 'first' && open <= 0) {
        // A paragraph of its own in `source`, which the first line would
        // join: set apart, it reads as it did
        return out + lineBreak + child.slice(at);
      } else {
        out += line;
        lines++;
      }
      if (nextBreak === undefined) return out;
      out += nextBreak;
      lineBreak = nextBreak;
      above = state;
      open = code ? NO_PARAGRAPH_OPEN : readParagraph(open, held);
      fence = readFence(fence, held);
      at += whole.length;
      sourceLine += sourceWhole.length;
    }
  }

  /**
   * Replace every link with its label, dropping the target and the syntax.
   * `[my site](www.example.com)` becomes `my site`, `[[Note|alias]]` becomes
   * `alias`, and `[[Note]]` becomes `Note`. Footnote references carry no
   * label worth keeping, so they are removed outright.
   */
  static stripLinks(text: string) {
    // Footnote references go first: removing them also stops an adjacent pair
    // like `[^1][^2]` from being read as a reference link.
    // Images and embeds go next: an image inside a link is the one nesting
    // Markdown allows, and unwrapping it leaves an ordinary link behind.
    return text
      .replace(FOOTNOTE_REFERENCE_PATTERN, '')
      .replace(EMBED_PATTERN, keepAliasOrTarget)
      .replace(IMAGE_PATTERN, keepLabel)
      .replace(WIKILINK_PATTERN, keepAliasOrTarget)
      .replace(LINK_PATTERN, keepLabel);
  }

  /**
   * Remove leading spaces, bullet point or number, and checkbox if any
   */
  static getListItemText(line: string) {
    const bulletItemMatch = line.match(BULLET_ITEM_PATTERN);
    if (!bulletItemMatch) return line;
    const withoutBullet = bulletItemMatch[bulletItemMatch.length - 1];
    return withoutBullet;
  }

  static countFootnoteRefs(text: string) {
    const counts = new Map<string, number>();
    for (const match of text.matchAll(FOOTNOTE_REFERENCE_PATTERN)) {
      const name = match[1];
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts].map(([name, count]) => ({ name, count }));
  }
}
