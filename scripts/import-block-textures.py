#!/usr/bin/env python3
"""
Import Minecraft Wiki block texture images for GTB.

This script:
1. Reads the official block list from data/blocks.json.
2. Scrapes https://minecraft.wiki/w/List_of_block_textures.
3. Downloads matching texture PNGs into public/block-textures/.
4. Estimates visible named colors from the actual PNG pixels.
5. Writes data/block-textures.json for the game server to use.

It intentionally uses only Python's standard library so the project stays easy
to run on a fresh machine.
"""

import argparse
import json
import math
import os
import re
import struct
import sys
import time
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone
from html import unescape
from html.parser import HTMLParser
from urllib.parse import quote, unquote, urljoin, urlparse
from urllib.request import Request, urlopen

SOURCE_URL = "https://minecraft.wiki/w/List_of_block_textures"
USER_AGENT = "GTBGame/0.1 local texture importer; https://minecraft.wiki/"

DROP_TRAILING_WORDS = {
    "texture",
    "textures",
    "top",
    "bottom",
    "side",
    "sides",
    "front",
    "back",
    "left",
    "right",
    "inside",
    "inner",
    "outside",
    "outer",
    "end",
    "ends",
    "stem",
    "stems",
    "overlay",
    "particle",
    "lit",
    "unlit",
    "on",
    "off",
    "open",
    "closed",
    "powered",
    "unpowered",
    "active",
    "inactive",
    "north",
    "south",
    "east",
    "west",
    "up",
    "down",
    "stage",
    "age",
}

COLOR_PALETTE = {
    "white": (240, 240, 240),
    "light gray": (160, 160, 160),
    "gray": (92, 92, 92),
    "black": (28, 28, 28),
    "red": (170, 45, 35),
    "orange": (218, 112, 36),
    "yellow": (230, 190, 55),
    "lime": (120, 190, 55),
    "green": (65, 125, 55),
    "cyan": (45, 150, 155),
    "teal": (35, 110, 115),
    "light blue": (95, 165, 230),
    "blue": (55, 80, 180),
    "purple": (125, 70, 175),
    "magenta": (190, 75, 190),
    "pink": (230, 130, 165),
    "brown": (120, 75, 45),
    "tan": (185, 150, 95),
}


class TextureGalleryParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.entries = []
        self.current = None
        self.in_gallery_text = False
        self.gallery_text_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        classes = set(attrs.get("class", "").split())

        if tag == "li" and "gallerybox" in classes:
            self.current = {
                "image_src": "",
                "image_alt": "",
                "file_title": "",
                "file_href": "",
                "page_titles": [],
                "gallery_text": "",
            }
            return

        if not self.current:
            return

        if tag == "div" and "gallerytext" in classes:
            self.in_gallery_text = True
            self.gallery_text_depth = 1
            return

        if self.in_gallery_text:
            self.gallery_text_depth += 1

        if tag == "img":
            self.current["image_src"] = attrs.get("src", "")
            self.current["image_alt"] = attrs.get("alt", "")

        if tag == "a":
            href = attrs.get("href", "")
            title = attrs.get("title", "")
            if href.startswith("/w/File:"):
                self.current["file_href"] = href
                self.current["file_title"] = title
            elif self.in_gallery_text and title and not title.startswith("File:"):
                self.current["page_titles"].append(title)

    def handle_endtag(self, tag):
        if not self.current:
            return

        if self.in_gallery_text:
            self.gallery_text_depth -= 1
            if self.gallery_text_depth <= 0:
                self.in_gallery_text = False

        if tag == "li":
            if self.current.get("image_src"):
                self.current["gallery_text"] = clean_spaces(self.current["gallery_text"])
                self.entries.append(self.current)
            self.current = None
            self.in_gallery_text = False

    def handle_data(self, data):
        if self.current and self.in_gallery_text:
            self.current["gallery_text"] += data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--blocks", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--asset-dir", required=True)
    parser.add_argument("--max-downloads", type=int, default=0, help="0 means no cap")
    args = parser.parse_args()

    with open(args.blocks, "r", encoding="utf-8") as handle:
        blocks = json.load(handle)

    block_ids = {block["id"] for block in blocks}
    name_to_id = build_name_index(blocks)
    os.makedirs(args.asset_dir, exist_ok=True)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    print(f"Fetching {SOURCE_URL}")
    html = fetch_text(SOURCE_URL)
    entries = parse_gallery(html)
    print(f"Found {len(entries)} texture gallery entries")

    by_block = defaultdict(list)
    unmatched = 0
    for entry in entries:
        block_id = match_block_id(entry, block_ids, name_to_id)
        if block_id:
            by_block[block_id].append(entry)
        else:
            unmatched += 1

    print(f"Matched {len(by_block)} blocks; skipped {unmatched} unmapped gallery entries")

    output = {
        "_meta": {
            "source": SOURCE_URL,
            "blockCount": len(blocks),
            "textureEntryCount": 0,
            "matchedBlockCount": 0,
            "downloadedTextureCount": 0,
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "notes": "Colors are estimated from Minecraft Wiki texture PNG pixels. Omitted blocks were not confidently mapped from the texture gallery.",
        }
    }

    downloaded = 0
    for index, block_id in enumerate(sorted(by_block), start=1):
        textures = []
        combined_pixels = []
        seen_urls = set()

        for entry in by_block[block_id]:
            remote_url = original_image_url(entry["image_src"], entry.get("file_href", ""))
            if not remote_url or remote_url in seen_urls:
                continue
            seen_urls.add(remote_url)

            if args.max_downloads and downloaded >= args.max_downloads:
                break

            label = texture_label(entry)
            local_filename = safe_file_name(f"{block_id.split(':', 1)[1]}__{label}.png")
            local_abs = os.path.join(args.asset_dir, local_filename)
            local_path = "/" + os.path.relpath(local_abs, "public").replace(os.sep, "/")

            try:
                if not os.path.exists(local_abs):
                    download_file(remote_url, local_abs)
                    downloaded += 1
                    time.sleep(0.05)
                pixels = png_pixels(local_abs)
                combined_pixels.extend(pixels)
                textures.append(
                    {
                        "label": label,
                        "remoteUrl": remote_url,
                        "localPath": local_path,
                    }
                )
            except Exception as error:
                print(f"Skipped {block_id} texture {remote_url}: {error}", file=sys.stderr)

        if textures:
            colors = apply_tint_colors(block_id, estimate_colors(combined_pixels))
            output[block_id] = {
                "textures": textures,
                "colors": colors,
                "notes": texture_notes(block_id),
            }

        if index % 100 == 0:
            print(f"Processed {index}/{len(by_block)} mapped blocks")

    derived_count = add_derived_texture_facts(output, blocks)

    block_entries = [key for key in output.keys() if not key.startswith("_")]
    output["_meta"]["matchedBlockCount"] = len(block_entries)
    output["_meta"]["textureEntryCount"] = sum(len(output[key]["textures"]) for key in block_entries)
    output["_meta"]["downloadedTextureCount"] = downloaded
    output["_meta"]["derivedTextureEntryCount"] = derived_count

    temp_path = args.out + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, indent=2, sort_keys=True)
        handle.write("\n")
    os.replace(temp_path, args.out)

    print(
        "Texture import complete: "
        f"{len(block_entries)} blocks, "
        f"{output['_meta']['textureEntryCount']} texture references, "
        f"{derived_count} derived blocks, "
        f"{downloaded} new downloads"
    )


def build_name_index(blocks):
    index = {}
    for block in blocks:
        block_id = block["id"]
        names = {
            block["name"],
            block_id.split(":", 1)[1].replace("_", " "),
        }
        if block["name"].startswith("Block of "):
            names.add(block["name"][9:] + " Block")
        for name in names:
            index[normalize_name(name)] = block_id
    return index


def fetch_text(url):
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        return response.read().decode("utf-8")


def download_file(url, path):
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        data = response.read()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("download did not return a PNG")
    with open(path, "wb") as handle:
        handle.write(data)


