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
