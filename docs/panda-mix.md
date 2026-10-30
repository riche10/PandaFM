# Panda Mix and Panda DJ

**Panda Mix** is a persistent mode for one of your playlists. It never adds
or removes songs, but while enabled it keeps a stable, optimized playback order
of the songs already in that playlist. **Panda DJ** is the engine that decides
*how* each adjacent Song A becomes Song B.

| | Answers |
|---|---|
| Navidrome playlist | **Which songs** belong to the playlist and its original order |
| **Panda Mix** | **What stable playback order** those same songs use while mixing is enabled |
| Panda Radio, Stations | **What** to choose from your library |
| **Panda DJ** | **How** one song becomes the next |

Turning Panda Mix on is the only action that analyses a whole playlist. It
never scans the rest of your library. The optimized order is saved and reused
until you explicitly **Remix**, edit the playlist (new/removed songs are handled
without reshuffling everything), or **Turn off Panda Mix**. Repeated occurrences
of the same song are preserved.

Start it from a playlist with **Panda Mix** (Auto) or choose a personality from
the menu. Once enabled, the playlist's primary **Play** uses its mixed order;
**Play original order** is still available without changing Navidrome.

## Personalities

- **Auto** (default): Panda decides transition by transition.
- **Gentle**: short blends and clean handoffs, no effects.
- **Flow**: continuity first; beat-aware overlaps when the rhythm is clear.
- **Energetic**: more willing to do long dance blends, bass handoffs and filter
  glides, still never forced.

## Transitions

Smooth Blend, Deep Blend, Bass Handoff, Filter Glide, Quick Switch, Clean
Handoff and Gapless. Auto isn't always fancy: Panda picks a long, beat-aligned
**Deep Blend** or **Bass Handoff** only for confident, close-tempo dance tracks
with clean intro and outro sections; very different tempos get a short **Quick
Switch** (or, Energetic, a **Filter Glide**); unclear rhythm or sections get a
**Clean Handoff**; continuous album tracks play **Gapless**. Half and double
time (75 ≈ 150 BPM) count as compatible. Trailing silence is skipped, never
waited through. Each plan says how sure Panda is and explains itself, e.g.
"Quick Switch · 2 sec: large tempo difference; a long overlap would sound
muddy." PandaFM never time-stretches or changes pitch.

The **current song changes at the transition midpoint**: before it, A is the
current song (history, lock screen, car, Next/Previous); from it, B. Next
during a blend goes to the song already fading in (without restarting it);
after the midpoint Next stops the fading song at once. Pause freezes both
songs and the transition. A seek cancels the currently running overlap safely
and re-arms the same pair when the transition still lies ahead; seeking past
the mix window skips that transition.

## Analysis

When Panda Mix is enabled for a playlist, the server analyses the tracks in
that playlist from private temporary copies (your files are never modified).
The per-track results are cached and reused across mixes; the rest of the
library is not scanned. Analysis includes EBU R128 loudness
(ffmpeg), a small waveform, leading/trailing silence, BPM and beat grid with
confidence, musical key with confidence, and intro/outro suitability. Results
are small metadata, reused until the file or the analysis version changes.
Playback never waits for analysis: until a song is ready, a short, safe
equal-power blend is used, and the bridge says "Preparing…".

| Setting | Default | |
|---|---|---|
| `PANDAFM_MIX_ANALYSIS_WORKERS` | `1` | concurrent analyses (niced below streaming) |
| `PANDAFM_MIX_LOOKAHEAD` | `3` | songs after the current one to prepare |
| `PANDAFM_MIX_ENABLED` | `true` | turn Panda Mix off on this server |

Analysis runs at low CPU priority and pauses while the server is busy, so
streaming and transcoding come first. No GPU is needed.

## Adjust Mix