def parse_gallery(html):
    parser = TextureGalleryParser()
    parser.feed(html)
    return parser.entries


def match_block_id(entry, block_ids, name_to_id):
    candidates = []
    candidates.extend(entry.get("page_titles", []))
    candidates.append(entry.get("image_alt", ""))
    candidates.append(entry.get("file_title", ""))
    candidates.append(entry.get("gallery_text", ""))
    candidates.append(file_name_from_href(entry.get("file_href", "")))
    candidates.append(file_name_from_url(entry.get("image_src", "")))

    for candidate in candidates:
        for cleaned in candidate_names(candidate):
            direct_id = "minecraft:" + normalize_name(cleaned).replace(" ", "_")
            if direct_id in block_ids:
                return direct_id
            indexed = name_to_id.get(normalize_name(cleaned))
            if indexed:
                return indexed

    return None


def candidate_names(text):
    text = unescape(unquote(text or ""))
    text = re.sub(r"\.[Pp][Nn][Gg].*$", "", text)
    text = re.sub(r"\([^)]*\)", " ", text)
    text = re.sub(r"\bJE\d*\b|\bBE\d*\b", " ", text)
    text = re.sub(r"\bJava Edition\b|\bBedrock Edition\b", " ", text, flags=re.I)
    text = re.sub(r"\btexture\b", " texture ", text, flags=re.I)
    text = clean_spaces(text.replace("_", " "))

    results = []
    pieces = [text]
    if " - " in text:
        pieces.extend(text.split(" - "))

    for piece in pieces:
        words = clean_spaces(piece).split()
        while words and words[-1].lower() in DROP_TRAILING_WORDS:
            words.pop()
        if words:
            results.append(" ".join(words))

    return unique(results)


def normalize_name(text):
    text = unescape(unquote(text or "")).lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return clean_spaces(text)


def clean_spaces(text):
    return re.sub(r"\s+", " ", text or "").strip()


def unique(items):
    seen = set()
    output = []
    for item in items:
        key = item.lower()
        if key and key not in seen:
            seen.add(key)
            output.append(item)
    return output


def file_name_from_href(href):
    if not href:
        return ""
    return href.rsplit("File:", 1)[-1]


def file_name_from_url(url):
    if not url:
        return ""
    path = urlparse(url).path
    if "/images/thumb/" in path:
        rest = path.split("/images/thumb/", 1)[1]
        return rest.split("/", 1)[0]
    return path.rsplit("/", 1)[-1]


def original_image_url(src, file_href):
    if not src and not file_href:
        return ""

    if file_href:
        file_name = file_name_from_href(file_href)
        if file_name:
            return "https://minecraft.wiki/images/" + quote(unquote(file_name), safe="()_.-")

    absolute = urljoin(SOURCE_URL, src)
    parsed = urlparse(absolute)
    path = parsed.path
    if "/images/thumb/" in path:
        file_name = path.split("/images/thumb/", 1)[1].split("/", 1)[0]
        return "https://minecraft.wiki/images/" + quote(unquote(file_name), safe="()_.-")
    return absolute.split("?", 1)[0]


def texture_label(entry):
    label = entry.get("image_alt") or entry.get("file_title") or entry.get("gallery_text") or "texture"
    label = clean_spaces(unescape(label))
    label = re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_").lower()
    return label[:90] or "texture"


def safe_file_name(name):
    name = re.sub(r"[^A-Za-z0-9_.-]+", "_", name)
    name = re.sub(r"_+", "_", name).strip("._")
    return name or "texture.png"


