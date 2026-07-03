# Cobalt Downloader for YouTube & TikTok

A Tampermonkey userscript that adds a **Download** dropdown to YouTube and TikTok pages, using working community instances from [cobalt.directory](https://cobalt.directory/).

**Version:** 2.3.0 | **Author:** Anko3 | **License:** MIT

## Features

### Instance Selection & Reliability

- Fetches working cobalt instances from `cobalt.directory/api/tests` (score-sorted, filtered by platform test status), with fallback to `cobalt.directory/api/working?type=api`
- Instance list cached for 5 minutes (via `GM.setValue`/`GM.getValue`)
- Filters out instances requiring Cloudflare Turnstile authentication
- Platform-aware filtering: checks `youtube`, `youtube-shorts`, and `tiktok` test results
- Automatic fallback to the next instance if one fails
- Exponential backoff with jitter between retries (up to 3 attempts)
- Failed instances are temporarily skipped for 2 minutes
- Tampermonkey menu commands to manually refresh instance cache or clear failed instances

### Download Options

- **Best quality** — auto mode, `videoQuality: max`
- **720p video** — auto mode, `videoQuality: 720`
- **Audio only** — audio mode, MP3 format
- **Mute video** — mute mode, `videoQuality: 1080`
- Quality picker modal for instances returning multiple format options (picker response)
- Supports `redirect`, `tunnel`, `local-processing`, and `picker` cobalt API response types
- `filenameStyle: pretty` for clean download filenames

### YouTube Integration

- Button injected into watch page action bar (`#top-level-buttons-computed`, `#actions`, `ytd-menu-renderer`, etc.)
- YouTube Shorts support — finds the active reel and injects into its right-side overlay actions
- **Shadow DOM piercing** — traverses Polymer web component shadow roots to find action bars
- Filters out comments section `#actions` to avoid injecting in the wrong location
- Fallback: inserts after subscribe button if action bar isn't found
- SPA navigation hooks: `pushState`, `replaceState`, `popstate`, `yt-navigate-finish`, `yt-page-data-updated`, `yt-visibility-refresh`
- Retry injection at 100ms, 500ms, 1.5s, 3s, 5s, 8s after navigation
- Only activates on `/watch` and `/shorts` pages (not homepage, channel, etc.)

### TikTok Integration

- **XHR & fetch interception** — monkey-patches `XMLHttpRequest.prototype.open/send` and `window.fetch` to capture video URLs from TikTok API responses (`aweme_list`, `item_list`, `/api/recommend/`, etc.)
- Extracts video URLs, play addresses, and cover URLs from captured API data
- **MSE-aware video tracking** — monitors `play` events, `timeupdate` resets, and `<img>` cover `src` changes to detect the active video in the For You feed (blob URLs don't change on scroll)
- **React fiber inspection** — traverses React internal component tree (`__reactProps$`, `__reactFiber$`) to extract aweme IDs and author usernames
- Multi-strategy URL detection:
  1. Direct URL from pathname (`/@user/video/123`, `/@user/photo/123`, `/t/abc`, `/v/123.html`)
  2. Proactively tracked URL (from cover image / play event tracking)
  3. Reel anchor tag matching
  4. XHR-captured data matched by video ID
  5. XHR-captured data matched by media src URL
  6. React fiber props extraction
  7. XHR-captured data matched by author username (most recent first)
  8. `__UNIVERSAL_DATA_FOR_REHYDRATION__` JSON parsing (with author matching)
  9. `SIGI_STATE` JSON parsing (legacy TikTok state)
  10. Video element `src`/`data-src` CDN URL parsing
- TikTok uses floating button fallback (React re-renders destroy inline buttons)

### UI & UX

- Dropdown button with download icon and label
- Floating button fallback in bottom-right corner if native injection fails
- Loading state with spinning icon during download
- "Done!" confirmation feedback after download triggers
- Quality picker modal with close button and click-outside-to-close
- Menu positioned smartly (opens above button if insufficient space below)
- Closes on scroll, outside click, or item selection
- Throttled MutationObserver (500ms) with backup 500ms interval for lazy-rendered content
- Stale button detection — removes and re-injects if button becomes invisible or orphaned

### Diagnostics

- All operations logged to console with `[CobaltDL]` prefix
- Detailed logging for instance selection, URL detection strategy, and download flow

## Install

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Open `cobalt-downloader.user.js` in your browser (or install from the GitHub repo).
3. Tampermonkey will prompt you to install the script.

## Usage

1. Open any YouTube `/watch` or `/shorts` page, or any TikTok page.
2. Click the **Download** button (near like/share actions on YouTube, or the floating button in the bottom-right corner on TikTok).
3. Select the desired format: Best quality, 720p, Audio only, or Mute video.
4. If a picker appears, select the quality you want.
5. The download will start automatically.

> **Tip:** Check the browser console (F12) for `[CobaltDL]` diagnostic messages if the button doesn't appear or downloads fail.
>
> **TikTok Tip:** If the download URL is wrong, scroll to the video you want, wait a second for detection, then click Download. The script uses multiple strategies to identify the active video.

## Tampermonkey Menu Commands

- **Refresh Cobalt instances** — clears the instance cache so the next download fetches fresh instances
- **Clear failed instances** — clears the failed instance cache, allowing all instances to be retried

## Files

- `cobalt-downloader.user.js` — the userscript (v2.3.0)
- `LICENSE` — MIT license
- `README.md` — this file

## API Reference

- [cobalt.directory API docs](https://cobalt.directory/api)
- `https://cobalt.directory/api/working?type=api` — working instances list
- `https://cobalt.directory/api/tests` — instance test results with scores and platform status

## License

MIT — see [LICENSE](LICENSE)
