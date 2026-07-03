# Cobalt Downloader for YouTube & TikTok

A Tampermonkey userscript that adds a **Download** dropdown to YouTube and TikTok pages, using working community instances from [cobalt.directory](https://cobalt.directory/).

## Features

- Auto-fetches working cobalt instances from `cobalt.directory/api/working?type=api` (cached for 5 minutes)
- Uses cobalt v10+ API (`POST /` with `Accept: application/json`)
- Dropdown options: Best quality, 720p, Audio only, Mute video
- Button placed next to like/share actions, with floating fallback
- **Shadow DOM piercing** — finds YouTube's action bar inside Polymer web components
- Works on all pages (watch, shorts, home, profile, feed)
- Floating button fallback in bottom-right corner if native injection fails
- Automatic fallback to the next instance if one fails
- Exponential backoff with jitter between retries
- Failed instances are temporarily skipped for 2 minutes
- DOM observer is throttled and tracks attribute changes
- Survives SPA navigation (YouTube/TikTok route changes)
- Diagnostic logging (`[CobaltDL]` in console)

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Open `cobalt-downloader.user.js` in your browser.
3. Tampermonkey will prompt you to install the script.

## Usage

1. Open any YouTube or TikTok page.
2. Click the **Download** button near the like/share actions (or the floating button in the bottom-right corner as fallback).
3. Select the desired format.
4. The download will start in a new tab.

> **Tip:** Check the browser console (F12) for `[CobaltDL]` diagnostic messages if the button doesn't appear.

## Files

- `cobalt-downloader.user.js` — the userscript
- `README.md` — this file

## API Reference

- https://cobalt.directory/api
- https://cobalt.directory/api/working?type=api

## License

MIT
