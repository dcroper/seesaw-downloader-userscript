# Seesaw Post Downloader

A userscript for [Tampermonkey](https://www.tampermonkey.net/) (also works with Violentmonkey) that adds a **⬇ Download** button to every post in the [Seesaw](https://app.seesaw.me) family feed. One click saves all the photos and videos in that post, with the **date taken set to the date of the post** — so they land in the right place in Google Photos, Apple Photos, Windows Photos, etc.

> Unofficial. Not affiliated with or endorsed by Seesaw Learning. Intended for parents saving their own family's content. Seesaw can change their site at any time, which may break this script.

## Features

- Download button on each post, including posts loaded by infinite scroll
- Downloads **every page** of multi-page posts, photos and videos, in page order
- Files are saved in their **original format** (no re-encoding)
- Sets the capture date to the post's timestamp:
  - **JPEG** — EXIF `DateTimeOriginal`, `DateTimeDigitized`, `DateTime`
  - **MP4 / MOV** — `mvhd` / `tkhd` / `mdhd` creation & modification time
- Collision-free file names that sort chronologically, so everything can go in one folder:

  ```
  seesaw_2026-10-06_193104_931d19e1_01.jpg
  seesaw_2026-10-06_193104_931d19e1_02.mp4
  │      │          │      │        └ page number within the post
  │      │          │      └ first 8 chars of the post id
  │      │          └ time (HHMMSS, local)
  │      └ date (local)
  └ prefix
  ```

## Install

1. Install the Tampermonkey extension for your browser.
2. **Chrome / Edge:** open the extensions page, open Tampermonkey's *Details*, and enable **Allow User Scripts** (older versions: enable *Developer mode* on the extensions page). Scripts won't run without this.
3. Click to install: **[seesaw-downloader.user.js](https://raw.githubusercontent.com/dcroper/seesaw-downloader-userscript/main/seesaw-downloader.user.js)**
4. Open (or hard-reload with `Ctrl+F5`) your Seesaw family feed.

Tampermonkey will pick up new versions automatically.

## Usage

Click **⬇ Download** under any post. The button shows progress and how many files were saved. The first time, your browser may ask to allow multiple downloads from the site — choose *Allow*.

To save everything into one folder, set your browser's download location to that folder.

### Options

Edit the `CONFIG` block at the top of the script:

| Option | Default | Description |
|---|---|---|
| `downloadMode` | `'files'` | `'files'` = one download per photo/video; `'zip'` = one `.zip` per post (entries also get the post date as their modified time) |
| `filePrefix` | `'seesaw'` | Prefix for file names |
| `pageWaitMs` | `8000` | Max wait per page when falling back to clicking through a post |
| `debug` | `false` | Verbose console logging |

## Limitations

- Only JPEG and MP4/MOV get a date written into the file. Other formats (PNG, GIF, WebP, HEIC) are saved unchanged.
- Image resolution is whatever Seesaw stores — sometimes that is fairly small.
- Videos served only as a stream (`blob:` URLs) can't be downloaded.

## Troubleshooting

Open DevTools (`F12`) → Console and filter for `SSDL`. You should see `Seesaw Post Downloader loaded` and a post count.

For details on a specific post, run (0 = first post on the page):

```js
await ssdlDebug(0)
```

When opening an issue, **remove names, IDs and tokens** from anything you paste.

## How it works

The script reads the post id from the page, requests the full post from Seesaw's own `item_v2` endpoint (the same request the web app makes when you open a post), and collects each page's image or video URL. If that request fails, it falls back to clicking through the post's pages. Each file is downloaded, its date metadata is patched in place, and it is saved via a normal browser download.

## License

[MIT](LICENSE)
