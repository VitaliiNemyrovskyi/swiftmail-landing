// Markdown → HTML renderer for blog posts. Outputs HTML compatible with the
// existing blog post template (see blog/abandoned-cart-email.html for shape).
//
// Why hand-roll instead of using markdown-it / marked?
//   - Our markdown subset is small (headings, paragraphs, links, code, lists)
//   - We want exact control over class names + attributes Cloudflare/SEO needs
//   - One file, no dependency, no surprises

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { urlFor } from './slug.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Map category → legacy fallback image name. Mirrors publish.mjs#categoryToImage —
// keep in sync. Used only when /assets/blog/<slug>.jpg is absent at render time.
function categoryToFallbackImage(cat) {
  return {
    behavioral: 'behavioral-capture',
    deliverability: 'realtime-intervention',
    ecommerce: 'multichannel',
    comparison: 'integrations',
    strategy: 'inbox-preview',
  }[cat] || 'inbox-preview';
}

/**
 * Convert a draft markdown body to HTML wrapped in the blog post template.
 *
 * @param {object} opts
 * @param {object} opts.frontmatter - Article metadata
 * @param {string} opts.body - Markdown body
 * @param {string} opts.lang - 'en' | 'es' | 'fr' | 'de' | 'pt'
 * @param {object} opts.i18n - i18n strings (loaded from i18n.yaml)
 * @param {Record<string, string>} opts.translatedSlugs - {en: slug, es: slug, ...} same-slug today but futurized
 * @returns {string} Full <!doctype html>...</html>
 */
