#!/usr/bin/env python3
"""Generate the Event Alerts sounds (public/sounds/*.wav) from scratch.

Every sample is synthesized here with the Python standard library, so the
files carry no third-party license: run this script and you get bit-identical
outputs. 22.05 kHz, 16-bit mono, each under 2 s.

Usage: python3 packaging/sounds/generate_sounds.py
"""

import math
import struct
import wave
from pathlib import Path

RATE = 22050
OUT = Path(__file__).resolve().parents[2] / "public" / "sounds"


def write_wav(name: str, samples: list[float]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    peak = max(1e-9, max(abs(s) for s in samples))
    data = b"".join(
        struct.pack("<h", int(max(-1.0, min(1.0, s / peak * 0.85)) * 32767))
        for s in samples
    )
    with wave.open(str(OUT / name), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(data)
    print(f"{name}: {len(samples) / RATE:.2f}s")


def tone(freq: float, dur: float, decay: float = 4.0, harmonics=((1, 1.0),)) -> list[float]:
    out = []
    for i in range(int(RATE * dur)):
        t = i / RATE
        env = math.exp(-decay * t) * min(1.0, i / (RATE * 0.005))
        s = sum(a * math.sin(2 * math.pi * freq * h * t) for h, a in harmonics)
        out.append(s * env)
    return out


def mix(*parts: tuple[float, list[float]]) -> list[float]:
    end = max(int(off * RATE) + len(p) for off, p in parts)
    out = [0.0] * end
    for off, p in parts:
        base = int(off * RATE)
        for i, s in enumerate(p):
            out[base + i] += s
    return out


# Chime: two soft bell-ish notes, E5 then A5 — the default.
write_wav("chime.wav", mix(
    (0.00, tone(659.26, 0.9, 3.5, ((1, 1.0), (2, 0.25), (3, 0.08)))),
    (0.18, tone(880.00, 1.1, 3.0, ((1, 1.0), (2, 0.22), (3, 0.07)))),
))

# Bell: one long A5 strike with inharmonic shimmer.
write_wav("bell.wav", mix(
    (0.0, tone(880.0, 1.6, 2.2, ((1, 1.0), (2.0, 0.4), (2.76, 0.2), (5.4, 0.08)))),
))

# Ping: a short high blip — unobtrusive, for frequent hourly events.
write_wav("ping.wav", tone(1318.5, 0.28, 11.0, ((1, 1.0), (2, 0.15))))

# Horn: a rising two-note call with a square-ish edge — the "boss is up" one.
write_wav("horn.wav", mix(
    (0.00, tone(392.0, 0.45, 2.5, ((1, 1.0), (3, 0.33), (5, 0.2)))),
    (0.28, tone(523.25, 0.8, 2.5, ((1, 1.0), (3, 0.33), (5, 0.2)))),
))
