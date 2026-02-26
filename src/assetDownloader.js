import path from 'path';
import { load } from 'cheerio';
import mime from 'mime-types';
import { uniqueFilename } from './fileManager.js';
import fsExtra from 'fs-extra';

const CSS_URL_RE = /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi;

/**
 * Download all CSS and image assets for a scraped page, rewrite their URLs,
 * and return the modified HTML along with the asset maps.
 *
 * @param {string} bodyHtml - Cleaned HTML body content
 * @param {string[]} cssHrefs - Absolute URLs of linked stylesheets
 * @param {string[]} styleBlocks - Inline <style> block contents (preserved as-is)
 * @param {string} baseUrl - The page's final URL (for resolving relative paths)
 * @param {string} folderPath - Absolute local path to save assets into
 * @param {object} options
 * @param {boolean} [options.verbose]
 * @returns {Promise<{finalHtml: string, cssMap: Map, imageMap: Map}>}
 */
export async function downloadAssets(bodyHtml, cssHrefs, styleBlocks, baseUrl, folderPath, options = {}) {
  const { verbose = false } = options;
  const log = verbose ? (...args) => console.log('  ', ...args) : () => {};

  // Track filenames used in each subdirectory to prevent collisions
  const usedCssNames = new Set();
  const usedImageNames = new Set();

  // Maps: original URL -> local relative path (e.g. 'css/main.css')
  const cssMap = new Map();   // original stylesheet href -> 'css/filename.css'
  const imageMap = new Map(); // original image absolute URL -> 'images/filename.ext'

  // ── Phase 1: Download CSS stylesheets ──────────────────────────────────────

  for (const href of cssHrefs) {
    try {
      const absoluteUrl = resolveUrl(href, baseUrl);
      if (!absoluteUrl || cssMap.has(absoluteUrl)) continue;

      log(`Fetching CSS: ${absoluteUrl}`);
      const cssText = await fetchText(absoluteUrl);
      if (cssText === null) continue;

      // Collect image/font URLs referenced inside this CSS file
      const cssImageUrls = extractUrlsFromCss(cssText, absoluteUrl);

      // Download those nested assets first so we can rewrite the CSS
      for (const assetUrl of cssImageUrls) {
        if (!imageMap.has(assetUrl) && !isDataUri(assetUrl)) {
          await downloadImage(assetUrl, folderPath, usedImageNames, imageMap, log);
        }
      }

      // Rewrite url() inside CSS to point to ../images/<filename>
      const rewrittenCss = rewriteCssUrls(cssText, absoluteUrl, imageMap);

      // Save to css/<filename>
      const rawName = guessFilename(absoluteUrl, 'style.css');
      const filename = uniqueFilename(ensureExtension(rawName, '.css'), usedCssNames);
      const localCssPath = path.join(folderPath, 'css', filename);
      await fsExtra.outputFile(localCssPath, rewrittenCss, 'utf8');

      cssMap.set(href, `css/${filename}`);
      cssMap.set(absoluteUrl, `css/${filename}`);
      log(`  Saved CSS: css/${filename}`);
    } catch (err) {
      log(`  Warning: CSS download failed for ${href} — ${err.message}`);
    }
  }

  // ── Phase 2: Collect image URLs from HTML ──────────────────────────────────

  const $ = load(bodyHtml, { decodeEntities: false });
  const htmlImageUrls = new Set();

  $('img').each((_, el) => {
    addResolvedUrl($(el).attr('src'), baseUrl, htmlImageUrls);
    addResolvedUrl($(el).attr('data-src'), baseUrl, htmlImageUrls);
    const srcset = $(el).attr('srcset');
    if (srcset) parseSrcset(srcset).forEach(u => addResolvedUrl(u, baseUrl, htmlImageUrls));
  });

  $('source').each((_, el) => {
    addResolvedUrl($(el).attr('src'), baseUrl, htmlImageUrls);
    const srcset = $(el).attr('srcset');
    if (srcset) parseSrcset(srcset).forEach(u => addResolvedUrl(u, baseUrl, htmlImageUrls));
  });

  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    extractUrlsFromCss(style, baseUrl).forEach(u => htmlImageUrls.add(u));
  });

  // ── Phase 3: Download images ───────────────────────────────────────────────

  log(`Downloading ${htmlImageUrls.size} image(s) from HTML`);
  for (const imgUrl of htmlImageUrls) {
    if (!imageMap.has(imgUrl)) {
      await downloadImage(imgUrl, folderPath, usedImageNames, imageMap, log);
    }
  }

  // ── Phase 4: Rewrite HTML URLs ─────────────────────────────────────────────
  // (Done by fileManager.rewriteHtmlUrls using the maps we built)
  // We return the original bodyHtml here; rewriting happens in scraper.js via
  // fileManager.rewriteHtmlUrls(bodyHtml, cssMap, imageMap).

  return { cssMap, imageMap };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(href, base) {
  if (!href) return null;
  if (isDataUri(href) || href.startsWith('blob:') || href.startsWith('javascript:')) return null;
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

function isDataUri(url) {
  return url && url.startsWith('data:');
}

function addResolvedUrl(raw, base, set) {
  const resolved = resolveUrl(raw, base);
  if (resolved) set.add(resolved);
}

/**
 * Extract absolute image/font URLs from a CSS string.
 */
function extractUrlsFromCss(cssText, cssBaseUrl) {
  const urls = [];
  let match;
  const re = new RegExp(CSS_URL_RE.source, 'gi');
  while ((match = re.exec(cssText)) !== null) {
    const raw = match[1];
    if (!raw || isDataUri(raw) || raw.startsWith('#')) continue;
    const abs = resolveUrl(raw, cssBaseUrl);
    if (abs) urls.push(abs);
  }
  return urls;
}

/**
 * Rewrite url() references in CSS text to local relative paths.
 */
function rewriteCssUrls(cssText, cssFileUrl, imageMap) {
  return cssText.replace(CSS_URL_RE, (match, raw) => {
    if (!raw || isDataUri(raw) || raw.startsWith('#')) return match;
    const abs = resolveUrl(raw, cssFileUrl);
    if (!abs) return match;
    const local = imageMap.get(abs);
    if (!local) return match;
    // CSS is in css/, images are in images/ -> use ../images/filename
    return `url('../${local}')`;
  });
}

/**
 * Parse srcset attribute into an array of URLs (strip descriptors).
 */
function parseSrcset(srcset) {
  return srcset
    .split(',')
    .map(entry => entry.trim().split(/\s+/)[0])
    .filter(Boolean);
}

/**
 * Guess a filename from a URL. Falls back to defaultName.
 */
function guessFilename(url, defaultName) {
  try {
    const u = new URL(url);
    const base = path.basename(u.pathname);
    return base || defaultName;
  } catch {
    return defaultName;
  }
}

function ensureExtension(filename, ext) {
  return filename.includes('.') ? filename : filename + ext;
}

/**
 * Determine a file extension for an asset given a URL and Content-Type.
 */
function guessExtension(url, contentType) {
  // Try extension from URL path first
  try {
    const u = new URL(url);
    const ext = path.extname(u.pathname);
    if (ext && ext.length <= 5) return ext;
  } catch { /* ignore */ }

  // Fall back to mime-types lookup
  if (contentType) {
    const ct = contentType.split(';')[0].trim();
    const ext = mime.extension(ct);
    if (ext) return `.${ext}`;
  }
  return '.bin';
}

/**
 * Download a single image asset to folderPath/images/.
 */
async function downloadImage(imgUrl, folderPath, usedNames, imageMap, log) {
  if (!imgUrl || isDataUri(imgUrl)) return;
  if (imageMap.has(imgUrl)) return;

  try {
    log(`  Fetching image: ${imgUrl}`);
    const response = await fetch(imgUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebScraper/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      log(`  Warning: image fetch failed (${response.status}): ${imgUrl}`);
      return;
    }

    const contentType = response.headers.get('content-type') || '';
    const ext = guessExtension(imgUrl, contentType);
    const rawName = guessFilename(imgUrl, 'image') + (guessFilename(imgUrl, '').includes('.') ? '' : ext);
    const filename = uniqueFilename(rawName, usedNames);

    const buffer = Buffer.from(await response.arrayBuffer());
    await fsExtra.outputFile(path.join(folderPath, 'images', filename), buffer);

    imageMap.set(imgUrl, `images/${filename}`);
    log(`  Saved image: images/${filename}`);
  } catch (err) {
    log(`  Warning: image download error for ${imgUrl} — ${err.message}`);
  }
}

/**
 * Fetch a URL as text.
 * @returns {Promise<string|null>}
 */
async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WebScraper/1.0)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) return null;
  return response.text();
}
