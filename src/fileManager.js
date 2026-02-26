import path from 'path';
import { load } from 'cheerio';
import fsExtra from 'fs-extra';

/**
 * Convert a URL into a local folder path.
 * e.g. https://example.com/blog/post-1 -> output/example.com/blog/post-1
 */
export function urlToFolderPath(url, outputDir) {
  const u = new URL(url);

  // Hostname: replace port colon with underscore
  const hostname = u.hostname.replace(/:(\d+)/, '_$1');

  // Pathname: strip leading/trailing slashes, sanitize each segment
  const rawPath = u.pathname.replace(/^\/|\/$/g, '');
  const segments = rawPath
    ? rawPath.split('/').map(seg => sanitizeSegment(seg))
    : ['_root_'];

  return path.resolve(outputDir, hostname, ...segments);
}

function sanitizeSegment(seg) {
  if (!seg) return '_';
  // Replace characters that are unsafe on common filesystems
  return seg.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || '_';
}

/**
 * Create the folder structure for a scraped page:
 *   folderPath/
 *   folderPath/css/
 *   folderPath/images/
 */
export async function ensureDirs(folderPath) {
  await fsExtra.mkdirs(folderPath);
  await fsExtra.mkdirs(path.join(folderPath, 'css'));
  await fsExtra.mkdirs(path.join(folderPath, 'images'));
}

/**
 * Save a file, creating intermediate directories as needed.
 */
export async function saveFile(filePath, data) {
  await fsExtra.outputFile(filePath, data);
}

/**
 * Rewrite asset references in an HTML string using the provided maps.
 *
 * Map keys are absolute URLs. Attribute values may be relative, so we
 * resolve them against `baseUrl` before looking them up in the map.
 *
 * @param {string} html - Raw HTML body content
 * @param {Map<string,string>} cssMap - original href (absolute) -> local relative path
 * @param {Map<string,string>} imageMap - original absolute URL -> local relative path
 * @param {string} baseUrl - The page URL, used to resolve relative attribute values
 * @returns {string} Rewritten HTML
 */
export function rewriteHtmlUrls(html, cssMap, imageMap, baseUrl) {
  const $ = load(html, { decodeEntities: false });

  // Resolve a raw attribute value (possibly relative) to an absolute URL,
  // then look it up in the given map. Returns the local path or null.
  function resolve(raw, map) {
    if (!raw) return null;
    // Try exact match first (already absolute)
    if (map.has(raw)) return map.get(raw);
    // Try resolved absolute URL
    try {
      const abs = new URL(raw, baseUrl).href;
      return map.has(abs) ? map.get(abs) : null;
    } catch {
      return null;
    }
  }

  // Rewrite <link rel="stylesheet" href="...">
  $('link[rel="stylesheet"]').each((_, el) => {
    const local = resolve($(el).attr('href'), cssMap);
    if (local) $(el).attr('href', local);
  });

  // Rewrite <img src>, <img srcset>, <img data-src>
  $('img').each((_, el) => {
    const local = resolve($(el).attr('src'), imageMap);
    if (local) $(el).attr('src', local);

    const srcset = $(el).attr('srcset');
    if (srcset) $(el).attr('srcset', rewriteSrcset(srcset, imageMap, baseUrl));

    const localDs = resolve($(el).attr('data-src'), imageMap);
    if (localDs) $(el).attr('data-src', localDs);
  });

  // Rewrite <source src> and <source srcset> (picture/video)
  $('source').each((_, el) => {
    const local = resolve($(el).attr('src'), imageMap);
    if (local) $(el).attr('src', local);

    const srcset = $(el).attr('srcset');
    if (srcset) $(el).attr('srcset', rewriteSrcset(srcset, imageMap, baseUrl));
  });

  // Rewrite inline style background-image: url(...)
  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (!style) return;
    style = style.replace(
      /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi,
      (match, imgUrl) => {
        const local = resolve(imgUrl, imageMap);
        return local ? `url('${local}')` : match;
      }
    );
    $(el).attr('style', style);
  });

  // Remove <base> tag so relative local paths resolve correctly when opened
  $('base').remove();

  return $.html();
}

/**
 * Rewrite URLs inside a srcset attribute value using imageMap.
 */
function rewriteSrcset(srcset, imageMap, baseUrl) {
  return srcset
    .split(',')
    .map(entry => {
      const trimmed = entry.trim();
      const spaceIdx = trimmed.search(/\s/);
      const rawUrl = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const descriptor = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx);

      let local = imageMap.get(rawUrl);
      if (!local && baseUrl) {
        try { local = imageMap.get(new URL(rawUrl, baseUrl).href); } catch { /* ignore */ }
      }
      return (local || rawUrl) + descriptor;
    })
    .join(', ');
}

/**
 * Generate a safe, deduplicated filename for an asset.
 *
 * @param {string} rawName - Suggested filename (may have extension)
 * @param {Set<string>} usedNames - Already taken names in this folder
 * @returns {string} Safe unique filename
 */
export function uniqueFilename(rawName, usedNames) {
  const safe = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100) || 'asset';
  if (!usedNames.has(safe)) {
    usedNames.add(safe);
    return safe;
  }
  const ext = path.extname(safe);
  const base = path.basename(safe, ext);
  let i = 2;
  while (true) {
    const candidate = `${base}_${i}${ext}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
    i++;
  }
}
