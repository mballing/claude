// Selectors for elements that are typically headers/footers/navigation.
const REMOVE_SELECTORS = [
  // ARIA roles (most semantically reliable)
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="navigation"]',
  // HTML5 semantic elements
  'header',
  'footer',
  'nav',
  // ID-based patterns
  '#header', '#footer', '#nav', '#navigation',
  '#site-header', '#site-footer',
  '#page-header', '#page-footer',
  '#masthead', '#colophon',
  '#wpadminbar',
  // Class-based patterns
  '.header', '.footer',
  '.site-header', '.site-footer',
  '.page-header', '.page-footer',
  '.main-header', '.main-footer',
  '.navbar', '.topbar', '.top-bar', '.bottom-bar',
  '.breadcrumb', '.breadcrumbs',
  // Cookie / GDPR banners
  '#cookie-notice', '.cookie-notice', '.cookie-banner',
  '#gdpr-banner', '.gdpr-banner', '.consent-banner',
];

// Elements whose children should never be removed (content containers).
const CONTENT_SELECTORS = [
  'main',
  '[role="main"]',
  '#main',
  '#content',
  '.main-content',
  'article',
  '[role="article"]',
];

/**
 * Navigate to a URL, strip header/footer elements, and collect asset references.
 *
 * @param {import('playwright').Page} page - Playwright page instance
 * @param {string} url - Target URL
 * @param {object} options
 * @param {number} options.timeout - Navigation timeout in ms
 * @returns {Promise<{bodyHtml: string, cssHrefs: string[], styleBlocks: string[], title: string}>}
 */
export async function processPage(page, url, options) {
  const { timeout = 30000 } = options;

  await page.goto(url, { waitUntil: 'networkidle', timeout });

  // Scroll to trigger lazy-loaded images, then return to top
  await page.evaluate(async () => {
    await new Promise(resolve => {
      const scrollStep = window.innerHeight;
      let scrolled = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, scrollStep);
        scrolled += scrollStep;
        if (scrolled >= document.body.scrollHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 80);
    });
  });

  // Allow lazy-triggered requests to settle
  await page.waitForTimeout(600);

  // Do all DOM work in a single evaluate call for performance
  const result = await page.evaluate(
    ({ removeSelectors, contentSelectors }) => {
      // Build a set of "safe" content container elements
      const contentRoots = new Set();
      for (const sel of contentSelectors) {
        document.querySelectorAll(sel).forEach(el => contentRoots.add(el));
      }

      function isInsideContent(el) {
        let node = el.parentElement;
        while (node) {
          if (contentRoots.has(node)) return true;
          node = node.parentElement;
        }
        return false;
      }

      // Remove header/footer elements that are NOT inside content containers
      for (const sel of removeSelectors) {
        document.querySelectorAll(sel).forEach(el => {
          if (!isInsideContent(el)) el.remove();
        });
      }

      // Collect linked stylesheet hrefs (already resolved to absolute by the browser)
      const cssHrefs = [];
      document.querySelectorAll('link[rel="stylesheet"][href]').forEach(el => {
        if (el.href) cssHrefs.push(el.href);
      });

      // Collect inline <style> block contents
      const styleBlocks = [];
      document.querySelectorAll('style').forEach(el => {
        if (el.textContent.trim()) styleBlocks.push(el.textContent);
      });

      return {
        bodyHtml: document.body.innerHTML,
        cssHrefs,
        styleBlocks,
      };
    },
    { removeSelectors: REMOVE_SELECTORS, contentSelectors: CONTENT_SELECTORS }
  );

  const title = await page.title();

  return {
    bodyHtml: result.bodyHtml,
    cssHrefs: result.cssHrefs,
    styleBlocks: result.styleBlocks,
    title,
  };
}
