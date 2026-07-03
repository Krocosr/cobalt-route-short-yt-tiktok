// ==UserScript==
// @name         Cobalt Downloader for YouTube & TikTok
// @namespace    cobalt-downloader
// @version      2.3.0
// @description  Add a download dropdown to YouTube and TikTok, powered by working cobalt.directory community instances.
// @author       Anko3
// @match        *://*.youtube.com/*
// @match        *://*.tiktok.com/*
// @grant        GM.xmlHttpRequest
// @grant        GM.setValue
// @grant        GM.getValue
// @grant        GM.registerMenuCommand
// @connect      cobalt.directory
// @connect      *
// @run-at       document-start
// ==/UserScript==
//
// MIT License
//
// Copyright (c) 2026 Anko3
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

(function () {
    'use strict';

    const DIRECTORY_API = 'https://cobalt.directory/api/working?type=api';
    const TESTS_API = 'https://cobalt.directory/api/tests';
    const CACHE_KEY = 'cobalt_instances_v2';
    const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const FAILED_CACHE_KEY = 'cobalt_failed_instances';
    const FAILED_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes
    const MAX_RETRIES = 3;
    const REQUEST_TIMEOUT_MS = 30000;
    const OBSERVER_THROTTLE_MS = 500;

    const querySelectorInShadow = (hostSelector, innerSelector) => {
        const host = document.querySelector(hostSelector);
        if (host && host.shadowRoot) {
            return host.shadowRoot.querySelector(innerSelector);
        }
        return null;
    };

    const querySelectorDeep = (selector, root = document) => {
        const result = root.querySelector(selector);
        if (result) return result;
        const all = root.querySelectorAll('*');
        for (const el of all) {
            if (el.shadowRoot) {
                const found = querySelectorDeep(selector, el.shadowRoot);
                if (found) return found;
            }
        }
        return null;
    };

    const currentHost = () => (window.__COBALT_HOST__ || location.hostname).toLowerCase();
    const isYouTube = () => /(^|\.)youtube\.com$/.test(currentHost()) && !/^accounts\./.test(currentHost());
    const isTikTok = () => /(^|\.)tiktok\.com$/.test(currentHost());

    const TIKTOK_VIDEO_PATTERN = /^\/@[^/]+\/video\/\d+/;
    const TIKTOK_PHOTO_PATTERN = /^\/@[^/]+\/photo\/\d+/;
    const TIKTOK_SHORT_PATTERN = /^\/t\/[A-Za-z0-9]+/;
    const TIKTOK_V_PATTERN = /^\/v\/\d+\.html/;

    let tiktokFeedUrls = [];
    let tiktokActiveVideoUrl = null;
    let tiktokActiveCoverSrc = null;
    const TIKTOK_API_PATTERNS = ['/api/recommend/', 'item_list', '/api/post/', '/aweme/v1/', '/aweme/v2/', 'recommend_list', '/api/feed/', 'aweme_list', '/api/comment/list', '/api/v1/', '/api/recommend/item_list/', '/api/feed/recommend/', '/api/explore/'];
    const isTikTokApiUrl = (url) => {
        if (!url || typeof url !== 'string') return false;
        return TIKTOK_API_PATTERNS.some(p => url.includes(p));
    };
    const processTikTokApiResponse = (text) => {
        try {
            const data = JSON.parse(text);
            const awemeList = data.aweme_list || data.itemList || data.awemeList || data.items || data.data?.aweme_list || data.data?.items || [];
            for (const item of awemeList) {
                const itemId = item.id || item.aweme_id || item.awemeId || item.item_id || item.awemeIdStr;
                const authorId = item.author?.unique_id || item.author?.uniqueId || item.authorInfo?.uniqueId || item.author?.nickname;
                if (itemId && authorId) {
                    const url = `https://www.tiktok.com/@${authorId}/video/${itemId}`;
                    const playUrls = item.video?.play_addr?.url_list || [];
                    const coverUrls = item.video?.cover?.url_list || [];
                    const dynamicCovers = item.video?.dynamic_cover?.url_list || [];
                    const allMediaUrls = [...playUrls, ...coverUrls, ...dynamicCovers];
                    if (!tiktokFeedUrls.some(u => u.videoId === itemId)) {
                        tiktokFeedUrls.push({ url, videoId: itemId, authorId, playUrls, coverUrls, allMediaUrls });
                        log('TikTok: captured video URL:', url);
                    }
                }
            }
        } catch (e) { /* ignore */ }
    };
    const safeGetResponseText = (xhr) => {
        try {
            if (xhr.readyState !== 4) return null;
            // responseText only works when responseType is '' or 'text'
            if (!xhr.responseType || xhr.responseType === 'text') {
                return xhr.responseText;
            }
            // For other responseTypes, try to extract text from response
            if (xhr.responseType === 'json') {
                return JSON.stringify(xhr.response);
            }
            if (xhr.responseType === 'arraybuffer' && xhr.response instanceof ArrayBuffer) {
                return new TextDecoder().decode(xhr.response);
            }
            if (xhr.responseType === 'blob' && xhr.response instanceof Blob) {
                // Can't read synchronously, skip
                return null;
            }
            return null;
        } catch (e) {
            return null;
        }
    };
    // TikTok For You feed uses MSE (Media Source Extensions) with player reuse.
    // The <video> element's src is a blob: URL that does NOT change when scrolling.
    // There is no poster attribute on the video element either.
    // Instead, we track:
    //   - src changes on img elements (cover image, unique per video)
    //   - play events (fire when a new video starts after scroll)
    //   - timeupdate with currentTime near 0 (new video started)
    const setupTikTokVideoTracking = () => {
        if (!isTikTok()) return;
        let lastCurrentTime = 0;
        let detectTimer = null;

        // Debounced detection — re-extract the URL from the DOM
        const triggerDetection = () => {
            if (detectTimer) clearTimeout(detectTimer);
            detectTimer = setTimeout(() => {
                detectTimer = null;
                const result = getTikTokVideoUrlInner();
                if (result) {
                    tiktokActiveVideoUrl = result;
                    log('TikTok: proactively detected active video URL:', result);
                }
            }, 300);
        };

        // Watch for src attribute changes on img elements inside video containers.
        // TikTok uses an <img> cover image whose src changes per video.
        const observer = new MutationObserver((mutations) => {
            for (const mut of mutations) {
                if (mut.type === 'attributes' && mut.attributeName === 'src' && mut.target.tagName === 'IMG') {
                    const newSrc = mut.target.getAttribute('src') || '';
                    // Only track cover images (TikTok CDN URLs, not data URIs or blobs)
                    if (newSrc && newSrc.includes('tiktok') && newSrc.includes('sign') && newSrc !== tiktokActiveCoverSrc) {
                        tiktokActiveCoverSrc = newSrc;
                        tiktokActiveVideoUrl = null;
                        log('TikTok: cover image src changed, triggering re-detection');
                        triggerDetection();
                    }
                }
            }
        });
        observer.observe(document.documentElement, {
            subtree: true,
            attributes: true,
            attributeFilter: ['src']
        });

        // Listen for play events (fires when a new video starts after scroll)
        document.addEventListener('play', (e) => {
            if (e.target && e.target.tagName === 'VIDEO') {
                log('TikTok: play event, triggering re-detection');
                triggerDetection();
            }
        }, true);

        // Listen for timeupdate — currentTime resetting to near 0 means a new video started
        document.addEventListener('timeupdate', (e) => {
            if (e.target && e.target.tagName === 'VIDEO') {
                const t = e.target.currentTime || 0;
                if (t < 0.5 && lastCurrentTime > 1) {
                    log('TikTok: timeupdate reset (new video), triggering re-detection');
                    triggerDetection();
                }
                lastCurrentTime = t;
            }
        }, true);
    };

    const setupTikTokInterception = () => {
        if (!isTikTok()) return;
        try {
            const origOpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function(method, url) {
                this._cobaltUrl = typeof url === 'string' ? url : (url && url.url) || '';
                this._cobaltIntercept = isTikTokApiUrl(this._cobaltUrl);
                return origOpen.apply(this, arguments);
            };
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.send = function() {
                if (this._cobaltIntercept) {
                    const self = this;
                    this.addEventListener('load', function() {
                        const text = safeGetResponseText(self);
                        if (text) processTikTokApiResponse(text);
                    });
                } else {
                    // Also check non-matching URLs for aweme_list in response
                    const self = this;
                    this.addEventListener('load', function() {
                        const text = safeGetResponseText(self);
                        if (text && text.includes('aweme_list')) {
                            processTikTokApiResponse(text);
                        }
                    });
                }
                return origSend.apply(this, arguments);
            };
            const origFetch = window.fetch;
            window.fetch = async function() {
                const reqUrl = (typeof arguments[0] === 'string') ? arguments[0] : arguments[0]?.url;
                const shouldIntercept = isTikTokApiUrl(reqUrl);
                const response = await origFetch.apply(this, arguments);
                if (shouldIntercept) {
                    try {
                        const clone = response.clone();
                        clone.text().then(text => processTikTokApiResponse(text)).catch(() => {});
                    } catch (e) { /* ignore */ }
                } else {
                    // Also check non-matching URLs for aweme_list in response
                    try {
                        const clone = response.clone();
                        clone.text().then(text => {
                            if (text && text.includes('aweme_list')) {
                                processTikTokApiResponse(text);
                            }
                        }).catch(() => {});
                    } catch (e) { /* ignore */ }
                }
                return response;
            };
        } catch (e) {
            error('Failed to set up TikTok XHR interception', e);
        }
    };

    const deepSearchAweme = (obj, preferredAuthor, depth = 0) => {
        if (depth > 8 || !obj || typeof obj !== 'object') return null;
        // Check if this object looks like an aweme item
        const itemId = obj.id || obj.aweme_id || obj.awemeId || obj.item_id || obj.awemeIdStr;
        const authorId = obj.author?.unique_id || obj.author?.uniqueId || obj.authorInfo?.uniqueId;
        if (itemId && authorId && /^\d{6,}$/.test(String(itemId))) {
            // Only return if author matches — rehydration data is static and
            // returning the first match gives stale/wrong results on scroll
            if (preferredAuthor && authorId.toLowerCase() === preferredAuthor.toLowerCase()) {
                return `https://www.tiktok.com/@${authorId}/video/${itemId}`;
            }
            // No preferred author? Don't return anything — too unreliable.
            return null;
        }
        // Recurse into all properties
        for (const key of Object.keys(obj)) {
            const child = obj[key];
            if (child && typeof child === 'object') {
                const found = deepSearchAweme(child, preferredAuthor, depth + 1);
                if (found) return found;
            }
        }
        return null;
    };

    const extractUrlFingerprint = (url) => {
        try {
            const u = new URL(url);
            const pathParts = u.pathname.split('/').filter(Boolean);
            return pathParts.length > 0 ? pathParts[pathParts.length - 1] : u.pathname;
        } catch (e) {
            return url;
        }
    };

    const urlsMatch = (srcUrl, capturedUrl) => {
        if (!srcUrl || !capturedUrl) return false;
        if (srcUrl === capturedUrl) return true;
        const srcFp = extractUrlFingerprint(srcUrl);
        const capFp = extractUrlFingerprint(capturedUrl);
        if (srcFp && capFp && srcFp.length > 8 && srcFp === capFp) return true;
        if (srcFp && capFp && srcFp.length > 8 && (srcUrl.includes(capFp) || capturedUrl.includes(srcFp))) return true;
        return false;
    };

    const getVideoIdFromReactFiber = (el) => {
        if (!el) return null;
        const fiberKey = Object.keys(el).find(k =>
            k.startsWith('__reactProps$') ||
            k.startsWith('__reactInternalInstance$') ||
            k.startsWith('__reactFiber$')
        );
        if (!fiberKey) return null;
        try {
            let node = el[fiberKey];
            let depth = 0;
            while (node && depth < 30) {
                const props = node.memoizedProps || node.pendingProps || {};
                const aweme = props.aweme || props.item || props.itemInfo || props.itemStruct || props.data;
                if (aweme) {
                    const id = aweme.id || aweme.aweme_id || aweme.awemeId || aweme.item_id;
                    const author = aweme.author?.unique_id || aweme.author?.uniqueId;
                    if (id && author && /^\d{6,}$/.test(String(id))) {
                        const url = `https://www.tiktok.com/@${author}/video/${id}`;
                        log('TikTok: found video URL from React fiber:', url);
                        return url;
                    }
                }
                const vidId = props.videoId || props.awemeId || props.itemId;
                if (vidId && /^\d{6,}$/.test(String(vidId))) {
                    const authorProp = props.author || props.authorId || props.uniqueId;
                    if (authorProp) {
                        const author = typeof authorProp === 'string' ? authorProp : (authorProp.unique_id || authorProp.uniqueId);
                        if (author) {
                            const url = `https://www.tiktok.com/@${author}/video/${vidId}`;
                            log('TikTok: found video URL from React fiber props:', url);
                            return url;
                        }
                    }
                }
                node = node.return || node._owner;
                depth++;
            }
        } catch (e) { /* ignore */ }
        return null;
    };

    const getTikTokVideoUrl = () => {
        const path = location.pathname;
        if (TIKTOK_VIDEO_PATTERN.test(path) || TIKTOK_PHOTO_PATTERN.test(path) ||
            TIKTOK_SHORT_PATTERN.test(path) || TIKTOK_V_PATTERN.test(path)) {
            return location.href;
        }

        // Use proactively tracked URL if available (set by poster/timeupdate tracking)
        if (tiktokActiveVideoUrl) {
            log('TikTok: using tracked active video URL:', tiktokActiveVideoUrl);
            return tiktokActiveVideoUrl;
        }

        // Always detect fresh — no caching (MSE blob URLs make src-based caching unreliable)
        return getTikTokVideoUrlInner();
    };

    const getTikTokVideoUrlInner = () => {
        // On foryou feed: find the visible reel container
        // TikTok uses both article and div for recommend-list-item-container
        const reels = document.querySelectorAll('[data-e2e="recommend-list-item-container"]');
        let visibleReelAuthor = null;
        let visibleReelVideoId = null;
        let visibleReel = null;

        // First pass: find the reel with a playing video (most accurate)
        for (const reel of reels) {
            const videoEl = reel.querySelector('video');
            if (videoEl && !videoEl.paused && videoEl.readyState > 0) {
                const rect = reel.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    visibleReel = reel;
                    log('TikTok: found playing video reel');
                    break;
                }
            }
        }

        // Second pass: fallback to reel closest to viewport center
        if (!visibleReel) {
            let bestDist = Infinity;
            for (const reel of reels) {
                const rect = reel.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    const center = rect.top + rect.height / 2;
                    const dist = Math.abs(center - window.innerHeight / 2);
                    if (dist < bestDist && dist < window.innerHeight * 0.5) {
                        bestDist = dist;
                        visibleReel = reel;
                    }
                }
            }
            if (visibleReel) log('TikTok: found reel closest to viewport center');
        }

        // Third pass: if no reels found by data-e2e, try broader selectors
        if (!visibleReel) {
            const broadReels = document.querySelectorAll('[data-e2e*="recommend"], [data-e2e*="feed-item"], [data-e2e*="video-feed"]');
            let bestDist = Infinity;
            for (const reel of broadReels) {
                const videoEl = reel.querySelector('video');
                if (!videoEl) continue;
                const rect = reel.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    const center = rect.top + rect.height / 2;
                    const dist = Math.abs(center - window.innerHeight / 2);
                    if (dist < bestDist && dist < window.innerHeight * 0.5) {
                        bestDist = dist;
                        visibleReel = reel;
                    }
                }
            }
            if (visibleReel) log('TikTok: found reel via broad selector');
        }

        // Last resort: just find any playing video on the page
        if (!visibleReel) {
            const allVideos = document.querySelectorAll('video');
            for (const v of allVideos) {
                if (!v.paused && v.readyState > 0) {
                    const rect = v.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && rect.top >= -100 && rect.top < window.innerHeight) {
                        // Find closest container
                        visibleReel = v.closest('[data-e2e*="recommend"]') ||
                                     v.closest('[data-e2e*="feed"]') ||
                                     v.closest('article') ||
                                     v.closest('div[class*="DivItemContainer"]') ||
                                     v.parentElement;
                        if (visibleReel) {
                            log('TikTok: found reel via playing video element');
                            break;
                        }
                    }
                }
            }
        }

        if (visibleReel) {
            // Look for anchor tags with video links inside the visible reel
            const anchors = visibleReel.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
            for (const a of anchors) {
                const href = a.getAttribute('href') || '';
                if (TIKTOK_VIDEO_PATTERN.test(href) || TIKTOK_PHOTO_PATTERN.test(href)) {
                    const url = new URL(href, location.origin);
                    log('TikTok: found video URL from reel anchor:', url.href);
                    return url.href;
                }
            }
            // Extract author username from the visible reel
            // Try profile link href first (gives unique_id, not display name)
            // TikTok uses full URLs like https://www.tiktok.com/@username, not relative /@username
            const authorLinks = visibleReel.querySelectorAll('a[href*="/@"]');
            for (const al of authorLinks) {
                const href = al.getAttribute('href') || '';
                const match = href.match(/\/@([^/]+)/);
                if (match) {
                    visibleReelAuthor = match[1];
                    break;
                }
            }
            // Fallback to video-user-name text content
            if (!visibleReelAuthor) {
                const userNameEl = visibleReel.querySelector('[data-e2e="video-user-name"]');
                if (userNameEl) {
                    visibleReelAuthor = (userNameEl.textContent || '').trim().replace(/^@/, '');
                }
            }
            // Try to find video ID from data attributes, video src, or wrapper div id
            const videoEl = visibleReel.querySelector('video');
            if (videoEl) {
                visibleReelVideoId = videoEl.getAttribute('data-video-id') ||
                                     videoEl.getAttribute('data-vid') || null;
                // Try extracting video ID from video src URL
                if (!visibleReelVideoId) {
                    const src = videoEl.getAttribute('src') || videoEl.currentSrc || '';
                    const idMatch = src.match(/\/video\/([\w]+)/) || src.match(/vid_([\w]+)/);
                    if (idMatch) visibleReelVideoId = idMatch[1];
                }
            }
            // Try extracting video ID from the xgwrapper div id (format: xgwrapper-0-{videoId})
            if (!visibleReelVideoId) {
                const wrapper = visibleReel.querySelector('div[id*="xgwrapper"]');
                if (wrapper) {
                    const wrapperId = wrapper.id || '';
                    const idMatch = wrapperId.match(/xgwrapper-\d+-(\d+)/);
                    if (idMatch) visibleReelVideoId = idMatch[1];
                }
            }
            // Try extracting video ID from cover image src (TikTok CDN URLs contain the video ID)
            if (!visibleReelVideoId) {
                const coverImg = visibleReel.querySelector('img[src*="tiktok"]');
                if (coverImg) {
                    const coverSrc = coverImg.getAttribute('src') || '';
                    // CDN URLs often contain the video ID as a path segment
                    const idMatch = coverSrc.match(/\/(\d{15,})\//);
                    if (idMatch) visibleReelVideoId = idMatch[1];
                }
            }
            // Try data-e2e attributes that may contain video ID
            if (!visibleReelVideoId) {
                const descEl = visibleReel.querySelector('[data-e2e="video-desc"]');
                if (descEl) {
                    const descVideoId = descEl.getAttribute('data-video-id') ||
                                        descEl.getAttribute('data-aweme-id');
                    if (descVideoId) visibleReelVideoId = descVideoId;
                }
            }
        }

        log('TikTok: visible reel - author:', visibleReelAuthor, 'videoId:', visibleReelVideoId, 'reels found:', reels.length, 'captured URLs:', tiktokFeedUrls.length);
        if (tiktokFeedUrls.length > 0) {
            log('TikTok: captured URLs sample:', tiktokFeedUrls.slice(-3).map(u => `${u.authorId}/${u.videoId}`));
        }

        // Match captured XHR data by video ID
        if (visibleReelVideoId) {
            const captured = tiktokFeedUrls.find(u => u.videoId === visibleReelVideoId);
            if (captured) {
                log('TikTok: matched video URL from XHR by videoId:', captured.url);
                return captured.url;
            }
        }
        // Try matching by cover image src and video element src against captured play/cover URLs
        if (visibleReel) {
            const videoEl = visibleReel.querySelector('video');
            const coverImg = visibleReel.querySelector('img[src*="tiktok"]');
            const coverSrc = coverImg ? (coverImg.getAttribute('src') || '') : '';
            if (videoEl) {
                const src = videoEl.getAttribute('src') || videoEl.currentSrc || '';
                // Also check source elements inside video
                const sourceEls = videoEl.querySelectorAll('source');
                const sourceSrcs = Array.from(sourceEls).map(s => s.getAttribute('src') || '').filter(s => s);
                const mediaSrcs = [src, coverSrc, ...sourceSrcs].filter(s => s && !s.startsWith('blob:'));
                log('TikTok: video media srcs:', mediaSrcs.map(s => s.substring(0, 80)));
                for (const mediaSrc of mediaSrcs) {
                    for (const captured of tiktokFeedUrls) {
                        if (mediaSrc.includes(captured.videoId)) {
                            log('TikTok: matched video URL by media src containing videoId:', captured.url);
                            return captured.url;
                        }
                    }
                    for (const captured of tiktokFeedUrls) {
                        if (captured.allMediaUrls) {
                            for (const capturedUrl of captured.allMediaUrls) {
                                if (urlsMatch(mediaSrc, capturedUrl)) {
                                    log('TikTok: matched video URL by media src matching play/cover URL:', captured.url);
                                    return captured.url;
                                }
                            }
                        }
                    }
                }
            }
        }
        // Try React fiber inspection on the visible reel and its children
        if (visibleReel) {
            const fiberResult = getVideoIdFromReactFiber(visibleReel) ||
                getVideoIdFromReactFiber(visibleReel.querySelector('video')) ||
                getVideoIdFromReactFiber(visibleReel.querySelector('[data-e2e*="video"]')) ||
                getVideoIdFromReactFiber(visibleReel.querySelector('[data-e2e*="user"]')) ||
                getVideoIdFromReactFiber(visibleReel.querySelector('div[class*="DivItemContainer"]')) ||
                getVideoIdFromReactFiber(visibleReel.querySelector('div[class*="DivVideo"]'));
            if (fiberResult) return fiberResult;
        }
        // Match captured XHR data by author username (case-insensitive, most recent first)
        if (visibleReelAuthor) {
            const authorLower = visibleReelAuthor.toLowerCase();
            for (let i = tiktokFeedUrls.length - 1; i >= 0; i--) {
                if (tiktokFeedUrls[i].authorId && tiktokFeedUrls[i].authorId.toLowerCase() === authorLower) {
                    log('TikTok: matched video URL from XHR by author (most recent):', tiktokFeedUrls[i].url);
                    return tiktokFeedUrls[i].url;
                }
            }
        }

        // Fallback: any visible anchor on the page with a video link
        const allAnchors = document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
        for (const a of allAnchors) {
            const href = a.getAttribute('href') || '';
            if (TIKTOK_VIDEO_PATTERN.test(href) || TIKTOK_PHOTO_PATTERN.test(href)) {
                const rect = a.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.top >= -100 && rect.top < window.innerHeight) {
                    const url = new URL(href, location.origin);
                    log('TikTok: found video URL from visible anchor:', url.href);
                    return url.href;
                }
            }
        }

        // Fallback: use most recently captured XHR URL — try author match first
        if (tiktokFeedUrls.length > 0) {
            if (visibleReelAuthor) {
                const authorLower = visibleReelAuthor.toLowerCase();
                for (let i = tiktokFeedUrls.length - 1; i >= 0; i--) {
                    if (tiktokFeedUrls[i].authorId && tiktokFeedUrls[i].authorId.toLowerCase() === authorLower) {
                        log('TikTok: using captured XHR URL matching visible author:', tiktokFeedUrls[i].url);
                        return tiktokFeedUrls[i].url;
                    }
                }
            }
            // Use most recent as fallback
            const last = tiktokFeedUrls[tiktokFeedUrls.length - 1];
            log('TikTok: using most recently captured video URL:', last.url);
            return last.url;
        }

        // Fallback: combine visible author with video ID from xgwrapper
        if (visibleReelAuthor && visibleReelVideoId) {
            const url = `https://www.tiktok.com/@${visibleReelAuthor}/video/${visibleReelVideoId}`;
            log('TikTok: constructed URL from visible author + videoId:', url);
            return url;
        }

        // Fallback: any anchor with video link (not visibility-filtered)
        for (const a of allAnchors) {
            const href = a.getAttribute('href') || '';
            if (TIKTOK_VIDEO_PATTERN.test(href) || TIKTOK_PHOTO_PATTERN.test(href)) {
                const url = new URL(href, location.origin);
                log('TikTok: found video URL from anchor (non-visible):', url.href);
                return url.href;
            }
        }

        // Last resort: extract from __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON (static, initial load only)
        try {
            const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
            if (script && script.textContent) {
                const data = JSON.parse(script.textContent);
                const scope = data.__DEFAULT_SCOPE__ || {};
                // Check webapp.video-detail (single video page)
                const itemModule = scope['webapp.video-detail']?.itemInfo?.itemStruct;
                if (itemModule && itemModule.id && itemModule.author?.uniqueId) {
                    const url = `https://www.tiktok.com/@${itemModule.author.uniqueId}/video/${itemModule.id}`;
                    log('TikTok: found video URL from rehydration data (video-detail):', url);
                    return url;
                }
                // For feed-detail: ONLY use if we can match the visible author
                if (visibleReelAuthor) {
                    const found = deepSearchAweme(scope, visibleReelAuthor);
                    if (found) {
                        log('TikTok: found video URL from rehydration data (author match):', found);
                        return found;
                    }
                }
            }
        } catch (e) { error('TikTok: rehydration parse error:', e); }

        // Fallback: extract from SIGI_STATE JSON (older TikTok state)
        try {
            const script = document.getElementById('SIGI_STATE') || document.getElementById('__SIGI_STATE__');
            if (script && script.textContent) {
                const data = JSON.parse(script.textContent);
                const feed = data.ItemModule || data.items || {};
                const items = Object.values(feed);
                for (const item of items) {
                    if (item.id && item.authorId) {
                        const url = `https://www.tiktok.com/@${item.authorId}/video/${item.id}`;
                        log('TikTok: found video URL from SIGI_STATE:', url);
                        return url;
                    }
                }
            }
        } catch (e) { /* ignore */ }

        // Last resort 3: try to get video URL from the video element's src/data-src
        const visibleVideo = document.querySelector('video');
        if (visibleVideo) {
            const src = visibleVideo.getAttribute('src') || visibleVideo.getAttribute('data-src') || visibleVideo.currentSrc || '';
            if (src) {
                log('TikTok: video element src:', src.substring(0, 200));
                // Try to extract video ID from TikTok CDN URLs
                const idMatch = src.match(/\/(\d{15,})\//) || src.match(/video\/(\d+)/) || src.match(/v=(\d+)/);
                if (idMatch && visibleReelAuthor) {
                    const url = `https://www.tiktok.com/@${visibleReelAuthor}/video/${idMatch[1]}`;
                    log('TikTok: constructed URL from video src + author:', url);
                    return url;
                }
            }
        }

        log('TikTok: could not extract video URL from feed');
        return null;
    };

    const getCurrentUrl = () => {
        if (isYouTube()) return location.href;
        if (isTikTok()) return getTikTokVideoUrl();
        return location.href;
    };

    const log = (...args) => console.log('[CobaltDL]', ...args);
    const error = (...args) => console.error('[CobaltDL]', ...args);

    const fetchJson = (url, method = 'GET', data = null) => {
        return new Promise((resolve, reject) => {
            const options = {
                method,
                url,
                timeout: REQUEST_TIMEOUT_MS,
                headers: data ? { 'Content-Type': 'application/json', 'Accept': 'application/json' } : { 'Accept': 'application/json' },
                data: data ? JSON.stringify(data) : undefined,
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        reject(new Error(`HTTP ${res.status} from ${url}`));
                        return;
                    }
                    try {
                        const parsed = JSON.parse(res.responseText);
                        resolve(parsed);
                    } catch (e) {
                        reject(new Error(`Invalid JSON from ${url}`));
                    }
                },
                onerror: (res) => reject(new Error(`Network error: ${url}`)),
                ontimeout: () => reject(new Error(`Timeout: ${url}`)),
            };
            GM.xmlHttpRequest(options);
        });
    };

    const getCachedInstances = async () => {
        try {
            const raw = await GM.getValue(CACHE_KEY, null);
            if (!raw) return null;
            const cache = JSON.parse(raw);
            if (Date.now() - cache.time > CACHE_TTL_MS) return null;
            return cache.instances;
        } catch (e) {
            return null;
        }
    };

    const setCachedInstances = async (instances) => {
        try {
            await GM.setValue(CACHE_KEY, JSON.stringify({ time: Date.now(), instances }));
        } catch (e) {
            error('Failed to cache instances', e);
        }
    };

    const getFailedInstances = async () => {
        try {
            const raw = await GM.getValue(FAILED_CACHE_KEY, null);
            if (!raw) return {};
            const cache = JSON.parse(raw);
            if (Date.now() - cache.time > FAILED_CACHE_TTL_MS) return {};
            return cache.map || {};
        } catch (e) {
            return {};
        }
    };

    const markInstanceFailed = async (instanceUrl) => {
        try {
            const map = await getFailedInstances();
            map[normalizeInstanceUrl(instanceUrl)] = Date.now();
            await GM.setValue(FAILED_CACHE_KEY, JSON.stringify({ time: Date.now(), map }));
        } catch (e) {
            error('Failed to cache failed instance', e);
        }
    };

    const filterHealthyInstances = async (instances) => {
        const failed = await getFailedInstances();
        const healthy = instances.filter(u => !failed[normalizeInstanceUrl(u)]);
        return healthy.length ? healthy : instances;
    };

    const fetchWorkingInstances = async () => {
        const cached = await getCachedInstances();
        if (cached) {
            log('Using cached instance list');
            return cached;
        }
        try {
            const testsData = await fetchJson(TESTS_API);
            if (!testsData || !Array.isArray(testsData.data)) throw new Error('Unexpected tests response');
            const platform = isYouTube() ? 'youtube' : isTikTok() ? 'tiktok' : 'youtube';
            const platformShorts = isYouTube() ? 'youtube-shorts' : null;
            const usable = testsData.data
                .filter(inst =>
                    inst.online === true &&
                    inst.turnstile === false &&
                    inst.api &&
                    inst.tests &&
                    inst.tests[platform] &&
                    inst.tests[platform].status === true &&
                    (!platformShorts || (inst.tests[platformShorts] && inst.tests[platformShorts].status === true))
                )
                .sort((a, b) => (b.score || 0) - (a.score || 0))
                .map(inst => `https://${inst.api}`);
            if (!usable.length) throw new Error('No usable instances found (all require auth or are offline)');
            log('Found usable instances:', usable);
            await setCachedInstances(usable);
            return usable;
        } catch (e) {
            error('Failed to fetch from tests API, falling back to working API', e);
            try {
                const data = await fetchJson(DIRECTORY_API);
                if (!data || !data.data) throw new Error('Unexpected directory response');
                const platform = isYouTube() ? 'youtube' : isTikTok() ? 'tiktok' : 'youtube';
                const list = data.data[platform] || [];
                const fallback = data.data['youtube'] || [];
                const merged = Array.from(new Set([...list, ...fallback]));
                if (!merged.length) throw new Error('No working instances found');
                await setCachedInstances(merged);
                return merged;
            } catch (e2) {
                error('Failed to fetch working instances', e2);
                const cached = await getCachedInstances();
                if (cached) return cached;
                throw e2;
            }
        }
    };

    const normalizeInstanceUrl = (url) => {
        let u = url.trim();
        if (u.endsWith('/')) u = u.slice(0, -1);
        return u;
    };

    const buildApiUrl = (instanceUrl) => normalizeInstanceUrl(instanceUrl);

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const requestCobalt = async (instances, options, attempt = 0, tried = []) => {
        if (!instances.length) throw new Error('No instances available');
        const instance = instances[attempt % instances.length];
        const url = buildApiUrl(instance);
        log('Trying instance', instance, '(attempt', attempt + 1, 'of', Math.min(instances.length, MAX_RETRIES) + ')');
        try {
            const res = await fetchJson(url, 'POST', options);
            if (res.status === 'error') {
                const msg = res.error?.code || res.text || 'Unknown cobalt error';
                log('Instance', instance, 'returned error:', msg);
                throw new Error(msg);
            }
            if (res.status === 'redirect' || res.status === 'tunnel') {
                if (res.url) {
                    return { status: res.status, url: res.url, filename: res.filename };
                }
            }
            if (res.status === 'local-processing' && res.tunnel) {
                const tunnelUrls = Array.isArray(res.tunnel) ? res.tunnel : [res.tunnel];
                const filename = (res.output && res.output.filename) || res.filename;
                return { status: 'local-processing', url: tunnelUrls[0], filename, tunnels: tunnelUrls };
            }
            if (res.status === 'picker' && res.picker) {
                return { status: 'picker', picker: res.picker, audio: res.audio, audioFilename: res.audioFilename };
            }
            throw new Error(`Unknown response status: ${res.status}`);
        } catch (e) {
            await markInstanceFailed(instance);
            tried.push(`${instance}: ${e.message}`);
            if (attempt < Math.min(instances.length, MAX_RETRIES) - 1) {
                const backoff = Math.min(1000 * 2 ** attempt, 8000);
                const jitter = Math.floor(Math.random() * 500);
                await sleep(backoff + jitter);
                return requestCobalt(instances, options, attempt + 1, tried);
            }
            const err = new Error(`${e.message}\n\nTried instances:\n${tried.join('\n')}`);
            err.tried = tried;
            throw err;
        }
    };

    const triggerDownload = (url, filename) => {
        return new Promise((resolve, reject) => {
            log('Triggering download:', url.substring(0, 100), 'filename:', filename);
            const btn = document.getElementById('cobalt-btn');
            const labelSpan = btn?.querySelector('.cobalt-label');
            const originalLabel = labelSpan?.textContent || 'Download';

            const doNativeDownload = () => {
                const a = document.createElement('a');
                a.href = url;
                a.download = filename || 'download';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                log('Native download triggered');
                if (labelSpan) labelSpan.textContent = 'Done!';
                setTimeout(() => { if (labelSpan) labelSpan.textContent = originalLabel; }, 2000);
                resolve();
            };

            if (labelSpan) labelSpan.textContent = 'Downloading...';
            doNativeDownload();
        });
    };

    const showPicker = (items, audio, audioFilename) => {
        const existing = document.getElementById('cobalt-picker-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'cobalt-picker-overlay';
        const modal = document.createElement('div');
        modal.className = 'cobalt-picker-modal';
        const header = document.createElement('div');
        header.className = 'cobalt-picker-header';
        const headerSpan = document.createElement('span');
        headerSpan.textContent = 'Select a quality';
        const closeBtn = document.createElement('button');
        closeBtn.className = 'cobalt-picker-close';
        closeBtn.textContent = '\u00d7';
        header.appendChild(headerSpan);
        header.appendChild(closeBtn);
        const listDiv = document.createElement('div');
        listDiv.className = 'cobalt-picker-list';
        modal.appendChild(header);
        modal.appendChild(listDiv);
        if (audio) {
            const audioBtn = document.createElement('button');
            audioBtn.className = 'cobalt-picker-audio';
            audioBtn.textContent = 'Download audio only';
            modal.appendChild(audioBtn);
        }
        overlay.appendChild(modal);
        const list = overlay.querySelector('.cobalt-picker-list');
        items.forEach((item, idx) => {
            const btn = document.createElement('button');
            btn.className = 'cobalt-picker-item';
            const typeLabel = item.type ? `[${item.type}] ` : '';
            btn.textContent = typeLabel + (item.quality || `Option ${idx + 1}`);
            btn.onclick = () => {
                triggerDownload(item.url, item.filename);
                overlay.remove();
            };
            list.appendChild(btn);
        });
        if (audio) {
            overlay.querySelector('.cobalt-picker-audio').onclick = () => {
                triggerDownload(audio, audioFilename);
                overlay.remove();
            };
        }
        overlay.querySelector('.cobalt-picker-close').onclick = () => overlay.remove();
        overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
        document.body.appendChild(overlay);
    };

    const handleDownload = async (mode) => {
        const btn = document.getElementById('cobalt-btn');
        if (btn) {
            btn.classList.add('cobalt-loading');
            btn.disabled = true;
        }
        try {
            const instances = await filterHealthyInstances(await fetchWorkingInstances());
            const url = getCurrentUrl();
            if (!url) {
                alert('No video URL found. Navigate to a specific TikTok video page (e.g. /@user/video/123) or open a reel first.');
                return;
            }
            log('Downloading:', url, 'mode:', mode, 'instances:', instances.length);
            const baseOptions = {
                url: url,
                filenameStyle: 'pretty',
                alwaysProxy: false,
            };
            if (mode === 'audio') {
                baseOptions.downloadMode = 'audio';
                baseOptions.audioFormat = 'mp3';
            } else if (mode === 'mute') {
                baseOptions.downloadMode = 'mute';
                baseOptions.videoQuality = '1080';
            } else if (mode === '720') {
                baseOptions.downloadMode = 'auto';
                baseOptions.videoQuality = '720';
            } else if (mode === 'best') {
                baseOptions.downloadMode = 'auto';
                baseOptions.videoQuality = 'max';
            }
            let lastError;
            const maxAttempts = Math.min(instances.length, MAX_RETRIES);
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    const res = await requestCobalt([instances[attempt]], baseOptions);
                    if (res.status === 'picker') {
                        showPicker(res.picker, res.audio, res.audioFilename);
                        return;
                    } else if (res.url) {
                        await triggerDownload(res.url, res.filename);
                        return;
                    } else {
                        throw new Error('No download URL returned');
                    }
                } catch (e) {
                    lastError = e;
                    log(`Download attempt ${attempt + 1}/${maxAttempts} failed:`, e.message);
                    await markInstanceFailed(instances[attempt]);
                    if (attempt < maxAttempts - 1) {
                        await sleep(1000);
                    }
                }
            }
            throw lastError || new Error('All download attempts failed');
        } catch (e) {
            alert(`Cobalt download failed: ${e.message}`);
            error(e);
        } finally {
            if (btn) {
                btn.classList.remove('cobalt-loading');
                btn.disabled = false;
            }
        }
    };

    const createDropdown = () => {
        const container = document.createElement('div');
        container.id = 'cobalt-dl-container';
        container.className = 'cobalt-dl-container';

        const btn = document.createElement('button');
        btn.id = 'cobalt-btn';
        btn.className = 'cobalt-btn';
        const iconSpan = document.createElement('span');
        iconSpan.className = 'cobalt-icon';
        iconSpan.textContent = '\u2b07';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'cobalt-label';
        labelSpan.textContent = 'Download';
        btn.appendChild(iconSpan);
        btn.appendChild(labelSpan);
        btn.onclick = (e) => {
            e.stopPropagation();
            const menu = document.getElementById('cobalt-dl-menu');
            const isOpen = menu && menu.classList.contains('cobalt-open');
            if (menu) {
                menu.classList.remove('cobalt-open');
            }
            if (!isOpen) {
                ensureMenuInBody();
                const m = document.getElementById('cobalt-dl-menu');
                m.classList.add('cobalt-open');
                const btnRect = btn.getBoundingClientRect();
                const menuHeight = 200;
                const spaceBelow = window.innerHeight - btnRect.bottom;
                m.style.right = (window.innerWidth - btnRect.right) + 'px';
                if (spaceBelow < menuHeight + 10) {
                    m.style.top = 'auto';
                    m.style.bottom = (window.innerHeight - btnRect.top + 6) + 'px';
                } else {
                    m.style.bottom = 'auto';
                    m.style.top = (btnRect.bottom + 6) + 'px';
                }
            }
        };

        const menu = document.createElement('div');
        menu.id = 'cobalt-dl-menu';
        menu.className = 'cobalt-menu';
        const items = [
            { label: 'Best quality', value: 'best' },
            { label: '720p video', value: '720' },
            { label: 'Audio only', value: 'audio' },
            { label: 'Mute video', value: 'mute' },
        ];
        items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'cobalt-menu-item';
            div.textContent = item.label;
            div.onclick = (e) => {
                e.stopPropagation();
                menu.classList.remove('cobalt-open');
                handleDownload(item.value);
            };
            menu.appendChild(div);
        });

        container.appendChild(btn);
        // Menu is appended to body by ensureMenuInBody() on first open
        container._cobaltMenu = menu;
        return container;
    };

    const ensureMenuInBody = () => {
        const containers = document.querySelectorAll('.cobalt-dl-container, #cobalt-dl-floating');
        for (const c of containers) {
            if (c._cobaltMenu) {
                const menu = c._cobaltMenu;
                if (menu.parentElement !== document.body) {
                    document.body.appendChild(menu);
                }
                return;
            }
        }
    };

    const injectStyles = () => {
        if (document.getElementById('cobalt-dl-styles')) return;
        const style = document.createElement('style');
        style.id = 'cobalt-dl-styles';
        style.textContent = `
            .cobalt-dl-container {
                position: relative;
                display: inline-flex;
                align-items: center;
                font-family: inherit;
                z-index: 10000;
            }
            .cobalt-btn {
                display: inline-flex;
                align-items: center;
                gap: 6px;
                padding: 8px 12px;
                border-radius: 18px;
                border: 1px solid rgba(128,128,128,0.3);
                background: rgba(255,255,255,0.9);
                color: #0f0f0f;
                font-weight: 600;
                font-size: 14px;
                cursor: pointer;
                transition: background 0.15s, transform 0.1s;
                box-shadow: 0 1px 2px rgba(0,0,0,0.05);
                white-space: nowrap;
                user-select: none;
            }
            .cobalt-btn:hover {
                background: rgba(255,255,255,1);
            }
            .cobalt-btn:active {
                transform: scale(0.97);
            }
            .cobalt-btn.cobalt-loading {
                opacity: 0.85;
                cursor: wait;
                pointer-events: none;
            }
            .cobalt-btn.cobalt-loading .cobalt-icon {
                animation: cobalt-spin 1s linear infinite;
            }
            @keyframes cobalt-spin {
                from { transform: rotate(0deg); }
                to { transform: rotate(360deg); }
            }
            .cobalt-btn .cobalt-icon {
                font-size: 16px;
                line-height: 1;
            }
            .cobalt-menu {
                position: fixed !important;
                min-width: 160px !important;
                background: #fff !important;
                border: 1px solid rgba(128,128,128,0.25) !important;
                border-radius: 12px !important;
                box-shadow: 0 4px 20px rgba(0,0,0,0.15) !important;
                display: none !important;
                flex-direction: column !important;
                overflow: visible !important;
                z-index: 2147483647 !important;
                padding: 4px 0 !important;
            }
            .cobalt-menu.cobalt-open {
                display: flex !important;
            }
            .cobalt-menu-item {
                display: block !important;
                padding: 10px 16px !important;
                font-size: 14px !important;
                color: #0f0f0f !important;
                cursor: pointer !important;
                white-space: nowrap !important;
                transition: background 0.1s !important;
                line-height: 1.4 !important;
                visibility: visible !important;
                opacity: 1 !important;
            }
            .cobalt-menu-item:hover {
                background: rgba(0,0,0,0.05) !important;
            }
            .cobalt-menu-item + .cobalt-menu-item {
                border-top: 1px solid rgba(0,0,0,0.06) !important;
            }
            #cobalt-picker-overlay {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background: rgba(0,0,0,0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10002;
            }
            .cobalt-picker-modal {
                background: #fff;
                border-radius: 16px;
                padding: 16px;
                min-width: 260px;
                max-width: 90vw;
                max-height: 80vh;
                overflow-y: auto;
                box-shadow: 0 10px 40px rgba(0,0,0,0.25);
            }
            .cobalt-picker-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                font-weight: 700;
                margin-bottom: 12px;
                font-size: 16px;
            }
            .cobalt-picker-close {
                background: none;
                border: none;
                font-size: 22px;
                cursor: pointer;
                color: #666;
            }
            .cobalt-picker-item {
                width: 100%;
                text-align: left;
                padding: 10px;
                margin-bottom: 6px;
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 8px;
                background: #fafafa;
                cursor: pointer;
                font-size: 14px;
                transition: background 0.1s;
            }
            .cobalt-picker-item:hover {
                background: #f0f0f0;
            }
            .cobalt-picker-audio {
                width: 100%;
                text-align: center;
                padding: 10px;
                margin-top: 8px;
                border: 1px solid rgba(0,0,0,0.08);
                border-radius: 8px;
                background: #f0f0f0;
                cursor: pointer;
                font-size: 14px;
                font-weight: 600;
                transition: background 0.1s;
            }
            .cobalt-picker-audio:hover {
                background: #e0e0e0;
            }
            .cobalt-dl-floating {
                position: fixed !important;
                bottom: 24px !important;
                right: 24px !important;
                z-index: 2147483647 !important;
            }
            .cobalt-dl-floating .cobalt-btn {
                box-shadow: 0 4px 12px rgba(0,0,0,0.3) !important;
                padding: 10px 16px !important;
                font-size: 15px !important;
            }
        `;
        document.head.appendChild(style);
    };

    const closeMenus = (e) => {
        const path = e.composedPath ? e.composedPath() : [e.target];
        if (!path.some(el => el.classList && (el.classList.contains('cobalt-dl-container') || el.id === 'cobalt-dl-menu' || el.id === 'cobalt-dl-floating'))) {
            const menu = document.getElementById('cobalt-dl-menu');
            if (menu) menu.classList.remove('cobalt-open');
        }
    };

    const injectYouTube = () => {
        let target = null;

        // YouTube Shorts - find the active reel and inject into its actions
        if (location.pathname.startsWith('/shorts')) {
            // Find the currently visible reel video renderer
            const reelSelectors = 'ytd-reel-video-renderer, ytd-shorts-video-renderer, [is="ytd-reel-video-renderer"]';
            const reels = document.querySelectorAll(reelSelectors);
            let activeReel = null;
            for (const reel of reels) {
                const rect = reel.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.top >= -50 && rect.top < window.innerHeight * 0.5) {
                    activeReel = reel;
                    break;
                }
            }

            // Check if button already exists in the active reel
            if (activeReel && activeReel.querySelector('#cobalt-dl-container')) {
                return true;
            }

            // Remove any stale button (might be in a non-active reel)
            const existing = document.querySelector('#cobalt-dl-container');
            if (existing) {
                existing.remove();
                const menu = document.getElementById('cobalt-dl-menu');
                if (menu) menu.remove();
            }

            // Try to find the active reel's action buttons container (right-side overlay)
            // NOT the comments section's #actions
            let reelActions = null;
            if (activeReel) {
                // Specific selectors for the reel's right-side action buttons
                const actionSelectors = [
                    'ytd-reel-player-overlay-renderer #actions',
                    'ytd-reel-player-overlay-renderer .action-buttons',
                    '#player-overlay #actions',
                    '#overlay #actions',
                    'ytd-reel-video-renderer #actions',
                    'ytd-shorts-video-renderer #actions',
                    '.action-buttons',
                    '#actions',
                ];
                for (const sel of actionSelectors) {
                    const candidates = activeReel.querySelectorAll(sel);
                    for (const el of candidates) {
                        // Skip if inside a comments-related element
                        if (el.closest('ytd-comments-entry-point-header-renderer') ||
                            el.closest('ytd-comment-thread-renderer') ||
                            el.closest('ytd-comments-header-renderer') ||
                            el.closest('[id="comments"]')) {
                            continue;
                        }
                        // Verify this is the right-side action buttons by checking position
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.right > window.innerWidth * 0.5) {
                            reelActions = el;
                            break;
                        }
                    }
                    if (reelActions) break;
                }
                // Fallback: shadow DOM within active reel
                if (!reelActions && activeReel.shadowRoot) {
                    for (const sel of ['#actions', '.action-buttons']) {
                        const candidates = activeReel.shadowRoot.querySelectorAll(sel);
                        for (const el of candidates) {
                            if (el.closest('ytd-comments') || el.closest('[id="comments"]')) continue;
                            const rect = el.getBoundingClientRect();
                            if (rect.width > 0 && rect.height > 0 && rect.right > window.innerWidth * 0.5) {
                                reelActions = el;
                                break;
                            }
                        }
                        if (reelActions) break;
                    }
                }
                // Fallback: deep shadow DOM search, filtering comments
                if (!reelActions) {
                    const deepActions = querySelectorDeep('#actions', activeReel);
                    if (deepActions && !deepActions.closest('ytd-comments') && !deepActions.closest('[id="comments"]')) {
                        const rect = deepActions.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && rect.right > window.innerWidth * 0.5) {
                            reelActions = deepActions;
                        }
                    }
                }
            }

            if (reelActions) {
                reelActions.appendChild(createDropdown());
                log('YouTube Shorts: button injected into active reel');
                return true;
            }

            // Active reel found but actions not ready yet, or no active reel found
            // Return false so floating button is used as fallback
            log('YouTube Shorts: active reel actions not ready, using floating fallback');
            return false;
        }

        // YouTube watch page - check if button already exists
        if (document.querySelector('#cobalt-dl-container')) {
            return true;
        }

        // 2025/2026 YouTube watch page: action buttons
        const watchSelectors = [
            '#top-row ytd-menu-renderer #top-level-buttons-computed',
            '#top-row ytd-menu-renderer #top-level-buttons',
            '#top-row ytd-menu-renderer',
            'ytd-watch-metadata #actions #top-level-buttons-computed',
            'ytd-watch-metadata #actions #top-level-buttons',
            'ytd-watch-metadata #actions ytd-menu-renderer',
            'ytd-watch-metadata #actions',
            '#actions ytd-menu-renderer #top-level-buttons-computed',
            '#actions ytd-menu-renderer #top-level-buttons',
            '#actions-inner ytd-menu-renderer',
            '#actions-inner',
            '#actions ytd-menu-renderer',
            '#actions',
            'ytd-menu-renderer #top-level-buttons-computed',
            'ytd-menu-renderer #top-level-buttons',
            '#top-level-buttons-computed',
            '#top-level-buttons',
            'ytd-menu-renderer',
        ];
        for (const sel of watchSelectors) {
            target = document.querySelector(sel);
            if (target) break;
        }
        // Ensure we're on a watch page, not a channel page
        if (target && !location.pathname.startsWith('/watch')) {
            target = null;
        }
        // Verify target is visible (not hidden by YouTube's lazy rendering)
        if (target) {
            const rect = target.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                target = null;
            }
        }

        // Fallback: insert after subscribe button
        if (!target) {
            const subscribe = document.querySelector('yt-subscribe-button-view-model, ytd-subscribe-button-renderer');
            if (subscribe && subscribe.parentElement) {
                target = subscribe.parentElement;
                const container = createDropdown();
                container.style.marginLeft = '8px';
                target.appendChild(container);
                log('YouTube: button injected after subscribe button');
                return true;
            }
        }

        // Last resort: deep shadow DOM search
        if (!target) {
            target = querySelectorDeep('#top-level-buttons-computed') ||
                     querySelectorDeep('#top-level-buttons');
        }

        if (!target) {
            log('YouTube: no action bar found');
            return false;
        }
        target.appendChild(createDropdown());
        log('YouTube: button injected into', target.tagName || target.id || 'container');
        return true;
    };

    const injectTikTok = () => {
        if (document.querySelector('#cobalt-dl-container')) {
            return true;
        }
        // TikTok renders reels lazily - find the currently visible video's action area
        const selectors = [
            '[data-e2e="share-button"]',
            '[data-e2e="browse-share"]',
            '[data-e2e="xg-share"]',
            '[data-e2e*="share"]',
            '[data-e2e*="like"]',
            '[data-e2e*="comment"]',
            '[data-e2e*="bookmark"]',
        ];
        let target = null;
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                // Relaxed visibility check for foryou feed
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0 && rect.top >= -100 && rect.top < window.innerHeight) {
                    target = el.closest('div[class*="ActionArea"]') ||
                             el.closest('div[class*="action"]') ||
                             el.closest('div[class*="RightArea"]') ||
                             el.closest('div[class*="DivContainer"]') ||
                             el.closest('div[class*="DivShare"]') ||
                             el.closest('div[class*="ShareBox"]') ||
                             (el.parentElement && el.parentElement.parentElement) ||
                             el.parentElement;
                    break;
                }
            }
            if (target) break;
        }
        // Fallback: try class-based selectors with relaxed visibility
        if (!target) {
            const fallbackSelectors = [
                'div[class*="ActionArea"]',
                'div[class*="action-area"]',
                'div[class*="DivShare"]',
                'div[class*="ShareBox"]',
                'div[class*="RightArea"]',
                'div[class*="DivContainer"]',
            ];
            for (const sel of fallbackSelectors) {
                const els = document.querySelectorAll(sel);
                for (const el of els) {
                    const rect = el.getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0 && rect.top >= -100 && rect.top < window.innerHeight) {
                        target = el;
                        break;
                    }
                }
                if (target) break;
            }
            // Last resort: first matching element without visibility check
            if (!target) {
                for (const sel of fallbackSelectors) {
                    const el = document.querySelector(sel);
                    if (el) {
                        target = el;
                        break;
                    }
                }
            }
        }
        if (!target) {
            log('TikTok: no action area found');
            return false;
        }
        if (target.querySelector('#cobalt-dl-container')) return true;
        const container = createDropdown();
        container.style.margin = '8px 0';
        container.style.display = 'flex';
        container.style.justifyContent = 'center';
        target.appendChild(container);
        log('TikTok: button injected');
        return true;
    };

    const injectFloating = () => {
        if (document.getElementById('cobalt-dl-floating')) return true;
        const container = createDropdown();
        container.id = 'cobalt-dl-floating';
        container.classList.add('cobalt-dl-floating');
        document.body.appendChild(container);
        log('Floating fallback button injected');
        return true;
    };

    let lastUrl = location.href;

    const removeStaleButton = () => {
        const container = document.querySelector('#cobalt-dl-container');
        if (container) container.remove();
        const floating = document.getElementById('cobalt-dl-floating');
        if (floating) floating.remove();
        const menu = document.getElementById('cobalt-dl-menu');
        if (menu) menu.remove();
    };

    const inject = () => {
        injectStyles();
        // Check for SPA URL change - remove stale button if URL changed
        if (location.href !== lastUrl) {
            log('URL changed:', lastUrl, '->', location.href);
            lastUrl = location.href;
            removeStaleButton();
        }
        if (document.querySelector('#cobalt-dl-container')) {
            // On shorts, button might be in a non-active reel - let injectYouTube handle it
            if (!(isYouTube() && location.pathname.startsWith('/shorts'))) {
                // Check if existing button is actually visible
                const existing = document.querySelector('#cobalt-dl-container');
                const rect = existing.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || rect.top < -200 || rect.top > window.innerHeight + 200) {
                    log('Existing button not visible, removing and re-injecting');
                    removeStaleButton();
                } else {
                    return;
                }
            }
        }
        let injected = false;
        if (isYouTube()) {
            // Only inject on watch or shorts pages - not homepage, channel, etc.
            if (location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts')) {
                injected = injectYouTube();
            } else {
                // Non-video YouTube page: remove any existing floating button and skip
                const floating = document.getElementById('cobalt-dl-floating');
                if (floating) floating.remove();
                return;
            }
        } else if (isTikTok()) {
            // TikTok React re-renders destroy inline buttons - always use floating
            injected = false;
        }
        if (injected) {
            const floating = document.getElementById('cobalt-dl-floating');
            if (floating) floating.remove();
        } else {
            const floating = document.getElementById('cobalt-dl-floating');
            if (!floating) injectFloating();
        }
    };

    const observe = () => {
        let lastRun = 0;
        let pending = false;
        const tick = () => {
            pending = false;
            lastRun = Date.now();
            inject();
        };
        const observer = new MutationObserver(() => {
            if (pending) return;
            const now = Date.now();
            if (now - lastRun < OBSERVER_THROTTLE_MS) {
                pending = true;
                setTimeout(() => {
                    if (pending) tick();
                }, OBSERVER_THROTTLE_MS - (now - lastRun));
                return;
            }
            tick();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden']
        });
        // Backup interval for lazy-rendered content (YouTube SPA navigation)
        setInterval(() => {
            const existing = document.querySelector('#cobalt-dl-container');
            const floating = document.getElementById('cobalt-dl-floating');
            const needsInject = location.href !== lastUrl || (!existing && !floating);
            if (needsInject) {
                inject();
            } else if (existing && isYouTube() && (location.pathname.startsWith('/watch') || location.pathname.startsWith('/shorts'))) {
                // Check if button is still visible — YouTube may have re-rendered and orphaned it
                const rect = existing.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0 || rect.top < -200 || rect.top > window.innerHeight + 200) {
                    log('Backup: button not visible, re-injecting');
                    removeStaleButton();
                    inject();
                }
            }
        }, 500);
    };

    const init = () => {
        log('v2.2.0 starting, host:', currentHost(), 'readyState:', document.readyState);
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
            return;
        }
        setupTikTokInterception();
        setupTikTokVideoTracking();
        log('DOM ready, injecting button');
        inject();
        observe();
        document.addEventListener('click', closeMenus);
        window.addEventListener('scroll', () => {
            const menu = document.getElementById('cobalt-dl-menu');
            if (menu) menu.classList.remove('cobalt-open');
        }, true);
        // Retry injection at multiple intervals for SPA navigation
        const retryInject = () => {
            setTimeout(() => inject(), 100);
            setTimeout(() => inject(), 500);
            setTimeout(() => inject(), 1500);
            setTimeout(() => inject(), 3000);
            setTimeout(() => inject(), 5000);
            setTimeout(() => inject(), 8000);
        };
        // Hook into SPA navigation for YouTube
        const origPushState = history.pushState;
        history.pushState = function() {
            const result = origPushState.apply(this, arguments);
            retryInject();
            return result;
        };
        const origReplaceState = history.replaceState;
        history.replaceState = function() {
            const result = origReplaceState.apply(this, arguments);
            retryInject();
            return result;
        };
        window.addEventListener('popstate', retryInject);
        // YouTube-specific SPA navigation events
        document.addEventListener('yt-navigate-finish', () => {
            log('YouTube SPA navigation finished');
            retryInject();
        });
        document.addEventListener('yt-page-data-updated', () => {
            log('YouTube page data updated');
            retryInject();
        });
        // YouTube visibility change (handles cases where page renders while tab is active)
        document.addEventListener('yt-visibility-refresh', () => {
            log('YouTube visibility refresh');
            retryInject();
        });
        GM.registerMenuCommand('Refresh Cobalt instances', async () => {
            await GM.setValue(CACHE_KEY, '');
            alert('Instance cache cleared. Next download will fetch fresh instances.');
        });
        GM.registerMenuCommand('Clear failed instances', async () => {
            await GM.setValue(FAILED_CACHE_KEY, '');
            alert('Failed instance cache cleared.');
        });
    };

    init();
})();
