#!/usr/bin/env node
/**
 * Andrews Family Daily Digest - Fetch & Generate Script
 * 
 * Usage:
 *   node fetch-digest.js                    # Generate today's digest
 *   node fetch-digest.js --dry-run          # Fetch feeds but skip Claude API
 *   node fetch-digest.js --date 2026-03-08  # Regenerate a past digest
 * 
 * Output:
 *   output/digest-YYYY-MM-DD.html
 *   output/digest-latest.html  (always overwritten with most recent)
 *   output/digest-YYYY-MM-DD.json  (raw data for HLMS API integration)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import Parser from 'rss-parser';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const parser = new Parser({ timeout: 10000 });
const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// --- CLI args ---
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const dateArg = args.find(a => a.startsWith('--date='))?.split('=')[1];
const targetDate = dateArg ? new Date(dateArg) : new Date();

// --- Load config ---
const config = yaml.load(fs.readFileSync(path.join(__dirname, 'subscriptions.yaml'), 'utf8'));
const { meta, categories, subscriptions } = config;

const dateStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD
const lookbackMs = (meta.lookback_hours || 24) * 60 * 60 * 1000;
const cutoff = new Date(targetDate.getTime() - lookbackMs);

console.log(`\nAndrews Family Digest -- ${dateStr}`);
console.log(`   Lookback: ${meta.lookback_hours}h (since ${cutoff.toISOString()})`);
console.log(`   Feeds: ${subscriptions.filter(s => s.active).length} active\n`);

// --- Step 1: Fetch all feeds ---
async function fetchFeed(sub) {
  try {
    const feed = await parser.parseURL(sub.url);
    const recent = feed.items.filter(item => {
      const pub = new Date(item.pubDate || item.isoDate || 0);
      return pub >= cutoff;
    });

    return recent.map(item => ({
      source: sub.name,
      category: sub.category,
      priority: sub.priority,
      title: item.title?.trim() || 'Untitled',
      url: item.link || item.guid || '',
      pubDate: item.pubDate || item.isoDate,
      excerpt: stripHtml(item.contentSnippet || item.content || item.summary || '').slice(0, 400),
    }));
  } catch (err) {
    console.warn(`  [WARN] ${sub.name}: ${err.message}`);
    return [];
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// --- Step 2: Summarize with Claude ---
async function summarizeCategory(categoryId, items) {
  if (isDryRun) {
    return items.map(item => ({
      ...item,
      summary: '[DRY RUN] Summary skipped.',
      pullQuote: '',
      relevanceScore: 5,
    }));
  }

  const categoryLabel = categories.find(c => c.id === categoryId)?.label || categoryId;

  const prompt = `You are an editorial assistant for the Andrews family's daily news digest.

Family context:
- Seth and Maria are homeschooling parents in The Woodlands, Texas
- Three children: Lucas (age 9, 3rd grade, serious baseball player — catcher/pitcher), Dylan (1st grade), Maxi (Pre-K)
- Homeschool approach: secular, academically rigorous, Enlightenment/liberal arts values
- Seth is interested in health optimization (low-carb, strength training, body composition)
- Lucas is in competitive baseball development (DVS biomechanics, pitching velocity, catching)

Category: ${categoryLabel}

Here are today's articles from this category. For each article, return a JSON array where each object has:
- "title": original title (unchanged)
- "url": original url (unchanged)  
- "source": original source (unchanged)
- "pubDate": original pubDate (unchanged)
- "summary": 2-sentence newspaper-style summary. Factual, specific, no fluff. Write as if for a sophisticated parent reader.
- "pullQuote": One compelling sentence fragment (8-15 words) that captures the most actionable or surprising insight. No quotes around it.
- "relevanceScore": Integer 1-10. Score based on how relevant this article is to the Andrews family context above. 10 = directly actionable for their situation. 1 = tangentially related.
- "featuredCandidate": boolean. True only if this article is genuinely exceptional — breakthrough research, directly actionable for Lucas's development, or highly relevant to their homeschool approach.

Return ONLY valid JSON array. No markdown, no preamble.

Articles:
${JSON.stringify(items.map(i => ({ title: i.title, url: i.url, source: i.source, excerpt: i.excerpt })), null, 2)}`;

  const fallback = () => items.map(item => ({ ...item, summary: item.excerpt.slice(0, 200), pullQuote: '', relevanceScore: 5, featuredCandidate: false }));

  try {
    const response = await client.messages.create({
      model: meta.model || 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    let rawText = response.content[0].text;
    let parsed;

    // Attempt 1: strip markdown fences, trailing commas, and parse
    try {
      const cleaned = rawText
        .replace(/```json\s*/g, '').replace(/```\s*/g, '')
        .replace(/,\s*([\]}])/g, '$1')
        .trim();
      parsed = JSON.parse(cleaned);
    } catch (parseErr1) {
      console.warn(`  ⚠️  ${categoryId}: JSON parse failed (attempt 1), raw response:`);
      console.warn(`     ${rawText.slice(0, 200)}...`);

      // Attempt 2: ask Claude to fix the JSON
      try {
        const fixResponse = await client.messages.create({
          model: meta.model || 'claude-sonnet-4-20250514',
          max_tokens: 2000,
          messages: [
            { role: 'user', content: prompt },
            { role: 'assistant', content: rawText },
            { role: 'user', content: 'Your previous response was not valid JSON. Return ONLY the corrected JSON array — no markdown, no commentary, no trailing commas.' },
          ],
        });

        const fixedText = fixResponse.content[0].text
          .replace(/```json\s*/g, '').replace(/```\s*/g, '')
          .replace(/,\s*([\]}])/g, '$1')
          .trim();
        parsed = JSON.parse(fixedText);
        console.log(`  ✅ ${categoryId}: JSON repair succeeded on retry`);
      } catch (parseErr2) {
        console.error(`  ❌ ${categoryId}: JSON repair failed, using excerpt fallback`);
        return fallback();
      }
    }

    // Merge back fields not in Claude's output
    return parsed.map((s, i) => ({
      ...items[i],
      ...s,
    }));
  } catch (err) {
    console.error(`  ❌ Claude API error for ${categoryId}:`, err.message);
    return fallback();
  }
}

// --- Step 2b: Generate daily briefing ---
async function generateBriefing(grouped, categories) {
  if (isDryRun) {
    return {
      editorsNote: '[DRY RUN] Editor\'s note skipped.',
      bullets: Object.keys(grouped).map(catId => ({
        category: catId,
        icon: grouped[catId].category.icon,
        text: '[DRY RUN] Briefing bullet skipped.'
      }))
    };
  }

  // Collect top article per category (highest relevanceScore)
  const topArticles = Object.entries(grouped).map(([catId, group]) => {
    const top = [...group.items].sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))[0];
    return {
      category: group.category.label,
      categoryId: catId,
      icon: group.category.icon,
      title: top.title,
      summary: top.summary,
      relevanceScore: top.relevanceScore
    };
  });

  const prompt = `You are the editor of The Andrews Family Digest, a daily newspaper for a homeschooling family in Texas.

Here are today's top stories by category:
${JSON.stringify(topArticles, null, 2)}

Write a daily briefing with:
1. "editorsNote": A single sentence (15-25 words) capturing today's overall theme or mood across all categories. Written in a warm, intelligent editorial voice. No cliches.
2. "bullets": An array with one object per category above. Each object has:
   - "category": the categoryId (unchanged)
   - "text": A single punchy sentence (12-20 words) about that category's top story. Be specific and actionable, not vague.

Return ONLY valid JSON. No markdown, no preamble.`;

  try {
    const response = await client.messages.create({
      model: meta.model || 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    let rawText = response.content[0].text;
    const cleaned = rawText
      .replace(/```json\s*/g, '').replace(/```\s*/g, '')
      .replace(/,\s*([\]}])/g, '$1')
      .trim();
    const parsed = JSON.parse(cleaned);

    // Attach icons from category data
    parsed.bullets = parsed.bullets.map(b => ({
      ...b,
      icon: grouped[b.category]?.category.icon || ''
    }));

    return parsed;
  } catch (err) {
    console.warn(`  ⚠️  Briefing generation failed: ${err.message}`);
    return null;
  }
}

// --- Step 3: Build digest data structure ---
async function buildDigest() {
  // Fetch all feeds in parallel
  console.log('📡 Fetching feeds...');
  const activeFeeds = subscriptions.filter(s => s.active);
  const fetchResults = await Promise.allSettled(activeFeeds.map(fetchFeed));
  
  let allItems = fetchResults
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  console.log(`   Found ${allItems.length} articles in lookback window\n`);

  if (allItems.length === 0) {
    console.log('No articles found. Try increasing lookback_hours in subscriptions.yaml.');
    process.exit(0);
  }

  // Group by category
  const grouped = {};
  for (const cat of categories) {
    const items = allItems
      .filter(i => i.category === cat.id)
      .sort((a, b) => a.priority - b.priority)
      .slice(0, meta.max_per_category || 5);
    
    if (items.length > 0) {
      grouped[cat.id] = { category: cat, items };
    }
  }

  // Summarize each category
  console.log('🤖 Summarizing with Claude...');
  for (const [catId, group] of Object.entries(grouped)) {
    console.log(`   • ${group.category.label} (${group.items.length} articles)`);
    group.items = await summarizeCategory(catId, group.items);
  }

  // Find featured article (highest relevanceScore among featuredCandidates)
  const allSummarized = Object.values(grouped).flatMap(g => g.items);
  const featured = allSummarized
    .filter(i => i.featuredCandidate)
    .sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))[0]
    || allSummarized.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0))[0];

  // Generate daily briefing
  console.log('\n📋 Generating daily briefing...');
  const briefing = await generateBriefing(grouped, categories);

  return { meta, categories, grouped, featured, briefing, dateStr, generatedAt: new Date().toISOString() };
}

// --- Step 4: Render HTML ---
function renderHtml(digest) {
  const { meta: m, grouped, featured, briefing, dateStr } = digest;
  const displayDate = new Date(dateStr + 'T12:00:00').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const categoryCount = Object.keys(grouped).length;
  const articleCount = Object.values(grouped).reduce((sum, g) => sum + g.items.length, 0);

  const sectionsHtml = Object.entries(grouped).map(([catId, group]) => {
    const { category, items } = group;
    
    const articlesHtml = items
      .filter(i => i !== featured)
      .map(item => `
        <article class="article-card" data-score="${item.relevanceScore || 5}">
          <div class="article-source">${escHtml(item.source)}</div>
          <h3 class="article-title">
            <a href="${escHtml(item.url)}" target="_blank" rel="noopener">${escHtml(item.title)}</a>
          </h3>
          ${item.pullQuote ? `<div class="pull-quote">"${escHtml(item.pullQuote)}"</div>` : ''}
          <p class="article-summary">${escHtml(item.summary)}</p>
          <div class="article-meta">
            <span class="relevance-badge score-${Math.round(item.relevanceScore || 5)}">${item.relevanceScore || '?'}/10</span>
            <span class="pub-date">${formatDate(item.pubDate)}</span>
          </div>
        </article>
      `).join('');

    return `
      <section class="digest-section" id="section-${catId}">
        <header class="section-header" style="--section-color: ${category.color}">
          <span class="section-icon">${category.icon}</span>
          <h2 class="section-title">${escHtml(category.label)}</h2>
          <span class="section-count">${items.filter(i => i !== featured).length} articles</span>
        </header>
        <div class="articles-grid">
          ${articlesHtml || '<p class="no-articles">No new articles today.</p>'}
        </div>
      </section>
    `;
  }).join('');

  const featuredHtml = featured ? `
    <section class="featured-story">
      <div class="featured-eyebrow">
        <span class="featured-label">⭐ Editor's Pick</span>
        <span class="featured-source">${escHtml(featured.source)}</span>
      </div>
      <h2 class="featured-title">
        <a href="${escHtml(featured.url)}" target="_blank" rel="noopener">${escHtml(featured.title)}</a>
      </h2>
      ${featured.pullQuote ? `<blockquote class="featured-quote">${escHtml(featured.pullQuote)}</blockquote>` : ''}
      <p class="featured-summary">${escHtml(featured.summary)}</p>
      <div class="featured-footer">
        <span class="relevance-badge score-${Math.round(featured.relevanceScore || 5)}">${featured.relevanceScore}/10 relevance</span>
        <span class="pub-date">${formatDate(featured.pubDate)}</span>
        <a href="${escHtml(featured.url)}" target="_blank" class="read-more">Read full article →</a>
      </div>
    </section>
  ` : '';

  const navHtml = Object.entries(grouped).map(([catId, g]) =>
    `<a href="#section-${catId}" class="nav-link">${g.category.icon} ${g.category.label}</a>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(m.digest_title)} — ${displayDate}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,300;0,8..60,400;0,8..60,600;1,8..60,300&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    /* =========================================================
       THE ANDREWS DIGEST — Broadsheet newspaper aesthetic
       Dark ink, cream newsprint, classic editorial typography
       ========================================================= */

    :root {
      --ink: #1a1612;
      --ink-light: #3d3530;
      --newsprint: #f5f0e8;
      --newsprint-dark: #ede8dc;
      --rule: #2a2420;
      --rule-light: #c8bfaf;
      --accent: #8b1a1a;
      --accent-light: #c0392b;
      --column-gap: 2rem;
      --max-width: 1100px;
    }

    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Source Serif 4', Georgia, serif;
      background: var(--newsprint);
      color: var(--ink);
      line-height: 1.6;
      font-size: 16px;
    }

    a { color: inherit; text-decoration: none; }
    a:hover { color: var(--accent); text-decoration: underline; }

    /* --- MASTHEAD --- */
    .masthead {
      border-top: 4px solid var(--ink);
      border-bottom: 4px double var(--ink);
      padding: 1.5rem 2rem 1rem;
      text-align: center;
      background: var(--newsprint);
      position: relative;
    }

    .masthead-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-family: 'DM Mono', monospace;
      font-size: 0.65rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-light);
      margin-bottom: 0.75rem;
      border-bottom: 1px solid var(--rule-light);
      padding-bottom: 0.5rem;
    }

    .digest-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: clamp(2.5rem, 6vw, 5rem);
      font-weight: 900;
      letter-spacing: -0.02em;
      line-height: 1;
      color: var(--ink);
      text-transform: uppercase;
    }

    .digest-tagline {
      font-family: 'Playfair Display', Georgia, serif;
      font-style: italic;
      font-size: 0.95rem;
      color: var(--ink-light);
      margin-top: 0.4rem;
      letter-spacing: 0.03em;
    }

    .masthead-rule {
      border: none;
      border-top: 1px solid var(--rule-light);
      margin: 0.75rem 0 0;
    }

    /* --- SECTION NAV --- */
    .section-nav {
      background: var(--ink);
      padding: 0.4rem 2rem;
      display: flex;
      gap: 0;
      overflow-x: auto;
      justify-content: center;
      flex-wrap: wrap;
    }

    .nav-link {
      color: var(--newsprint);
      font-family: 'DM Mono', monospace;
      font-size: 0.65rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 0.35rem 1rem;
      white-space: nowrap;
      border-right: 1px solid rgba(255,255,255,0.2);
      transition: background 0.15s;
    }

    .nav-link:last-child { border-right: none; }
    .nav-link:hover { background: rgba(255,255,255,0.12); color: var(--newsprint); text-decoration: none; }

    /* --- DAILY BRIEFING --- */
    .daily-briefing {
      background: var(--ink);
      color: var(--newsprint);
      padding: 1.25rem 2rem;
    }

    .briefing-inner {
      max-width: var(--max-width);
      margin: 0 auto;
    }

    .briefing-header {
      font-family: 'DM Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: rgba(245,240,232,0.5);
      margin-bottom: 0.6rem;
    }

    .briefing-editors-note {
      font-family: 'Playfair Display', Georgia, serif;
      font-style: italic;
      font-size: 1.05rem;
      line-height: 1.5;
      color: var(--newsprint);
      border-bottom: 1px solid rgba(245,240,232,0.15);
      padding-bottom: 0.75rem;
      margin-bottom: 0.75rem;
    }

    .briefing-bullets {
      list-style: none;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 0.4rem 2rem;
    }

    .briefing-bullet {
      font-size: 0.82rem;
      line-height: 1.5;
      color: rgba(245,240,232,0.85);
      padding: 0.25rem 0;
    }

    .briefing-bullet-icon {
      margin-right: 0.4rem;
    }

    @media (max-width: 600px) {
      .daily-briefing { padding: 1rem; }
      .briefing-bullets { grid-template-columns: 1fr; }
    }

    /* --- MAIN CONTENT --- */
    .digest-body {
      max-width: var(--max-width);
      margin: 0 auto;
      padding: 2rem 1.5rem;
    }

    /* --- FEATURED STORY --- */
    .featured-story {
      border-top: 3px solid var(--ink);
      border-bottom: 3px double var(--rule-light);
      padding: 2rem 0 1.5rem;
      margin-bottom: 2.5rem;
    }

    .featured-eyebrow {
      display: flex;
      gap: 1rem;
      align-items: center;
      margin-bottom: 0.75rem;
      font-family: 'DM Mono', monospace;
      font-size: 0.68rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .featured-label {
      color: var(--accent);
      font-weight: 500;
    }

    .featured-source {
      color: var(--ink-light);
    }

    .featured-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: clamp(1.6rem, 3.5vw, 2.4rem);
      font-weight: 700;
      line-height: 1.2;
      color: var(--ink);
      margin-bottom: 0.75rem;
    }

    .featured-title a:hover { color: var(--accent); text-decoration: none; }

    .featured-quote {
      font-family: 'Playfair Display', Georgia, serif;
      font-style: italic;
      font-size: 1.2rem;
      color: var(--accent);
      border-left: 3px solid var(--accent);
      padding: 0.25rem 0 0.25rem 1rem;
      margin: 0.75rem 0;
      line-height: 1.4;
    }

    .featured-summary {
      font-size: 1.05rem;
      line-height: 1.7;
      color: var(--ink-light);
      max-width: 70ch;
    }

    .featured-footer {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-top: 1rem;
      flex-wrap: wrap;
    }

    .read-more {
      font-family: 'DM Mono', monospace;
      font-size: 0.7rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--accent);
      border-bottom: 1px solid var(--accent);
      padding-bottom: 1px;
    }

    .read-more:hover { color: var(--ink); border-color: var(--ink); text-decoration: none; }

    /* --- DIGEST SECTIONS --- */
    .digest-section {
      margin-bottom: 2.5rem;
      break-inside: avoid;
    }

    .section-header {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      border-top: 3px solid var(--section-color, var(--ink));
      padding: 0.6rem 0 0.5rem;
      margin-bottom: 1.25rem;
    }

    .section-icon { font-size: 1rem; }

    .section-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1rem;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--section-color, var(--ink));
      flex: 1;
    }

    .section-count {
      font-family: 'DM Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--ink-light);
      border: 1px solid var(--rule-light);
      padding: 0.15rem 0.4rem;
    }

    /* --- ARTICLE GRID: 2-3 column newspaper columns --- */
    .articles-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 0;
    }

    .article-card {
      padding: 1rem 1.25rem 1rem 0;
      border-right: 1px solid var(--rule-light);
      border-bottom: 1px solid var(--rule-light);
    }

    .article-card:last-child { border-right: none; }

    .article-source {
      font-family: 'DM Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--ink-light);
      margin-bottom: 0.3rem;
    }

    .article-title {
      font-family: 'Playfair Display', Georgia, serif;
      font-size: 1rem;
      font-weight: 700;
      line-height: 1.3;
      margin-bottom: 0.4rem;
    }

    .article-title a:hover { color: var(--accent); text-decoration: none; }

    .pull-quote {
      font-family: 'Playfair Display', Georgia, serif;
      font-style: italic;
      font-size: 0.85rem;
      color: var(--accent-light);
      border-left: 2px solid var(--accent-light);
      padding-left: 0.6rem;
      margin: 0.5rem 0;
      line-height: 1.4;
    }

    .article-summary {
      font-size: 0.85rem;
      line-height: 1.65;
      color: var(--ink-light);
    }

    .article-meta {
      display: flex;
      align-items: center;
      gap: 0.6rem;
      margin-top: 0.6rem;
    }

    .relevance-badge {
      font-family: 'DM Mono', monospace;
      font-size: 0.6rem;
      letter-spacing: 0.04em;
      padding: 0.1rem 0.35rem;
      border-radius: 2px;
      font-weight: 500;
    }

    /* Score color scale */
    .score-1, .score-2, .score-3 { background: #eee; color: #666; }
    .score-4, .score-5 { background: #fff3cd; color: #856404; }
    .score-6, .score-7 { background: #d1e7dd; color: #0a5b39; }
    .score-8, .score-9, .score-10 { background: #1a6b3a; color: #fff; }

    .pub-date {
      font-family: 'DM Mono', monospace;
      font-size: 0.58rem;
      color: #999;
      letter-spacing: 0.04em;
    }

    /* --- FOOTER --- */
    .digest-footer {
      border-top: 3px double var(--ink);
      padding: 1.5rem 2rem;
      text-align: center;
      font-family: 'DM Mono', monospace;
      font-size: 0.62rem;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-light);
      background: var(--newsprint-dark);
    }

    /* --- PRINT STYLES --- */
    @media print {
      .section-nav { display: none; }
      .article-card { break-inside: avoid; }
      body { font-size: 11pt; }
    }

    /* --- RESPONSIVE --- */
    @media (max-width: 600px) {
      .masthead { padding: 1rem; }
      .masthead-top { font-size: 0.55rem; gap: 0.5rem; flex-wrap: wrap; }
      .digest-body { padding: 1rem; }
      .articles-grid { grid-template-columns: 1fr; }
      .article-card { border-right: none; }
    }

    /* HLMS integration hint: when embedded in parent-digest.html,
       add class="hlms-embed" to <body> to suppress masthead/footer */
    body.hlms-embed .masthead,
    body.hlms-embed .digest-footer { display: none; }
    body.hlms-embed .section-nav { position: sticky; top: 0; z-index: 10; }
  </style>
</head>
<body>

  <header class="masthead">
    <div class="masthead-top">
      <span>Vol. 1</span>
      <span>Est. 2026 · The Woodlands, TX</span>
      <span>${displayDate}</span>
    </div>
    <h1 class="digest-title">${escHtml(m.digest_title)}</h1>
    <p class="digest-tagline">${escHtml(m.tagline)}</p>
    <hr class="masthead-rule">
    <p style="font-family: 'DM Mono', monospace; font-size: 0.62rem; letter-spacing: 0.05em; text-transform: uppercase; color: #666; margin-top: 0.4rem;">
      ${articleCount} articles across ${categoryCount} sections
    </p>
  </header>

  <nav class="section-nav">${navHtml}</nav>

  ${briefing ? `
  <section class="daily-briefing">
    <div class="briefing-inner">
      <div class="briefing-header">Daily Briefing</div>
      ${briefing.editorsNote ? `<div class="briefing-editors-note">${escHtml(briefing.editorsNote)}</div>` : ''}
      <ul class="briefing-bullets">
        ${(briefing.bullets || []).map(b => `
          <li class="briefing-bullet">
            <span class="briefing-bullet-icon">${b.icon || ''}</span>
            ${escHtml(b.text)}
          </li>
        `).join('')}
      </ul>
    </div>
  </section>
  ` : ''}

  <main class="digest-body">
    ${featuredHtml}
    ${sectionsHtml}
  </main>

  <footer class="digest-footer">
    Generated ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT
    · Andrews Family Homeschool LMS
    · For personal use only
  </footer>

</body>
</html>`;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

// --- Main ---
(async () => {
  try {
    const digest = await buildDigest();
    
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    // Write JSON (for HLMS API integration)
    const jsonPath = path.join(outputDir, `digest-${dateStr}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(digest, null, 2));

    // Write HTML
    const htmlPath = path.join(outputDir, `digest-${dateStr}.html`);
    const latestPath = path.join(outputDir, 'digest-latest.html');
    const html = renderHtml(digest);
    
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(latestPath, html);

    console.log(`\n✅ Digest generated:`);
    console.log(`   HTML: output/digest-${dateStr}.html`);
    console.log(`   JSON: output/digest-${dateStr}.json`);
    console.log(`   Latest: output/digest-latest.html\n`);

  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  }
})();