export function renderArticle({ frontmatter, body, lang, i18n, translatedSlugs }) {
  const t = (key, vars = {}) => {
    let s = i18n[key]?.[lang] ?? i18n[key]?.en ?? key;
    for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
  };

  const title = frontmatter.title;
  const desc = frontmatter.description;
  const slug = frontmatter.slug;
  const category = frontmatter.category;
  const date = frontmatter.date;
  const readTime = frontmatter.read_time;
  const author = frontmatter.author || 'SwiftMail';
  // Prefer per-article Pexels-fetched image (/assets/blog/<slug>.jpg) over
  // the legacy reused feature webp. Frontmatter hero_image override wins
  // over both. CRITICAL: check fs.existsSync — if .jpg doesn't actually
  // exist on disk at render time, fall back to category webp instead of
  // shipping a broken <img src> that Cloudflare would 404 against.
  const blogJpgPath = path.join(REPO_ROOT, 'assets', 'blog', `${slug}.jpg`);
  const heroImg = frontmatter.hero_image
    || (fs.existsSync(blogJpgPath)
        ? `/assets/blog/${slug}.jpg`
        : `/assets/features/${categoryToFallbackImage(category)}.webp`);
  const heroAlt = frontmatter.hero_alt || title;
  // SEO + social fields. Falling back gracefully when frontmatter is missing
  // them — never emit empty `content=""` because that confuses some parsers.
  const targetKeyword = frontmatter.target_keyword || '';
  const articleTags = frontmatter.tags
    ? (Array.isArray(frontmatter.tags) ? frontmatter.tags : String(frontmatter.tags).split(',').map((s) => s.trim()).filter(Boolean))
    : (targetKeyword ? [targetKeyword] : []);
  const lastModified = frontmatter.modified || frontmatter.date;

  const pathPrefix = lang === 'en' ? '' : '../';
  const homePath = lang === 'en' ? '/' : `/${lang}/`;

  const contentHtml = mdToHtml(body);

  const hreflang = ['en', 'es', 'fr', 'de', 'pt', 'uk']
    .map((l) => `  <link rel="alternate" hreflang="${l}" href="${urlFor(translatedSlugs[l] || slug, l)}">`)
    .join('\n');

  // Open Graph article-spec tags require BCP-47-style locales — Facebook,
  // LinkedIn, Telegram all expect underscore-form (en_US, es_ES). Twitter
  // takes them too. Pick a reasonable region per language; if the site
  // adds more languages later, extend here.
  const ogLocaleMap = { en: 'en_US', es: 'es_ES', fr: 'fr_FR', de: 'de_DE', pt: 'pt_BR', uk: 'uk_UA' };
  const ogLocale = ogLocaleMap[lang] || 'en_US';
  const ogLocaleAlternate = Object.entries(ogLocaleMap)
    .filter(([l]) => l !== lang)
    .map(([, locale]) => `  <meta property="og:locale:alternate" content="${locale}">`)
    .join('\n');

  const langOptions = [
    { code: 'en', label: 'English' },
    { code: 'es', label: 'Español' },
    { code: 'fr', label: 'Français' },
    { code: 'de', label: 'Deutsch' },
    { code: 'pt', label: 'Português' },
    { code: 'uk', label: 'Українська' },
  ];
  // Switcher points to the same article in the target language. The old
  // behavior of always linking to /<lang>/blog/ broke the UX: /uk/blog/
  // (and similarly for es/fr/de/pt) doesn't exist as a static index, so
  // Cloudflare served the SPA homepage fallback. The translated article
  // page itself does exist (we just rendered it), so link directly to it.
  // Fall back to current slug if a translatedSlugs entry is missing
  // (shared-slug strategy makes this near-always correct).
  const langSwitcherHtml = langOptions
    .map((o) => {
      const targetSlug = translatedSlugs[o.code] || slug;
      const href = o.code === 'en'
        ? `/blog/${targetSlug}`
        : `/${o.code}/blog/${targetSlug}`;
      const active = o.code === lang ? ' active' : '';
      return `            <a class="blog-lang-option${active}" href="${href}" hreflang="${o.code}" role="menuitem">${o.label}</a>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="icon" type="image/svg+xml" href="/assets/logo-orange.svg">
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <script>
    !function(s){s.sm=s.sm||function(){(s.sm.q=s.sm.q||[]).push(arguments)}}(window);
    sm('init', 'pk_live_bea0d715ec2ca156ebe31e205c5364fc', { siteId: '2cff4622-a98a-455f-85c5-db0f3f827b25' });
  </script>
  <script>(function(){var loaded=false;var evs=['scroll','touchstart','keydown','mousemove','pointerdown'];function l(){if(loaded)return;loaded=true;evs.forEach(function(e){window.removeEventListener(e,l,{passive:true});});var s=document.createElement('script');s.src='https://app.swift-mail.app/sdk/sm.js';s.async=true;document.head.appendChild(s);}evs.forEach(function(e){window.addEventListener(e,l,{passive:true,once:true});});setTimeout(l,8000);})();</script>

  <title>${escapeHtml(title)} — SwiftMail</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <link rel="canonical" href="${urlFor(slug, lang)}">

  <!-- Crawl directives — 'max-image-preview:large' enables big hero
       thumbnail in Google search results, observed CTR uplift vs default. -->
  <meta name="robots" content="index,follow,max-image-preview:large">
  <meta name="author" content="${escapeHtml(author)}">
  ${(articleTags.length > 0 || targetKeyword)
      ? `<meta name="keywords" content="${
          (articleTags.length > 0 ? articleTags : [targetKeyword])
            .map(escapeHtml)
            .join(', ')
        }">`
      : ''}

  <!-- hreflang cross-language -->
${hreflang}
  <link rel="alternate" hreflang="x-default" href="${urlFor(slug, 'en')}">

  <!-- Open Graph + article-spec extension (Facebook, LinkedIn, Slack
       previews use these; missing fields → social cards show "no date"
       instead of "Published 2 days ago"). -->
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${urlFor(slug, lang)}">
  <meta property="og:image" content="https://swift-mail.app${heroImg}">
  <meta property="og:image:alt" content="${escapeHtml(heroAlt)}">
  <meta property="og:site_name" content="SwiftMail">
  <meta property="og:locale" content="${ogLocale}">
${ogLocaleAlternate}
  <meta property="article:published_time" content="${date}">
  <meta property="article:modified_time" content="${lastModified}">
  <meta property="article:author" content="${escapeHtml(author)}">
  <meta property="article:section" content="${escapeHtml(category)}">
${articleTags.map((tag) => `  <meta property="article:tag" content="${escapeHtml(tag)}">`).join('\n')}

  <!-- Twitter Card — explicit fields override og:* fallbacks. Some
       Twitter previews ignore og:* entirely; explicit is reliable. -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="https://swift-mail.app${heroImg}">
  <meta name="twitter:image:alt" content="${escapeHtml(heroAlt)}">

  <!-- JSON-LD: Article (existing rich-result data) + BreadcrumbList
       (gives Google's blue-link preview a navigation row underneath
       the title — measurable CTR uplift on tracked SERPs). -->
  <script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Article',
        headline: title,
        description: desc,
        image: `https://swift-mail.app${heroImg}`,
        author: { '@type': 'Person', name: author, url: 'https://swift-mail.app/' },
        publisher: {
          '@type': 'Organization',
          name: 'SwiftMail',
          logo: { '@type': 'ImageObject', url: 'https://swift-mail.app/assets/logo-orange.svg' },
        },
        datePublished: date,
        dateModified: lastModified,
        mainEntityOfPage: { '@type': 'WebPage', '@id': urlFor(slug, lang) },
        inLanguage: lang,
        articleSection: category,
        ...(articleTags.length ? { keywords: articleTags.join(', ') } : {}),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: lang === 'en' ? 'https://swift-mail.app/' : `https://swift-mail.app/${lang}/` },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: lang === 'en' ? 'https://swift-mail.app/blog/' : `https://swift-mail.app/${lang}/blog/` },
          { '@type': 'ListItem', position: 3, name: title, item: urlFor(slug, lang) },
        ],
      },
    ],
  })}</script>

  <link rel="stylesheet" href="${pathPrefix}../css/style.css" media="print" onload="this.media='all'">
  <noscript><link rel="stylesheet" href="${pathPrefix}../css/style.css"></noscript>
  <style>
    body { background: #f7f9fb; color: #191c1e; font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; }
    .blog-nav { position: fixed; top: 0; left: 0; right: 0; z-index: 100; display: flex; align-items: center; justify-content: space-between; padding: 1rem 2rem; background: rgba(247,249,251,0.97); border-bottom: 1px solid rgba(0,0,0,0.04); }
    .blog-nav-logo { font-size: 1.25rem; font-weight: 800; font-style: italic; color: #191c1e; }
    .blog-nav-right { display: flex; align-items: center; gap: 1rem; }
    .blog-nav-back { font-size: 0.875rem; color: #64748b; }
    .blog-nav-back:hover { color: #c2410c; }
    .blog-lang { position: relative; }
    .blog-lang-btn { display: flex; align-items: center; gap: 4px; background: none; border: 0; color: #64748b; font-size: 0.8125rem; font-weight: 600; cursor: pointer; padding: 6px 10px; border-radius: 6px; transition: color 0.15s, background 0.15s; }
    .blog-lang-btn:hover { color: #0f172a; background: rgba(15,23,42,0.04); }
    .blog-lang-arrow { transition: transform 0.15s; }
    .blog-lang.open .blog-lang-arrow { transform: rotate(180deg); }
    .blog-lang-dropdown { position: absolute; top: calc(100% + 6px); right: 0; background: #fff; border: 1px solid #e8eaef; border-radius: 8px; padding: 6px; min-width: 160px; opacity: 0; visibility: hidden; transform: translateY(-4px); transition: all 0.15s; box-shadow: 0 12px 32px rgba(15,23,42,0.10); z-index: 110; }
    .blog-lang.open .blog-lang-dropdown { opacity: 1; visibility: visible; transform: translateY(0); }
    .blog-lang-option { display: block; padding: 7px 12px; font-size: 0.8125rem; color: #64748b; border-radius: 4px; transition: background 0.15s, color 0.15s; }
    .blog-lang-option:hover { background: #f7f9fb; color: #0f172a; }
    .blog-lang-option.active { color: #c2410c; font-weight: 600; }

    .blog-hero { padding: 8rem 2rem 2rem; max-width: 800px; margin: 0 auto; text-align: center; }
    .blog-category { display: inline-block; padding: 0.25rem 0.625rem; border-radius: 9999px; background: rgba(234,88,12,0.08); font: 700 0.625rem system-ui, sans-serif; letter-spacing: 0.12em; text-transform: uppercase; color: #c2410c; margin-bottom: 1rem; }
    .blog-title { font-size: clamp(2rem, 4vw, 2.75rem); font-weight: 900; letter-spacing: -0.03em; line-height: 1.1; color: #0f172a; margin-bottom: 1rem; }
    .blog-meta { font-size: 0.875rem; color: #64748b; margin-bottom: 2rem; }
    .blog-meta span { margin: 0 0.5rem; }

    .blog-hero-img { max-width: 800px; margin: 0 auto 3rem; padding: 0 2rem; }
    .blog-hero-img img { width: 100%; aspect-ratio: 16/10; object-fit: cover; display: block; border-radius: 14px; box-shadow: 0 24px 48px rgba(15,23,42,0.10); }

    .blog-content { max-width: 720px; margin: 0 auto; padding: 0 2rem 4rem; }
    .blog-content h2 { font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em; color: #0f172a; margin: 3rem 0 1rem; line-height: 1.2; }
    .blog-content h3 { font-size: 1.25rem; font-weight: 700; color: #0f172a; margin: 2rem 0 0.75rem; }
    .blog-content p { font-size: 1.0625rem; line-height: 1.75; color: #475569; margin-bottom: 1.25rem; }
    .blog-content ul, .blog-content ol { padding-left: 1.5rem; margin-bottom: 1.25rem; }
    .blog-content li { font-size: 1.0625rem; line-height: 1.7; color: #475569; margin-bottom: 0.5rem; }
    .blog-content strong { color: #0f172a; }
    .blog-content a { color: #c2410c; text-decoration: underline; text-underline-offset: 3px; }
    .blog-content code { background: #f1f5f9; padding: 0.1875rem 0.375rem; border-radius: 0.25rem; font: 0.875rem 'SF Mono', Monaco, Consolas, monospace; color: #0f172a; }
    .blog-content pre { background: #0b1325; color: #dbe2fb; padding: 1.25rem; border-radius: 0.625rem; overflow-x: auto; margin: 1.5rem 0; }
    .blog-content pre code { background: none; padding: 0; color: inherit; font-size: 0.875rem; line-height: 1.6; }
    .blog-content blockquote { border-left: 3px solid #c2410c; padding: 0.5rem 1.5rem; margin: 1.5rem 0; background: #fff; border-radius: 0 0.5rem 0.5rem 0; }
    .blog-content blockquote p { color: #475569; font-style: italic; margin: 0; }
    .blog-content table { border-collapse: collapse; margin: 1.5rem 0; width: 100%; }
    .blog-content th, .blog-content td { padding: 0.625rem 0.875rem; border: 1px solid #e8eaef; text-align: left; font-size: 0.9375rem; }
    .blog-content th { background: #f7f9fb; font-weight: 700; color: #0f172a; }
    .blog-content hr { border: 0; border-top: 1px solid #e8eaef; margin: 2.5rem 0; }

    .blog-cta { text-align: center; padding: 3rem 2rem; margin: 2.5rem 0; background: linear-gradient(135deg, #0b1325 0%, #1a2744 100%); border-radius: 1rem; }
    .blog-cta h3 { font-size: 1.5rem; font-weight: 800; color: #fff; margin-bottom: 0.75rem; }
    .blog-cta p { color: #94a3b8; margin-bottom: 1.5rem; font-size: 0.9375rem; }
    .blog-cta a { display: inline-block; padding: 0.75rem 2rem; background: linear-gradient(135deg, #c2410c, #9a3412); color: #fff; border-radius: 0.5rem; font-weight: 600; text-decoration: none; }

    .blog-footer { text-align: center; padding: 2.5rem 2rem; color: #94a3b8; font-size: 0.8125rem; border-top: 1px solid #e8eaef; }
    .blog-footer a { color: #64748b; }

    @media (max-width: 768px) {
      .blog-title { font-size: 1.75rem; }
      .blog-content h2 { font-size: 1.375rem; }
      .blog-content h3 { font-size: 1.125rem; }
    }
  </style>
</head>
<body>
  <nav class="blog-nav" aria-label="Site navigation">
    <a href="${homePath}" class="blog-nav-logo">SwiftMail</a>
    <div class="blog-nav-right">
      <div class="blog-lang" id="blog-lang">
        <button class="blog-lang-btn" type="button" aria-label="Change language" aria-haspopup="true" aria-expanded="false">
          <span>${lang.toUpperCase()}</span>
          <svg class="blog-lang-arrow" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </button>
        <div class="blog-lang-dropdown" role="menu">
${langSwitcherHtml}
        </div>
      </div>
      <a href="${pathPrefix}blog/" class="blog-nav-back">${escapeHtml(t('nav_back'))}</a>
    </div>
  </nav>
  <script>
    (function () {
      var sw = document.getElementById('blog-lang');
      if (!sw) return;
      var btn = sw.querySelector('.blog-lang-btn');
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = sw.classList.toggle('open');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      document.addEventListener('click', function () {
        sw.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sw.classList.contains('open')) {
          sw.classList.remove('open');
          btn.setAttribute('aria-expanded', 'false');
        }
      });
    })();
  </script>

  <header class="blog-hero">
    <p class="blog-category">${escapeHtml(category)}</p>
    <h1 class="blog-title">${escapeHtml(title)}</h1>
    <p class="blog-meta">
      <time datetime="${date}">${formatDate(date, lang)}</time>
      <span aria-hidden="true">·</span>
      <span>${t('read_time', { n: readTime })}</span>
    </p>
  </header>

  <figure class="blog-hero-img">
    <img src="${heroImg}" alt="${escapeHtml(heroAlt)}" width="800" height="500" loading="eager" decoding="async">
  </figure>

  <main class="blog-content">
${contentHtml}
  </main>

  <footer class="blog-footer">
    <p>© 2026 SwiftMail. <a href="${homePath}">${t('footer_home')}</a> · <a href="${homePath}privacy.html">${t('footer_privacy')}</a> · <a href="${homePath}terms.html">${t('footer_terms')}</a></p>
  </footer>
</body>
</html>
`;
}

// ── Markdown subset → HTML ────────────────────────────────────────────

function mdToHtml(md) {
  // Step 1: extract code blocks (so they're not touched by other transforms)
  const codeBlocks = [];
  md = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push({ lang, code: escapeHtml(code) });
    return ` CODEBLOCK${idx} `;
  });

  // Step 2: blocks (paragraphs, headings, lists, quotes)
  const blocks = md.split(/\n\n+/).map(processBlock).join('\n\n');

  // Step 3: re-inject code blocks
  return blocks.replace(/ CODEBLOCK(\d+) /g, (_, idx) => {
    const { lang, code } = codeBlocks[Number(idx)];
    return `<pre><code${lang ? ` class="language-${lang}"` : ''}>${code}</code></pre>`;
  });
}

function processBlock(block) {
  block = block.trim();
  if (!block) return '';

  // Heading.
  //
  // Bug fix 2026-05-08: a "block" can be a heading line followed by
  // paragraph text without an intervening blank line — that's invalid
  // markdown but llama-3.3-70b regularly produces it (e.g.
  // `## My Heading\nFirst paragraph...` inside a single \n\n-separated
  // chunk). The OLD logic blindly wrapped the WHOLE block in <h2>,
  // causing the entire paragraph to render as a heading (font-weight
  // 800, body color reused) — visible on the live blog as "the article
  // looks bold". Now we split on the first \n: line[0] is the heading,
  // remainder is recursively processed as its own paragraph block(s).
  for (const [prefix, tag] of [['### ', 'h3'], ['## ', 'h2'], ['# ', 'h1']]) {
    if (block.startsWith(prefix)) {
      const nlIdx = block.indexOf('\n');
      if (nlIdx === -1) {
        // Pure heading: one line, no trailing content.
        return `    <${tag}>${inline(block.slice(prefix.length))}</${tag}>`;
      }
      const heading = block.slice(prefix.length, nlIdx).trim();
      const rest = block.slice(nlIdx + 1).trim();
      // Recurse on the trailing content so it gets paragraph/list/etc.
      // wrapping. Re-split on \n\n in case the model jammed multiple
      // paragraphs into one heading-prefixed chunk too.
      const restRendered = rest
        .split(/\n\n+/)
        .map(processBlock)
        .filter(Boolean)
        .join('\n');
      return `    <${tag}>${inline(heading)}</${tag}>\n${restRendered}`;
    }
  }

  // Horizontal rule
  if (/^---+$/.test(block)) return '    <hr>';

  // Blockquote
  if (block.startsWith('> ')) {
    const lines = block.split('\n').map((l) => l.replace(/^> ?/, '')).join(' ');
    return `    <blockquote><p>${inline(lines)}</p></blockquote>`;
  }

  // Unordered list
  if (/^[-*]\s/.test(block)) {
    const items = block.split('\n').filter((l) => /^[-*]\s/.test(l));
    return `    <ul>\n${items.map((l) => `      <li>${inline(l.replace(/^[-*]\s/, ''))}</li>`).join('\n')}\n    </ul>`;
  }

  // Ordered list
  if (/^\d+\.\s/.test(block)) {
    const items = block.split('\n').filter((l) => /^\d+\.\s/.test(l));
    return `    <ol>\n${items.map((l) => `      <li>${inline(l.replace(/^\d+\.\s/, ''))}</li>`).join('\n')}\n    </ol>`;
  }

  // Codeblock placeholder pass-through (lone)
  if (/^ CODEBLOCK\d+ $/.test(block)) return block;

  // Default: paragraph
  return `    <p>${inline(block.replace(/\n/g, ' '))}</p>`;
}

/**
 * Outbound-domain whitelist. Mirrors AUTHORITATIVE_DOMAINS in
 * checks/eeat.mjs — kept as separate constant rather than imported to
 * avoid a circular-ish import (this file is plain renderer, eeat is a
 * gate). Update both lists together when adding a domain.
 *
 * Why filter at render time: even after PR #4's revision loop and the
 * SUGGESTED_URLS_BY_CATEGORY hint table in pipeline.mjs, llama-3.3-70b
 * still hallucinates outbound URLs to plausible-looking but non-existent
 * domains (observed 2026-05-08 first real article: rfc-spec.com,
 * esp-docs.com, industry-research.com — none real). The renderer is the
 * last gate before HTML lands in git, so we strip the broken links
 * here. The link TEXT is preserved as plain prose so the article still
 * reads coherently — it just stops linking to nowhere.
 */
const RENDERER_OUTBOUND_WHITELIST = [
  'rfc-editor.org',
  'datatracker.ietf.org',
  'w3.org',
  'mailgun.com',
  'postmarkapp.com',
  'sendgrid.com',
  'klaviyo.com',
  'mailchimp.com',
  'activecampaign.com',
  'developers.google.com',
  'support.google.com',
  'support.apple.com',
  'docs.microsoft.com',
  'learn.microsoft.com',
  'baymard.com',
  'litmus.com',
  'returnpath.com',
  'searchengineland.com',
  'searchengineroundtable.com',
  'martech.org',
  'gdpr.eu',
  'cookielaw.org',
  'similarweb.com',
  'statista.com',
];

/**
 * Domains we deliberately want to dilute SEO equity to. Direct
 * SwiftMail competitors — every <a> we ship to them passes link juice
 * (PageRank-like signal) that boosts THEIR ranking and proportionally
 * dings ours. So we keep them in the whitelist (the link is OK to
 * appear, especially in comparison/alternatives articles where the
 * reader expects it), but emit `rel="nofollow noopener"` to opt out
 * of the SEO contribution.
 *
 * Note that "transactional ESPs" (Postmark, Mailgun, SendGrid) are
 * NOT competitors — different category (developer-API for
 * transactional email), so those stay regular do-follow.
 */
const COMPETITOR_DOMAINS = [
  'klaviyo.com',
  'mailchimp.com',
  'activecampaign.com',
  'customer.io',
  'drip.com',
  'omnisend.com',
  'brevo.com',
  'mailerlite.com',
  'encharge.io',
  'bloomreach.com',
  'contentsquare.com',
  'hotjar.com',
  'mouseflow.com',
];

function isAuthoritativeOutbound(url) {
  if (!/^https?:\/\//i.test(url)) return true; // relative / mailto / etc — leave alone
  if (url.includes('swift-mail.app')) return true; // internal — always keep
  return RENDERER_OUTBOUND_WHITELIST.some((d) => url.includes(d));
}

function isCompetitorOutbound(url) {
  if (!/^https?:\/\//i.test(url)) return false;
  return COMPETITOR_DOMAINS.some((d) => url.includes(d));
}

function inline(text) {
  // First, escape HTML in plain text (but preserve our markers)
  text = escapeHtml(text);
  // Inline code (escape happens before; but we want to UN-double-escape in code)
  text = text.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic (only single asterisk not adjacent to alpha — minimal heuristic)
  text = text.replace(/\*([^*\s][^*]*[^*\s])\*/g, '<em>$1</em>');
  // Links — strip non-whitelisted outbound, keep link text as prose.
  // Competitor outbound gets `rel="nofollow noopener"` so we don't pass
  // SEO juice to direct competitors (klaviyo / mailchimp / etc) even
  // when they're legitimately referenced in comparison articles.
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, txt, href) => {
    if (!isAuthoritativeOutbound(href)) {
      // Hallucinated / dead link. Keep the visible text only.
      return txt;
    }
    let rel = '';
    if (href.startsWith('http') && !href.includes('swift-mail.app')) {
      rel = isCompetitorOutbound(href)
        ? ' rel="nofollow noopener" target="_blank"'
        : ' rel="noopener" target="_blank"';
    }
    return `<a href="${href}"${rel}>${txt}</a>`;
  });
  return text;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Helpers ──────────────────────────────────────────────────────────

function formatDate(iso, lang) {
  const d = new Date(iso);
  const localeMap = { en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', pt: 'pt-BR' };
  return d.toLocaleDateString(localeMap[lang] || 'en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function categoryToImage(category) {
  const map = {
    behavioral: 'behavioral-capture',
    deliverability: 'realtime-intervention',
    ecommerce: 'multichannel',
    comparison: 'integrations',
    strategy: 'inbox-preview',
  };
  return map[category] || 'inbox-preview';
}