def png_pixels(path):
    with open(path, "rb") as handle:
        data = handle.read()
    if not data.startswith(b"\x89PNG\r\n\x1a\n"):
        raise ValueError("not a PNG")

    pos = 8
    width = height = bit_depth = color_type = None
    palette = []
    idat = bytearray()

    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        chunk_type = data[pos + 4 : pos + 8]
        chunk_data = data[pos + 8 : pos + 8 + length]
        pos += 12 + length

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, _, _, _ = struct.unpack(">IIBBBBB", chunk_data)
        elif chunk_type == b"PLTE":
            palette = [tuple(chunk_data[i : i + 3]) for i in range(0, len(chunk_data), 3)]
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        elif chunk_type == b"IEND":
            break

    if bit_depth not in {1, 2, 4, 8}:
        raise ValueError(f"unsupported PNG bit depth {bit_depth}")
    if color_type not in {0, 2, 3, 6}:
        raise ValueError(f"unsupported PNG color type {color_type}")
    if color_type in {2, 6} and bit_depth != 8:
        raise ValueError(f"unsupported truecolor PNG bit depth {bit_depth}")

    channels = {0: 1, 2: 3, 3: 1, 6: 4}[color_type]
    stride = math.ceil(width * bit_depth * channels / 8)
    filter_bpp = channels if bit_depth == 8 else 1
    raw = zlib.decompress(bytes(idat))
    rows = []
    cursor = 0
    previous = [0] * stride

    for _ in range(height):
        filter_type = raw[cursor]
        cursor += 1
        row = list(raw[cursor : cursor + stride])
        cursor += stride
        row = unfilter(row, previous, filter_bpp, filter_type)
        rows.append(row)
        previous = row

    pixels = []
    for row in rows:
        if bit_depth < 8 and color_type in {0, 3}:
            samples = unpack_samples(row, bit_depth, width)
            for sample in samples:
                if color_type == 0:
                    value = int(round(sample * 255 / ((1 << bit_depth) - 1)))
                    pixels.append((value, value, value))
                elif sample < len(palette):
                    pixels.append(palette[sample])
            continue

        for x in range(width):
            i = x * channels
            if color_type == 0:
                value = row[i]
                pixels.append((value, value, value))
            elif color_type == 2:
                pixels.append((row[i], row[i + 1], row[i + 2]))
            elif color_type == 3:
                palette_index = row[i]
                if palette_index < len(palette):
                    pixels.append(palette[palette_index])
            elif color_type == 6:
                alpha = row[i + 3]
                if alpha >= 32:
                    pixels.append((row[i], row[i + 1], row[i + 2]))
    return pixels


def unpack_samples(row, bit_depth, width):
    mask = (1 << bit_depth) - 1
    samples = []
    for byte in row:
        for shift in range(8 - bit_depth, -1, -bit_depth):
            samples.append((byte >> shift) & mask)
            if len(samples) == width:
                return samples
    return samples


