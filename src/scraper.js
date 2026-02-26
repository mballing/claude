import path from 'path';
import { existsSync, readdirSync } from 'fs';
import { chromium } from 'playwright';
import { processPage } from './pageProcessor.js';
import { downloadAssets } from './assetDownloader.js';
import {
  urlToFolderPath,
  ensureDirs,
  saveFile,
  rewriteHtmlUrls,
} from './fileManager.js';

/**
 * Scrape a list of URLs, saving each page as a self-contained local copy.
 *
 * @param {string[]} urls - List of URLs to scrape
 * @param {object} options
 * @param {string} options.output - Output directory path
 * @param {number} options.concurrency - Max simultaneous pages
 * @param {number} options.timeout - Page load timeout in ms
 * @param {boolean} options.verbose - Enable verbose logging
 * @returns {Promise<{succeeded: string[], failed: Array<{url:string, error:string}>}>}
 */
export async function scrapeUrls(urls, options) {
  const {
    output = './output',
    concurrency = 2,
    timeout = 30000,
    verbose = false,
  } = options;

  const log = (...args) => console.log(...args);
  const debug = verbose ? (...args) => console.log('   ', ...args) : () => {};

  log(`\nLaunching browser...`);

  // Determine the chromium executable. Playwright downloads its own browser on
  // first use via `npx playwright install`. When that download is unavailable
  // (restricted networks), fall back to any pre-existing chromium in the cache.
  const executablePath = resolveChromiumPath();

  const browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const succeeded = [];
  const failed = [];

  // Simple concurrency limiter: process in batches of `concurrency`
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map(url => scrapeOne(browser, url, output, timeout, verbose, log, debug))
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const url = batch[j];
      if (result.status === 'fulfilled') {
        succeeded.push({ url, folder: result.value });
      } else {
        failed.push({ url, error: result.reason?.message || String(result.reason) });
      }
    }
  }

  await browser.close();
  debug('Browser closed.');

  return { succeeded, failed };
}

/**
 * Scrape a single URL.
 * @returns {Promise<string>} The output folder path
 */
async function scrapeOne(browser, url, outputDir, timeout, verbose, log, debug) {
  log(`\nProcessing: ${url}`);

  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setExtraHTTPHeaders({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });

  try {
    // Step 1: Navigate and extract page content
    debug('Navigating to page...');
    const { bodyHtml, cssHrefs, styleBlocks, title } = await processPage(page, url, { timeout });
    debug(`Title: "${title}"`);
    debug(`Found ${cssHrefs.length} stylesheet(s), ${styleBlocks.length} inline style block(s)`);

    // Step 2: Determine output folder
    const folderPath = urlToFolderPath(url, outputDir);
    debug(`Output folder: ${folderPath}`);
    await ensureDirs(folderPath);

    // Step 3: Download CSS + images, get asset maps
    debug('Downloading assets...');
    const { cssMap, imageMap } = await downloadAssets(
      bodyHtml,
      cssHrefs,
      styleBlocks,
      url,
      folderPath,
      { verbose }
    );
    debug(`Downloaded ${cssMap.size} CSS file(s), ${imageMap.size} image(s)`);

    // Step 4: Rewrite HTML references to use local paths
    const rewrittenBody = rewriteHtmlUrls(bodyHtml, cssMap, imageMap);

    // Step 5: Build and save the complete HTML document
    const finalHtml = buildHtmlDocument({
      title,
      bodyHtml: rewrittenBody,
      cssMap,
      styleBlocks,
      originalUrl: url,
    });

    await saveFile(path.join(folderPath, 'index.html'), finalHtml);
    log(`Saved: ${folderPath}/index.html`);

    return folderPath;
  } finally {
    await page.close();
  }
}

/**
 * Assemble a complete HTML document from the scraped parts.
 */
function buildHtmlDocument({ title, bodyHtml, cssMap, styleBlocks, originalUrl }) {
  // Build <link> tags for downloaded CSS files (deduplicated local paths)
  const seenLocalPaths = new Set();
  const cssLinks = [];
  for (const localPath of cssMap.values()) {
    if (!seenLocalPaths.has(localPath)) {
      seenLocalPaths.add(localPath);
      cssLinks.push(`  <link rel="stylesheet" href="${escapeAttr(localPath)}">`);
    }
  }

  // Inline style blocks (preserved verbatim from the original page)
  const styleTags = styleBlocks
    .map(s => `  <style>\n${s}\n  </style>`)
    .join('\n');

  const safeTitle = escapeHtml(title || 'Scraped Page');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="original-url" content="${escapeAttr(originalUrl)}">
  <title>${safeTitle}</title>
${cssLinks.join('\n')}
${styleTags}
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

/**
 * Resolve the path to a usable Chromium executable.
 *
 * Playwright downloads its own browser revision on `npx playwright install`.
 * When that is unavailable (restricted networks), look for any pre-downloaded
 * Chromium in the playwright cache directory.
 *
 * @returns {string|null} Absolute path to chromium, or null to let Playwright decide.
 */
function resolveChromiumPath() {
  const cacheRoot = path.join(
    process.env.HOME || '/root',
    '.cache', 'ms-playwright'
  );

  if (!existsSync(cacheRoot)) return null;

  try {
    // Sort descending so the newest revision is tried first
    const dirs = readdirSync(cacheRoot).sort().reverse();
    for (const dir of dirs) {
      const candidates = [
        path.join(cacheRoot, dir, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
        path.join(cacheRoot, dir, 'chrome-linux64', 'chrome'),
        path.join(cacheRoot, dir, 'chrome-linux', 'chrome'),
      ];
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore fs errors
  }

  return null;
}