In the queue, each upcoming song shows a compact bridge ("Panda Mix · Smooth
Blend · 12 sec · 147 → 150 BPM"). Tap it for the summary; **Adjust Mix**
shows both waveforms with the overlap, its midpoint and the gain curves, and
lets you choose the transition type, when it starts, where the next song comes
in, the overlap and the fade shape. **Preview** plays the region around the
transition on its own (your queue and its position are untouched); **Save**
keeps it for exactly this pair **in this playlist** (Auto never overwrites it);
**Reset Auto** gives it back to Panda.

## Offline

Downloaded songs always play from the device. Plans Panda has already made are
kept on the phone, so a downloaded playlist mixes smartly offline; anything
not prepared uses the safe blend. In the app, the playlist menu's **Prepare
Panda Mix (offline)** analyses the whole playlist on the server and keeps
every plan (no audio is copied).

## Android and browsers

- **Android** (strongest): two native decks under the 5.1 playback engine;
  transitions run in the playback service on the player's own clock, with the
  app closed, the screen off, through Android Auto. Only the logical deck holds
  audio focus; the other pauses with it (calls, navigation prompts). Bass
  Handoff and Filter Glide are gain-only on Android (no EQ there yet).
- **Browsers**: two decks through Web Audio (gain, low-shelf and high-pass
  automation on the audio clock). Browsers throttle background tabs, so a
  transition can start up to about a second late when the tab is hidden.

## Limitations (5.3)

No time-stretching or pitch shifting; no global learning from your edits;
Panda Mix works on playlists only (not Radio or Stations yet); Android Auto
plays Panda Mix normally but has no editor; "Gapless" between two decks can
leave a gap of a few tens of milliseconds.


## What changed from 5.2

**Panda Mix is a setting of a playlist.** Turn it on from the playlist (Auto or
a personality): that is the only thing that analyses a *whole* playlist. Until
every song is analysed the playlist plays in its own order with safe blends;
then Panda arranges a **mixed order** once (neighbours with compatible tempo,
key and loudness; album runs kept together) and keeps it stable. Songs you
add to the playlist in Navidrome are slotted in where they fit; removed ones
drop out; nothing else moves. **Remix** draws a new order; **Turn off Panda
Mix** goes back to normal (the analyses stay cached). The playlist page shows
**Play Panda Mix** beside the normal **Play**, and toggles between the mixed
and the original order. Navidrome's playlist and its order are never changed.

**Why 5.2's transitions were often hard to hear.** Blends were timed against
the last audible moment of Song A, which for any song that fades out is deep
inside the fade (the 5.2 fallback blended with A ~22 dB below its normal
level). 5.3 finds each song's *musical* end (where it falls below its body
level for good) and ends the blend there, so A is still clearly playing for
most of it. The fallback (no analysis yet) is a 5 s equal-power blend that
ends 3 s before the file ends.

**Personalities** now differ clearly: Gentle 3–4 s; Auto 5–8 s (long beat-
aligned blends for compatible dance tracks); Flow 6–10 s; Energetic 7–12 s,
plus long Bass Handoffs and Filter Glides for dance music. Songs that really
don't fit together still get a deliberate **Quick Switch** or **Clean
Handoff**: marked *intentional*, never counted as a failure.

**Diagnostics** (Settings › Diagnostics, Android) show whether each transition
was smart, fallback, manual or intentional, and whether one was cancelled or
dropped because the next song wasn't ready, with the plan, its source,
confidence, BPMs, start, overlap, both decks' track/state/position/volume,
progress and the last reason.


## 5.4: a musically driven order, facts you can see, a bigger editor

**The mixed order follows the music.** Panda weighs, in order: tempo (half and
double time count as the same groove, so 64 ≈ 128 BPM; confident tempo
differences count fully, uncertain ones are treated as neutral), harmonic fit
(Camelot neighbours when the keys are confident; confident clashes are
avoided; uncertain keys barely matter), loudness jumps, and usable intros and
outros. Consecutive tracks of the same album stay together.

