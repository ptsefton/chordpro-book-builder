# samples-large fixtures

A bigger, wholly invented ChordPro collection — not chordprosite's own real sample
files (those live in `../samples/`), and not a real band's real songs. Every title,
lyric, and chord chart here was written for this repo, for exercising
the songbook builder at a more realistic scale: a few dozen songs across several
folders, and a handful of setlists scattered around that same tree, some of them
close to the songs they call, some of them far away.

The (fictional) band is **The Verandah Rattlers** — a suburban pub-rock/folk outfit
whose songbook mostly runs on servos, utes, backyard cricket, and the occasional
sincere ballad about leaving a small town. Most songs carry `{artist: The Verandah
Rattlers}`; a few are credited to the band's own (equally fictional) songwriter,
`{composer: Deb Kowalski}`, for variety.

## Why several songs share a title

`originals/` holds the band's main catalogue. `covers/acoustic/` and `covers/live/`
hold alternate arrangements of some of those same songs (a stripped-back unplugged
version, an extended live jam) — same title, deliberately, both times. `archive/
early-demos/` holds one more: an early demo of "Paper Boats" that predates the
"real" version. That's four different files across three folders that a setlist
entry named "Paper Boats" could resolve to, and two more three-way/two-way
collisions elsewhere (`Chrome Kangaroo`, `Overdraft Blues`, `Tin Shed Serenade`) —
on purpose, so `findAmbiguousSetlistMatches`/`rankCandidatesByPath` (SPEC.md §16)
have real, multi-directory ambiguity to resolve, not just a single hand-built
example.

The setlists under `gigs/`, plus one each tucked inside `originals/ballads/` and
`covers/acoustic/` themselves, reference these same songs from a mix of distances —
right next door, a few folders over, and (from `gigs/`) nowhere near any of the
candidates at all, so path-proximity has a genuinely different answer depending on
which setlist is asking.
