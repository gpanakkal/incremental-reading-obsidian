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
  const block =
    line[0] === '>' ||
    /^#{1,6}(?:\s|$)/.test(line) ||
    /^(?:`{3,}(?!.*`)|~{3})/.test(line) ||
    (line[0] === '*' && isBlank(line[1] ?? ' ')) ||
    /^([*_])(?:\s*\1){2,}\s*$/.test(line) ||
    /^\[[^\]]+\]:/.test(line);
  return block ? [i] : [];
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
 * a number as a tag, so `#1` before whitespace, `,`, `.` or `)` is left,
 * unless an end of the answer could change what follows it.
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
  return !/^(?:[\s,.)]|$)/.test(text.slice(end)) || boundaryWithin(i + 2, end);
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
   * starts one there: `\##tag`). The rest of the cut reads as it did. A cut
   * that starts a block in `source`, at the start of its line or after list
   * and quote markers, is escaped nowhere.
   *
   * Left bare: a `$`, since math opens after anything in Obsidian and nothing
   * is left before the start for it to close; text in code, which the rules
   * can't see, as with a cut from the start of a line.
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
    // There it reads as at a line's start: as it does where it goes, or
    // after a space, where it forms nothing a line's start doesn't
    if (startsBlock(source, at)) return text.slice(first);
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
    const wasSyntax = !escapesNext(source, at) && isSyntax(source, at, context);
    const isSyntaxNow = isSyntax(text, first, {
      ...context,
      prev: ' ',
      isLastWord: lastWord(text),
    });
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
