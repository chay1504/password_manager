"""Render the two SVG icons into iOS and Android launcher assets.

Requires: pip install resvg-py
Run from anywhere: python tools/render_icons.py
"""

from __future__ import annotations

import json
from pathlib import Path

import resvg_py

ROOT = Path(__file__).resolve().parents[1]
ANDROID_SIZES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}


def render(svg: Path, destination: Path, size: int) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(
        resvg_py.svg_to_bytes(svg_path=str(svg), width=size, height=size)
    )


for app in ("vault", "codes"):
    svg = ROOT / "design" / f"{app}-app-icon.svg"
    render(svg, ROOT / "design" / f"{app}-1024.png", 1024)

    icon_set = ROOT / "apps" / app / "ios" / "Runner" / "Assets.xcassets" / "AppIcon.appiconset"
    contents = json.loads((icon_set / "Contents.json").read_text(encoding="utf-8"))
    for item in contents["images"]:
        filename = item.get("filename")
        if not filename:
            continue
        points = float(item["size"].split("x")[0])
        scale = int(item["scale"].removesuffix("x"))
        render(svg, icon_set / filename, round(points * scale))

    res = ROOT / "apps" / app / "android" / "app" / "src" / "main" / "res"
    for density, size in ANDROID_SIZES.items():
        render(svg, res / f"mipmap-{density}" / "ic_launcher.png", size)

print("Rendered iOS and Android icon sizes for TBD Vault and TBD Codes.")
