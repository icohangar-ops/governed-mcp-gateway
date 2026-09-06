#!/usr/bin/env python3
"""Render README screenshots.

This Homebrew ffmpeg build has no libfreetype, so cards are rasterized with
system fonts via Pillow and encoded to PNG with ffmpeg.
"""

from __future__ import annotations

import json
import subprocess
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
SHOTS = ROOT / "docs" / "screenshots"
TITLE_FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
BODY_FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"
MONO_FONT = "/System/Library/Fonts/Supplemental/Courier New.ttf"
W, H = 1600, 900


def font(path: str, size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(path, size)


def hex_rgb(value: str) -> tuple[int, int, int]:
    raw = value.removeprefix("0x").removeprefix("#")
    return int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16)


def wrap(text: str, width: int = 86) -> str:
    lines: list[str] = []
    for raw in text.splitlines() or [""]:
        if not raw.strip():
            lines.append("")
            continue
        lines.extend(textwrap.wrap(raw, width=width, replace_whitespace=False) or [raw])
    return "\n".join(lines[:20])


def encode_png(img: Image.Image, outfile: Path) -> None:
    outfile.parent.mkdir(parents=True, exist_ok=True)
    raw = img.convert("RGB").tobytes()
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "rawvideo",
            "-pix_fmt",
            "rgb24",
            "-s",
            f"{W}x{H}",
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            str(outfile),
        ],
        input=raw,
        check=True,
    )


def ffmpeg_card(
    outfile: Path,
    kicker: str,
    title: str,
    subtitle: str,
    body: str,
    accent: str = "0x3b82f6",
) -> None:
    accent_rgb = hex_rgb(accent)
    img = Image.new("RGB", (W, H), hex_rgb("0b1220"))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, W, 118), fill=hex_rgb("111827"))
    draw.rectangle((0, 0, 10, H), fill=accent_rgb)
    draw.rectangle((40, 150, 1560, 860), fill=hex_rgb("020617"), outline=hex_rgb("1f2937"), width=2)
    draw.text((40, 22), kicker, font=font(TITLE_FONT, 18), fill=accent_rgb)
    draw.text((40, 48), title, font=font(TITLE_FONT, 32), fill=hex_rgb("f8fafc"))
    draw.text((40, 90), subtitle, font=font(BODY_FONT, 18), fill=hex_rgb("94a3b8"))
    y = 176
    mono = font(MONO_FONT, 20)
    for line in wrap(body).split("\n"):
        draw.text((64, y), line, font=mono, fill=hex_rgb("e2e8f0"))
        y += 28
    encode_png(img, outfile)


def ffmpeg_architecture(outfile: Path) -> None:
    img = Image.new("RGB", (W, H), hex_rgb("0b1220"))
    draw = ImageDraw.Draw(img)
    draw.rectangle((0, 0, W, 140), fill=hex_rgb("111827"))
    draw.rectangle((0, 0, 10, H), fill=hex_rgb("3b82f6"))
    draw.text((40, 36), "CUBICZAN AGENT PLATFORM", font=font(TITLE_FONT, 36), fill=hex_rgb("f8fafc"))
    draw.text(
        (40, 88),
        "One control plane. Three SKUs. Identity, money, and evidence.",
        font=font(BODY_FONT, 22),
        fill=hex_rgb("94a3b8"),
    )
    cards = [
        (48, "0x3b82f6", "0x93c5fd", "1  GOVERNED MCP GATEWAY", "Principal on tools/call + SSE\nVault rotate keeps input id\nTool allowlist / CHP gate"),
        (560, "0x22c55e", "0x86efac", "2  SPEND & MANDATE PLANE", "Propose -> mandate -> countersign\nStripe meter rail (default)\nx402 payment-required rail"),
        (1072, "0xeab308", "0xfde68a", "3  CFO AGENT MESH", "Claim -> agent -> lock -> docs\nASC 842 / 606 / 718 engines\nHMAC-chained evidence pack"),
    ]
    mono = font(MONO_FONT, 20)
    title_f = font(TITLE_FONT, 20)
    for x, bar, title_c, heading, body in cards:
        draw.rectangle((x, 200, x + 480, 720), fill=hex_rgb("020617"))
        draw.rectangle((x, 200, x + 480, 208), fill=hex_rgb(bar))
        draw.text((x + 24, 236), heading, font=title_f, fill=hex_rgb(title_c))
        y = 300
        for line in body.split("\n"):
            draw.text((x + 24, y), line, font=mono, fill=hex_rgb("e2e8f0"))
            y += 36
    draw.text(
        (48, 760),
        "MCP client   ->   Gateway :7474   ->   Spend :7475   ->   CFO mesh :7476",
        font=font(BODY_FONT, 22),
        fill=hex_rgb("cbd5e1"),
    )
    encode_png(img, outfile)