**Remix explores, it doesn't scramble.** It builds several candidate orders,
scores each with the same musical cost, throws away any that are clearly worse
than the best (more than ~10%), and picks one that differs from your current
mix. Measured on a 30-song test library: a 5.3 Remix cost 1.08× the best order
(worst 1.12×); a 5.4 Remix 0.99× (worst 1.02×). Each Remix is repeatable (it
keeps its seed), keeps songs you listed twice, and never touches the playlist
in Navidrome.

**In the playlist** (Panda Mix on): every song shows what Panda knows, e.g.
"88 BPM · A minor · 8A" ("88 BPM · 8A" on phones), or honestly "Key
uncertain", "Analyzing…", "Analysis pending". The status line says "Panda Mix
analyzing · 17 / 24 tracks" until the final order is active ("Panda Mix ready
· 24 tracks analyzed"). In the mixed order, each pair of neighbours has a
bridge ("Smooth Blend · 8 sec / 128 → 130 BPM · 8A → 9A"): tap it for the
details and Adjust Mix (the same transition the queue and playback use: an
edit here is what plays), or "Why here?" for the reasons behind that
neighbour.

**Plans explain themselves**: tempo, key, loudness and sections, plus any
limit they imposed: a loudness gap over 6 LU or a confident key clash keeps a
blend to 8 s; poor intro and outro to 6 s.

**Adjust Mix** is now wide (about 1000 px where it fits, full screen on
phones) with large waveforms showing the transition region, the fade curve,
its midpoint, each song's musical end (outgoing) or the point it gets going
(incoming), and time labels; plus both songs' tempo and key and Panda's
reasoning. No pitch shifting or time stretching.


## 5.5: how Panda decides (and how to tell why)

Panda Mix is a deterministic system: signal analysis plus rules. There is no machine learning in it.

**Analysis v3** (re-analysed lazily, Panda Mix playlists only; ~2 s of CPU per 5-minute song at the
lowest priority, one song at a time) measures tempo (to ~0.02 BPM), the beat with adaptive beat
tracking, local beat grids for the first and last ~45 s, downbeats and meter (with a confidence, or
"unknown"), a 2-second section profile (relative loudness, sustained bass, and a *vocal-likelihood
heuristic*: voice-band energy that is harmonic and syllable-modulated; a hint, not vocal detection) and
how the song ends (fade, held note or hard final hit).

**The planner** turns that evidence into an ambition tier: *deep* (long, bar-aligned), *moderate*,
*short* or *clean*. Personalities cap it: Gentle at short, Flow at moderate, Energetic at deep, Auto at
deep only for confident dance material. Rules on top:

- PandaFM doesn't time-stretch, so a blend is never longer than the number of beats over which the two
  tempos drift apart by more than 20 ms (Gentle), 30 ms (Flow, Auto) or 45 ms (Energetic). Long blends
  need near-identical tempos; that is physics, not caution.
- With confident bars, Song A's transition starts on one of its bars and Song B's first downbeat lands
  on it (B starts on its downbeat, skipping at most 8 s and never its first vocal).
- Vocals on both sides across the overlap shrink it (in whole bars); dense on both sides is short; bass
  on both sides hands the low end over quickly (the *sharp* curve; the browser also uses a low-shelf
  Bass Handoff).
- The louder side is turned down during the blend toward the other's level (attenuation only, never a
  boost; the files are never changed).