def unfilter(row, previous, bpp, filter_type):
    out = row[:]
    for i, value in enumerate(row):
        left = out[i - bpp] if i >= bpp else 0
        up = previous[i] if previous else 0
        upper_left = previous[i - bpp] if previous and i >= bpp else 0

        if filter_type == 0:
            out[i] = value
        elif filter_type == 1:
            out[i] = (value + left) & 255
        elif filter_type == 2:
            out[i] = (value + up) & 255
        elif filter_type == 3:
            out[i] = (value + ((left + up) // 2)) & 255
        elif filter_type == 4:
            out[i] = (value + paeth(left, up, upper_left)) & 255
        else:
            raise ValueError(f"unsupported PNG filter {filter_type}")
    return out


def paeth(a, b, c):
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def estimate_colors(pixels):
    if not pixels:
        return []

    counts = Counter(nearest_color(pixel) for pixel in pixels if useful_pixel(pixel))
    total = sum(counts.values())
    if total == 0:
        return []

    colors = []
    for color, count in counts.most_common():
        share = count / total
        if share >= 0.08 or (len(colors) < 2 and share >= 0.04):
            colors.append(color)

    if "tan" in colors and "brown" in colors:
        colors.remove("tan")
    return colors[:6]


def apply_tint_colors(block_id, colors):
    short = block_id.split(":", 1)[1]
    tintable = (
        short.endswith("_leaves")
        or short in {
            "short_grass",
            "tall_grass",
            "fern",
            "large_fern",
            "grass_block",
            "vine",
            "cave_vines",
            "cave_vines_plant",
        }
    )
    if not tintable:
        return colors

    without_gray_only = [color for color in colors if color not in {"gray", "light gray", "white"}]
    return unique(["green", *without_gray_only])[:6]


def texture_notes(block_id):
    short = block_id.split(":", 1)[1]
    if short.endswith("_leaves") or short in {"short_grass", "tall_grass", "fern", "large_fern", "grass_block", "vine", "cave_vines", "cave_vines_plant"}:
        return "Estimated from Minecraft Wiki texture pixels, with Minecraft biome tint accounted for on tintable plant textures."
    return "Estimated from downloaded Minecraft Wiki texture pixels for this exact block when mapped confidently."


def add_derived_texture_facts(output, blocks):
    block_ids = {block["id"] for block in blocks}
    derived = 0

    for block in blocks:
        block_id = block["id"]
        if block_id in output:
            continue

        source_id = derived_source_id(block_id, output, block_ids)
        if not source_id:
            continue

        source = output[source_id]
        colors = source.get("colors", [])
        if block_id.split(":", 1)[1].startswith("potted_"):
            colors = unique([*colors, "brown", "tan"])[:6]
        output[block_id] = {
            "textures": [
                {
                    **texture,
                    "inheritedFrom": source_id,
                }
                for texture in source.get("textures", [])
            ],
            "colors": colors,
            "notes": f"Derived from {source_id} because this block variant reuses the same base material texture.",
        }
        derived += 1

    return derived


def derived_source_id(block_id, output, block_ids):
    short = block_id.split(":", 1)[1]

    if short.startswith("waxed_"):
        candidate = "minecraft:" + short.removeprefix("waxed_")
        if candidate in output:
            return candidate

    candidates = []
    suffixes = [
        "_wall_hanging_sign",
        "_wall_sign",
        "_hanging_sign",
        "_fence_gate",
        "_pressure_plate",
        "_button",
        "_fence",
        "_stairs",
        "_slab",
        "_wall",
        "_carpet",
        "_wall_banner",
        "_banner",
        "_wall_head",
        "_head",
        "_wall_torch",
        "_torch",
        "_wood",
    ]

    for suffix in suffixes:
        if not short.endswith(suffix):
            continue
        base = short[: -len(suffix)]
        if suffix in {"_wall_hanging_sign", "_hanging_sign"}:
            candidates.extend([f"{base}_hanging_sign", f"{base}_planks", f"{base}_stem", base])
        elif suffix in {"_wall_sign", "_sign"}:
            candidates.extend([f"{base}_sign", f"{base}_planks", f"{base}_stem", base])
        elif suffix in {"_fence", "_fence_gate", "_pressure_plate", "_button", "_stairs", "_slab"}:
            candidates.extend([
                base,
                f"{base}s",
                base.replace("_brick", "_bricks"),
                f"{base}_planks",
                f"{base}_mosaic",
                f"{base}_block",
            ])
        elif suffix == "_wall":
            candidates.extend([base, f"{base}s", base.replace("_brick", "_bricks")])
        elif suffix == "_carpet":
            candidates.extend([f"{base}_wool", base])
        elif suffix in {"_wall_banner", "_banner"}:
            candidates.extend([f"{base}_wool", base])
        elif suffix in {"_wall_head", "_head"}:
            candidates.extend([base])
        elif suffix in {"_wall_torch", "_torch"}:
            candidates.extend([f"{base}_torch", base])
        elif suffix == "_wood":
            candidates.extend([f"{base}_log", base])

    if short.startswith("potted_"):
        candidates.extend([short.removeprefix("potted_"), "flower_pot"])

    for candidate in candidates:
        source_id = "minecraft:" + candidate
        if source_id in output and source_id in block_ids:
            return source_id

    return None


def useful_pixel(pixel):
    r, g, b = pixel
    return max(r, g, b) - min(r, g, b) > 6 or max(r, g, b) > 35


def nearest_color(pixel):
    r, g, b = pixel
    best_name = "gray"
    best_distance = math.inf
    for name, (pr, pg, pb) in COLOR_PALETTE.items():
        distance = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2
        if distance < best_distance:
            best_name = name
            best_distance = distance
    return best_name


if __name__ == "__main__":
    main()