def pretty(obj: object) -> str:
    return json.dumps(obj, indent=2)


def copy_into_packages(name: str, src: Path) -> None:
    dest = ROOT / "packages" / name / "docs" / "screenshots" / src.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(src.read_bytes())


def main() -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    captures = json.loads((ROOT / "docs" / "screenshots" / "live-captures.json").read_text())

    ffmpeg_architecture(SHOTS / "architecture.png")

    ffmpeg_card(
        SHOTS / "gateway-principal.png",
        "GOVERNED MCP GATEWAY  ·  LIVE tools/call",
        "Principal is injected before the tool runs",
        "Bearer mcp_agt_payops_demo  ->  POST /mcp  ->  _meta.cubiczan.principal",
        pretty(captures["gateway_call"]),
        "0x3b82f6",
    )
    ffmpeg_card(
        SHOTS / "gateway-sse.png",
        "GOVERNED MCP GATEWAY  ·  LIVE SSE",
        "SSE does not drop identity",
        "GET /mcp/sse?once=1  — principal repeated on every event frame",
        captures["gateway_sse"],
        "0x3b82f6",
    )
    ffmpeg_card(
        SHOTS / "gateway-rotate.png",
        "GOVERNED MCP GATEWAY  ·  LIVE vault",
        "Rotate github_token without renaming the input",
        "POST /v1/credentials/github_token/rotate  — old secret dies, id stays",
        pretty(captures["gateway_rotate"]),
        "0x3b82f6",
    )

    ffmpeg_card(
        SHOTS / "spend-auto.png",
        "SPEND & MANDATE PLANE  ·  LIVE propose",
        "Under cap + covering mandate = auto LOCKED",
        "agt_payops proposes $12.00 to stripe.com — lane auto, CHP LOCKED",
        pretty(captures["spend_auto"]),
        "0x22c55e",
    )
    ffmpeg_card(
        SHOTS / "spend-countersign.png",
        "SPEND & MANDATE PLANE  ·  LIVE dual-key",
        "Over cap requires a human second key",
        "Agent cannot countersign itself. human.controller unlocks settlement.",
        pretty(captures["spend_countersign"]),
        "0x22c55e",
    )
    ffmpeg_card(
        SHOTS / "spend-settle.png",
        "SPEND & MANDATE PLANE  ·  LIVE rails",
        "Stripe is the SKU rail. x402 is optional.",
        "POST /v1/settle  rail=stripe  ->  evt_meter_*   |   rail=x402  ->  x402_payreq_*",
        pretty(captures["spend_settle"]),
        "0x22c55e",
    )

    ffmpeg_card(
        SHOTS / "cfo-unsealed.png",
        "CFO AGENT MESH  ·  LIVE gate",
        "Incomplete claims cannot seal",
        "LOCKED without source documents  ->  400  claim has no source documents",
        pretty(captures["cfo_unsealed"]),
        "0xeab308",
    )
    ffmpeg_card(
        SHOTS / "cfo-evidence.png",
        "CFO AGENT MESH  ·  LIVE evidence pack",
        "Every board claim traces to agent, lock, document",
        "GET /v1/evidence/:id  after document + human lock + lease engine",
        pretty(captures["cfo_evidence"]),
        "0xeab308",
    )
    ffmpeg_card(
        SHOTS / "cfo-lease.png",
        "CFO AGENT MESH  ·  LIVE ASC 842",
        "Finance lease rollforward ends at 0.00 liability",
        "POST /v1/engines/lease  24 months, ownership transfer, IBR 6%",
        pretty(captures["cfo_lease"]),
        "0xeab308",
    )

    mapping = {
        "governed-mcp-gateway": [
            "architecture.png",
            "gateway-principal.png",
            "gateway-sse.png",
            "gateway-rotate.png",
        ],
        "spend-mandate-plane": [
            "architecture.png",
            "spend-auto.png",
            "spend-countersign.png",
            "spend-settle.png",
        ],
        "cfo-agent-mesh": [
            "architecture.png",
            "cfo-unsealed.png",
            "cfo-evidence.png",
            "cfo-lease.png",
        ],
    }
    for pkg, names in mapping.items():
        for name in names:
            copy_into_packages(pkg, SHOTS / name)
    print("wrote", SHOTS)


if __name__ == "__main__":
    main()
