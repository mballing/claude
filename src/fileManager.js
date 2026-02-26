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
 * @param {string} html - Raw HTML body content
 * @param {Map<string,string>} cssMap - original href -> local relative path
 * @param {Map<string,string>} imageMap - original absolute URL -> local relative path
 * @returns {string} Rewritten HTML
 */
export function rewriteHtmlUrls(html, cssMap, imageMap) {
  const $ = load(html, { decodeEntities: false });

  // Rewrite <link rel="stylesheet" href="...">
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && cssMap.has(href)) {
      $(el).attr('href', cssMap.get(href));
    }
  });

  // Rewrite <img src>, <img srcset>, <img data-src>
  $('img').each((_, el) => {
    const src = $(el).attr('src');
    if (src && imageMap.has(src)) {
      $(el).attr('src', imageMap.get(src));
    }

    const srcset = $(el).attr('srcset');
    if (srcset) {
      $(el).attr('srcset', rewriteSrcset(srcset, imageMap));
    }

    const dataSrc = $(el).attr('data-src');
    if (dataSrc && imageMap.has(dataSrc)) {
      $(el).attr('data-src', imageMap.get(dataSrc));
    }
  });

  // Rewrite <source src> and <source srcset> (picture/video)
  $('source').each((_, el) => {
    const src = $(el).attr('src');
    if (src && imageMap.has(src)) {
      $(el).attr('src', imageMap.get(src));
    }

    const srcset = $(el).attr('srcset');
    if (srcset) {
      $(el).attr('srcset', rewriteSrcset(srcset, imageMap));
    }
  });

  // Rewrite inline style background-image: url(...)
  $('[style]').each((_, el) => {
    let style = $(el).attr('style');
    if (!style) return;
    style = style.replace(
      /url\(\s*['"]?([^'")\s]+)['"]?\s*\)/gi,
      (match, imgUrl) => {
        const mapped = imageMap.get(imgUrl);
        return mapped ? `url('${mapped}')` : match;
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
function rewriteSrcset(srcset, imageMap) {
  return srcset
    .split(',')
    .map(entry => {
      const trimmed = entry.trim();
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) {
        const mapped = imageMap.get(trimmed);
        return mapped || trimmed;
      }
      const url = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      const mapped = imageMap.get(url);
      return (mapped || url) + descriptor;
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
