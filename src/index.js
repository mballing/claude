#!/usr/bin/env node
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { Command } from 'commander';
import chalk from 'chalk';
import { scrapeUrls } from './scraper.js';

const program = new Command();

program
  .name('scraper')
  .description('Scrape web page body content with full CSS and image replication')
  .argument('[urls...]', 'One or more URLs to scrape')
  .option('-f, --file <path>', 'Path to a JSON file containing an array of URLs')
  .option('-o, --output <dir>', 'Output directory', './output')
  .option('-c, --concurrency <n>', 'Max simultaneous pages', '2')
  .option('--timeout <ms>', 'Page load timeout in milliseconds', '30000')
  .option('-v, --verbose', 'Show detailed logs')
  .version('1.0.0');

program.parse();

const cliUrls = program.args;
const opts = program.opts();

async function main() {
  // ── Collect URLs ──────────────────────────────────────────────────────────

  let urls = [...cliUrls];

  if (opts.file) {
    const filePath = path.resolve(opts.file);
    if (!existsSync(filePath)) {
      console.error(chalk.red(`Error: File not found: ${filePath}`));
      process.exit(1);
    }
    const raw = await readFile(filePath, 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error(chalk.red(`Error: Invalid JSON in ${filePath}`));
      process.exit(1);
    }
    if (!Array.isArray(parsed)) {
      console.error(chalk.red(`Error: JSON file must contain an array of URLs`));
      process.exit(1);
    }
    for (const entry of parsed) {
      const url = typeof entry === 'string' ? entry : entry?.url;
      if (url) urls.push(url);
    }
  } else if (urls.length === 0) {
    // Try default urls.json in current directory
    const defaultFile = path.resolve('urls.json');
    if (existsSync(defaultFile)) {
      console.log(chalk.dim(`No URLs provided. Reading from ${defaultFile}...\n`));
      const raw = await readFile(defaultFile, 'utf8');
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            const url = typeof entry === 'string' ? entry : entry?.url;
            if (url) urls.push(url);
          }
        }
      } catch { /* ignore parse errors on default file */ }
    }
  }

  // Validate URLs
  const validUrls = [];
  for (const raw of urls) {
    try {
      new URL(raw);
      validUrls.push(raw);
    } catch {
      console.warn(chalk.yellow(`Warning: Skipping invalid URL: ${raw}`));
    }
  }

  if (validUrls.length === 0) {
    console.error(chalk.red('Error: No valid URLs to scrape.'));
    console.error('Usage:');
    console.error('  node src/index.js https://example.com');
    console.error('  node src/index.js --file urls.json');
    process.exit(1);
  }

  // ── Run scraper ───────────────────────────────────────────────────────────

  const options = {
    output: path.resolve(opts.output),
    concurrency: Math.max(1, parseInt(opts.concurrency, 10) || 2),
    timeout: Math.max(5000, parseInt(opts.timeout, 10) || 30000),
    verbose: Boolean(opts.verbose),
  };

  console.log(chalk.bold('\nWeb Scraper'));
  console.log(`URLs:        ${validUrls.length}`);
  console.log(`Output:      ${options.output}`);
  console.log(`Concurrency: ${options.concurrency}`);
  console.log(`Timeout:     ${options.timeout}ms`);

  const { succeeded, failed } = await scrapeUrls(validUrls, options);

  // ── Print summary ─────────────────────────────────────────────────────────

  console.log('\n' + '─'.repeat(60));
  console.log(chalk.bold('Summary'));
  console.log(`  ${chalk.green('✓')} Succeeded: ${succeeded.length}`);
  for (const { url, folder } of succeeded) {
    console.log(`    ${chalk.dim(url)}`);
    console.log(`    ${chalk.green('->')} ${folder}`);
  }

  if (failed.length > 0) {
    console.log(`  ${chalk.red('✗')} Failed: ${failed.length}`);
    for (const { url, error } of failed) {
      console.log(`    ${chalk.dim(url)}`);
      console.log(`    ${chalk.red('!')} ${error}`);
    }
  }

  console.log('─'.repeat(60) + '\n');

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(chalk.red(`\nFatal error: ${err.message}`));
  if (opts.verbose) console.error(err.stack);
  process.exit(1);
});
