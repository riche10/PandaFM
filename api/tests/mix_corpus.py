"""Panda Mix test corpus (5.5): generated songs with known ground truth. No recorded music.

Each song is built at the analysis rate from simple layers (kick, hats, bass, pad, a vocal-like
voice) switched on per section, with a known tempo, first downbeat, 4/4 bars, an ending style and
a loudness offset, so the analysis and the planner can be measured against the truth.
"""

from dataclasses import dataclass, field

import numpy as np

from app.mix.analysis import SR


@dataclass
class Section:
    start: float
    end: float
    layers: tuple[str, ...]  # kick, hat, bass, pad, vocal


@dataclass
class Song:
    name: str
    bpm: float
    first_downbeat: float  # seconds
    sections: list[Section]
    ending: str = "hard"  # hard | fade | sustain
    tail_silence: float = 0.5
    gain_db: float = 0.0
    meter: int = 4
    genres: tuple[str, ...] = ("House",)
    album_id: str | None = None
    track_number: int | None = None
    seed: int = 1
    extra: dict = field(default_factory=dict)

    @property
    def body_end(self) -> float:
        return self.sections[-1].end

    @property
    def duration(self) -> float:
        return self.body_end + (4.0 if self.ending == "sustain" else 0.0) + self.tail_silence

    def beats(self) -> np.ndarray:
        period = 60.0 / self.bpm
        return np.arange(self.first_downbeat, self.body_end, period)

    def downbeats(self) -> np.ndarray:
        return self.beats()[:: self.meter]

    def layer_at(self, t: float) -> tuple[str, ...]:
        for s in self.sections:
            if s.start <= t < s.end:
                return s.layers
        return ()


def _burst(n, decay, rng=None, freq=None):
    t = np.arange(n) / SR
    env = np.exp(-t * decay)
    if freq is not None:
        return np.sin(2 * np.pi * freq * t) * env
    return rng.standard_normal(n) * env


def render(song: Song) -> np.ndarray:
    rng = np.random.default_rng(song.seed)
    n = int(song.duration * SR)
    x = np.zeros(n, dtype=np.float64)
    t = np.arange(n) / SR
    beats = song.beats()
    for k, b in enumerate(beats):
        layers = song.layer_at(b)
        i = int(b * SR)
        if "kick" in layers:
            k_n = min(int(0.25 * SR), n - i)
            amp = 0.9 if k % song.meter == 0 else 0.6  # accented downbeats
            x[i:i + k_n] += amp * _burst(k_n, 18, freq=55)
        if "hat" in layers:
            j = i + int(30 / song.bpm * SR)  # the off-beat
            h_n = min(int(0.04 * SR), max(0, n - j))
            if h_n > 0:
                hb = _burst(h_n, 90, rng)
                x[j:j + h_n] += 0.12 * (hb - np.convolve(hb, np.ones(4) / 4, "same"))
        if "bass" in layers:
            b_n = min(int(60 / song.bpm * 0.9 * SR), n - i)
            note = (45, 49, 52, 41)[(k // song.meter) % 4]
            x[i:i + b_n] += 0.35 * np.sin(2 * np.pi * note * np.arange(b_n) / SR) * np.minimum(1, np.arange(b_n) / 200)
    for s in song.sections:
        a, b = int(s.start * SR), min(n, int(s.end * SR))
        tt = t[a:b]
        if "pad" in s.layers:
            x[a:b] += 0.06 * sum(np.sin(2 * np.pi * f * tt) for f in (220.0, 277.2, 329.6))
        if "vocal" in s.layers:
            f0 = 210 + 15 * np.sin(2 * np.pi * 5.5 * tt)  # vibrato
            phase = 2 * np.pi * np.cumsum(f0) / SR
            voice = sum((0.5 / h) * np.sin(h * phase) for h in range(1, 7))
            syll = (np.sin(2 * np.pi * 4.5 * tt) > -0.2).astype(float)  # syllables
            syll = np.convolve(syll, np.ones(220) / 220, "same")
            x[a:b] += 0.22 * voice * syll
    end = int(song.body_end * SR)
    if song.ending == "fade":
        f = int(8 * SR)
        x[end - f:end] *= np.linspace(1, 0, f)
        x[end:] = 0
    elif song.ending == "sustain":
        hold = int(4 * SR)
        tt = np.arange(hold) / SR
        chord = 0.25 * sum(np.sin(2 * np.pi * f * tt) for f in (110.0, 220.0, 277.2, 329.6)) * np.exp(-tt * 0.6)
        x[end:end + hold] = chord
        x[end + hold:] = 0
    else:
        x[end:] = 0
    x *= 10 ** (song.gain_db / 20)
    return x.astype(np.float32)


def standard(bpm=126.0, downbeat=1.3, seed=1, **kw) -> Song:
    """intro (drums) 0-16 bars · full with vocals · breakdown · full · outro (drums) · ending."""
    bar = 4 * 60.0 / bpm
    d = downbeat
    secs = [
        Section(0, d + 8 * bar, ("kick", "hat")),
        Section(d + 8 * bar, d + 24 * bar, ("kick", "hat", "bass", "pad", "vocal")),
        Section(d + 24 * bar, d + 32 * bar, ("pad",)),
        Section(d + 32 * bar, d + 48 * bar, ("kick", "hat", "bass", "pad", "vocal")),
        Section(d + 48 * bar, d + 56 * bar, ("kick", "hat", "bass")),
    ]
    return Song(name=kw.pop("name", f"std{bpm:g}"), bpm=bpm, first_downbeat=d, sections=secs, seed=seed, **kw)


def vocal_heavy(bpm=100.0, downbeat=0.6, seed=2, **kw) -> Song:
    """vocals from the first bar to the last: a dense pop-like arrangement."""
    bar = 4 * 60.0 / bpm
    secs = [Section(0, downbeat + 40 * bar, ("kick", "bass", "pad", "vocal"))]
    return Song(name=kw.pop("name", "vocal"), bpm=bpm, first_downbeat=downbeat, sections=secs, seed=seed, genres=("Pop",), **kw)