- A held final note rings out while Song B rises beneath it (the two levels always add up to at most
  full scale, so the overlap can't clip); a hard final hit isn't buried under a long blend; at most
  half of any blend reaches past Song A's musical end.

**Playback** never sacrifices the music for the transition: a streamed incoming song must have
`min(overlap, 6 s)` buffered before a blend starts; otherwise Panda waits, starts a shorter blend at the
last moment, or lets Song A play to its end (a plain handoff), and records why. Android and the browser
use the same envelope, and the Adjust Mix preview schedules it with the same code as the browser player.

**Settings › Diagnostics** shows the planned tier, confidence, alignment, levelling, the facts and
reasons behind the plan, and a history of the last 20 transitions, e.g.

```
t21 → t22 · Deep Blend · 15 s · 126 → 126 BPM · deep · planned 15.2 s · actual 15.2 s · start late 40 ms · buffered 8.1 s · confidence 0.85
t5 → t6 · Smooth Blend · 4 s · moderate · planned 3.8 s · plain handoff · incoming buffer insufficient: plain handoff
```

### Real-device checklist

Panda can't listen to your phone, so judging the sound is yours. For each rough transition, note the
history line; it says what Panda planned, what happened and why.

- **Normal playback, 30-60 min:** screen off, in the background, Bluetooth, Wi-Fi changes, aggressive
  skipping (20 Nexts in a row: the last choice plays, nothing else sounds).
- **Panda Mix, 20+ transitions** across genres: similar songs, very different songs, albums,
  playlists. Expect long bar-aligned blends only for near-identical tempos, quick handoffs for very
  different ones, short overlaps where both songs sing, and no loudness jumps.
- **Each personality** on the same playlist: Gentle should be audibly shorter and cleaner than Energetic.
- **Adjust Mix → Preview** then the real transition: they should sound the same.
- **A cold NAS** during a preload: a shorter blend or a plain handoff, never a stop.


## 5.5.1: half/double time, midpoint alignment, reasons

- **Half/double time is first-class.** 174 ↔ 87, 140 ↔ 70 and 150 ↔ 75 get exactly what an equal-tempo
  pair gets: the drift is computed between Song A's beat and Song B's beat *after folding* (87 counts
  as 174), never between mismatched raw beat intervals. Diagnostics show both (`beat_ms_out`,
  `beat_ms_in_folded`) and the slip per beat.
- **What makes 174 → 85 short:** 85 isn't half of 174 (2 × 85 = 170), so the two are 2.3% apart after
  folding. Without time-stretching the beats slip ~8 ms per beat; the drift budget then limits the
  blend, exactly as it would for 174 → 170. The reasons say so.
- **Midpoint alignment.** The beats are aligned at the blend's midpoint (both decks equally loud), so
  the unavoidable slip is split ± around it: the worst misalignment stays within the personality's
  budget (20 / 30 / 30 / 45 ms) while the blend can be twice as long as when aligned at the start.
  Energetic may use up to 24 beats in a moderate blend (16 otherwise).
- **Reasons** read one fact per line, then what limited the transition, then the result:

```
Tempo: 174 → 85 BPM (half/double time)
Beat grid: strong
Bars: aligned
Key: uncertain
Vocals: low collision
Bass: low
Limited by: Half/double time, but 2.3% apart after folding: without time-stretching the beats slip 8 ms per beat, so the blend is limited to 8 beats
Result: Short blend, 2.8 s
```


## 5.5.2: changing a Panda Mix while it plays; editing in mixed order

- **Changing Auto / Gentle / Flow / Energetic while that playlist's Panda Mix plays** keeps the current song
  playing (no restart, no jump) and plans the transitions still to come in the new style. **Remix** keeps
  the current song too and reorders only the songs after it (songs you added by hand stay after the mix;
  each duplicate stays its own occurrence; a blend already under way keeps its next song). If the queue
  playing isn't this playlist's mix (or it's shuffled, for Remix), the change applies the next time it
  plays, and PandaFM says so. Rapid changes are safe: the last choice wins.
- **Remove from this playlist** works in the mixed order too, from a song's ⋯ menu or by selecting several.
  A song that appears twice is two occurrences: the one you pick is the one removed, from the playlist and
  from its place in the mixed order. The song playing right now keeps playing; the playing queue isn't
  changed by editing the playlist.
- A Remix on playlists made of whole albums no longer fails (album runs made its cost negative, which
  rejected every candidate order).
