"""Render the two SVG app icons into the web app (PWA) icon files.

Requires: pip install resvg-py
Run from anywhere: python tools/render_pwa_icons.py
"""

from __future__ import annotations

import shutil
from pathlib import Path

import resvg_py

ROOT = Path(__file__).resolve().parents[1]
SIZES = {
    "icon-192.png": 192,
    "icon-512.png": 512,
    # The artwork already sits inside the central 80% "safe zone", so the same
    # full-bleed square works as a maskable icon.
    "icon-maskable-512.png": 512,
    "apple-touch-icon.png": 180,
    "favicon-32.png": 32,
}

for app in ("vault", "codes"):
    svg = ROOT / "design" / f"{app}-app-icon.svg"
    out = ROOT / "web" / app / "icons"
    out.mkdir(parents=True, exist_ok=True)
    for name, size in SIZES.items():
        (out / name).write_bytes(resvg_py.svg_to_bytes(svg_path=str(svg), width=size, height=size))
    shutil.copyfile(svg, out / "icon.svg")

print("Rendered PWA icons for TBD Vault and TBD Codes.")
