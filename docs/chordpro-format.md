# The ChordPro dialect used here

This tool implements a variant of ChordPro formatting for the purposes of making books and setlists from collections of songs packaged up as self-contained HTML pages.

See the [ChordPro](https://www.chordpro.org/chordpro/chordpro-introduction/) site for a very brief introduction.

A chordpro song looks like this:

```
{title: Universe}
{composer: Peter Sefton}
{key: C} 
{transpose: D} 
{capo: 2}

[C] This is a song about [E7] everything
[F] It's really div[C]erse
[Caug9] Got something for [E7] everyone
[Am] But only [G] has one [F] verse
[F] Get it? Uni [D] Verse

{c: Pre chorus}
[D7] Here comes the chorus:

{soc}
{c: Chorus}
[C] Uni [E7] verse Uni [F] verse
[F] Uni [Fm] verse Uni [C] verse
{eoc}

{sob}
{c: Bridge}
[C] That's [G] it
{eob}

{c: Coda}
[F] Sorry the song's [C] so terse

<a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/3.0/au/"><img alt="Creative Commons Licence" style="border-width:0" src="https://i.creativecommons.org/l/by-nc-sa/3.0/au/88x31.png" /></a><br />This work is licensed under a <a rel="license" href="http://creativecommons.org/licenses/by-nc-sa/3.0/au/">Creative Commons Attribution-NonCommercial-ShareAlike 3.0 Australia License</a>.  
```

An explanation of this version of the chordpro format follows.

## Chords

Anything in square brackets starting with a capital `A`–`G`, followed by any mix of
lower-case letters, slashes, and numbers:

```
[C] [Csus4] [C/B] [Cmaj7]
```

Some charts use `!` and `/` inside a chord for staccato or rhythm — both are recognised for
transposing purposes:

```
[C / / / ] [F / /] [C!]
```

## Directives

A directive is a line that starts and ends with `{`/`}` (surrounding whitespace is ignored);
a line with text outside the braces isn't treated as one. None are case-sensitive, and all
are optional.

| Directive | Description |
|---|---|
| `{title: ...}` / `{t: ...}` | Song title |
| `{subtitle: ...}` | By convention, a composer or artist credit |
| `{key: ...}` | The song's key, major or minor eg `C` or `Am`. It is important to note the key as charted, so if the chords are [C] [F] and [G] (key of C) then put `{key: C}`, even if you usually play it with a capo on the 5th fret (in the key of F) |
| `{transpose: +2}` / `{tr: +2}` / `{tr: C}` | Semitone offset, or a key name into which to transpose the song. If the song is charted in the key of C and you add `{tr: +2}`, the software will transpose it to the key of D (with chords [D], [G] and [A]) |
| `{capo: ...}` | Capo position as a positive integer - eg 5. If the song is `{key: C}`, transposed into D with `{tr: +2}` and you put `{capo: 2}` then the tool will show the key as [D] but the chords as [C], [F] and [G] because those are the *shapes* you play with the capo on [C] to play in the key of [D]. NOTE: this differs from the advice given at the [chordpro.org site](https://www.chordpro.org/chordpro/directives-capo/) but this is how we do it over here as it makes more sense in the context of this tool. (coming soon, an option to import songs that do it the chordpro.org way)  |
| `{composer: ...}` | Composer credit |
| `{c: ...}` / `{comment: ...}` | A heading inline eg `{c: Chorus}` |
| `{instrument: ...}` | Which instrument to show chord grids for |
| `{define: ...}` | A chord-fingering definition for the current `{instrument:}` |
| `{new_page}` / `{np}` | A page break |
| `{start_of_chorus}` / `{soc}` … `{end_of_chorus}` / `{eoc}` | A chorus block |
| `{start_of_bridge}` / `{sob}` … `{end_of_bridge}` / `{eob}` | A bridge block |
| `{start_of_tab}` / `{sot}` … `{end_of_tab}` / `{eot}` | A tab (monospace) block |

## Setlists

A setlist is a Markdown file: songs are `##` headings, matched against a song's title by
words in order (`## Amazing` matches "Amazing Grace"); `#` headings group songs into sets.
Add `{transpose: +2}` after a song's heading to override its transpose for that one
performance.

See [the full spec](https://github.com/ptsefton/chordpro-book-builder/blob/master/src/chordpro-input/SPEC.md).