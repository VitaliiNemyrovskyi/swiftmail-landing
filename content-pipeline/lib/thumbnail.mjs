// Generate unique gradient + icon thumbnails for blog grid cards.
// Replaces image reuse (9 base photos on 19 articles → adjacent duplicates).
//
// Each thumbnail = CSS-driven gradient with category-base hue + per-slug
// hash offset, plus inline SVG icon. Pure HTML+CSS, no external HTTP,
// guaranteed unique appearance per slug.

/**
 * Hash a slug to a stable hue offset in [0, 360).
 */
function slugHash(slug) {
  let h = 0;
  for (let i = 0; i < slug.length; i++) {
    h = ((h << 5) - h) + slug.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h) % 360;
}

const CATEGORY_BASE_HUE = {
  behavioral: 30,        // warm orange
  comparison: 200,       // cyan
  deliverability: 260,   // purple
  ecommerce: 350,        // red-pink
  strategy: 140,         // green
};

// Inline SVG icons per category (24x24 viewBox)
const ICONS = {
  behavioral: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 5-5"/></svg>`,
  comparison: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M5 8l7-2 7 2M5 8a3 3 0 0 0 6 0M19 8a3 3 0 0 0-6 0"/></svg>`,
  deliverability: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>`,
  ecommerce: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 6h14l-1.5 9.5a2 2 0 0 1-2 1.5h-7a2 2 0 0 1-2-1.5L5 6Z"/><path d="M9 6V4a3 3 0 0 1 6 0v2"/><circle cx="9" cy="20" r="1"/><circle cx="15" cy="20" r="1"/></svg>`,
  strategy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a7 7 0 0 0-4 12.7V17a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2v-2.3A7 7 0 0 0 12 2Z"/><path d="M9 22h6"/></svg>`,
};

/**
 * Build the inline HTML for a blog-card-thumb.
 * @param {string} slug
 * @param {string} category
 * @param {string} alt - accessible alt text
 * @returns {string}
 */
export function thumbHtml(slug, category, alt) {
  const baseHue = CATEGORY_BASE_HUE[category] ?? 220;
  // Per-slug offset of ±25deg keeps within-category variety
  const offset = (slugHash(slug) % 50) - 25;
  const hue = (baseHue + offset + 360) % 360;
  const icon = ICONS[category] || ICONS.strategy;

  return `<div class="blog-card-thumb" style="--hue: ${hue};" role="img" aria-label="${escapeHtmlAttr(alt)}">
            <span class="blog-card-icon" aria-hidden="true">${icon}</span>
          </div>`;
}

/**
 * CSS to drop into the blog index <style> block.
 * Renders the gradient + dot-pattern overlay + icon styling.
 */
export const thumbCss = `
    /* Gradient blog-card thumbs (per-slug hue from inline --hue) */
    .blog-card-thumb {
      position: relative; aspect-ratio: 16/10; overflow: hidden;
      display: flex; align-items: center; justify-content: center;
      background:
        radial-gradient(circle at 30% 20%, hsl(var(--hue, 220), 75%, 55%) 0%, transparent 60%),
        linear-gradient(135deg, hsl(var(--hue, 220), 65%, 24%) 0%, hsl(calc(var(--hue, 220) + 25), 70%, 38%) 100%);
      transition: transform 0.4s ease;
    }
    .blog-card-thumb::before {
      /* Subtle dot-grid texture overlay */
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background-image: radial-gradient(rgba(255,255,255,0.10) 1px, transparent 1px);
      background-size: 22px 22px;
      mask-image: radial-gradient(ellipse 80% 70% at 50% 50%, black 0%, transparent 90%);
      -webkit-mask-image: radial-gradient(ellipse 80% 70% at 50% 50%, black 0%, transparent 90%);
    }
    .blog-card-thumb::after {
      /* Diagonal sheen */
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(135deg, rgba(255,255,255,0.12) 0%, transparent 50%);
    }
    .blog-card:hover .blog-card-thumb { transform: scale(1.02); }
    .blog-card-icon {
      position: relative; z-index: 1;
      width: 64px; height: 64px;
      color: rgba(255,255,255,0.92);
      filter: drop-shadow(0 2px 8px rgba(0,0,0,0.25));
    }
    .blog-card-icon svg { width: 100%; height: 100%; }
`;

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
