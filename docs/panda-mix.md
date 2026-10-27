# Panda Mix and Panda DJ (5.2)

**Panda Mix** plays one of your playlists continuously, with each song
blended into the next. **Panda DJ** is the engine that decides *how* Song A
becomes Song B. Neither ever chooses songs:

| | Answers |
|---|---|
| Playlist / queue | **What** plays next (and in what order) |
| Panda Radio, Stations | **What** to choose from your library |
| **Panda DJ** | **How** one song becomes the next |

Panda Mix is playlist-scoped in 5.2: the playlist owns the songs, their order
and identity. Shuffle happens first; Panda DJ plans the resulting neighbours.
It never inserts songs, never builds a playlist, and **never analyses your
whole library**: only the songs a Panda Mix is about to play (the current song
and the next few), or a downloaded playlist you prepare yourself.

Start it from a playlist: **Panda Mix** (Auto), or the menu next to it for a
personality. Normal **Play** is unchanged.

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
muddy." 5.2 never time-stretches or changes pitch.

The **current song changes at the transition midpoint**: before it, A is the
current song (history, lock screen, car, Next/Previous); from it, B. Next
during a blend goes to the song already fading in (without restarting it);
after the midpoint Next stops the fading song at once. Pause freezes both
songs and the transition; a seek cancels the transition.

## Analysis

The server analyses a song the first time a Panda Mix needs it, from a
private temporary copy (your files are never modified): EBU R128 loudness
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
  Handoff and Filter Glide are gain-only on Android in 5.2 (no EQ there yet).
- **Browsers**: two decks through Web Audio (gain, low-shelf and high-pass
  automation on the audio clock). Browsers throttle background tabs, so a
  transition can start up to about a second late when the tab is hidden.

## Limitations (5.2)

No time-stretching or pitch shifting; no global learning from your edits;
Panda Mix works on playlists only (not Radio or Stations yet); Android Auto
plays Panda Mix normally but has no editor; "Gapless" between two decks can
leave a gap of a few tens of milliseconds.
