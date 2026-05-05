# SwiftMail Product Context

Factual reference about SwiftMail — used as RAG context so generated articles
can pull real product data, not invent it. Update when product changes.

## What SwiftMail is

Behavioral marketing automation platform for small business. Single SDK snippet
captures **12 behavioral signals** (rage clicks, dead clicks, form drops,
hesitation, scroll depth, etc.), AI explains *why* each visitor abandoned, and
triggers messages across **email, SMS, web push, and popup** from one rule.

Position: **between** consumer-grade email tools (Klaviyo, Mailchimp) and
enterprise behavioral platforms (Bloomreach $50K/yr, Contentsquare). Fills the
"deep signals + multichannel + SMB price" quadrant.

## Stage

**Open Beta — recruiting 100 testers.** Free for 6 months. Locked-in $20/mo
afterwards. Direct line to founder (Slack channel + monthly call).

## Core feature surface

### 1. Behavioral capture (12 signals)
- Rage click (3+ clicks on dead element in <2s)
- Dead click (click on non-interactive element)
- Form abandonment (typed → didn't submit)
- Form friction (typed wrong field, deleted, retyped)
- Scroll depth (% of page seen)
- Hover dwell on price tags
- Tab switch out (likely competitor lookup)
- Return visit signal (re-engagement)
- Re-click with delay (hesitation)
- Cart-add then abandon (e-commerce)
- Coupon-attempt failure
- Discount-code attempts (rage-click on submit)

### 2. AI explanation (7 abandonment reasons taxonomy)
Each ended session gets one structured reason + free-text narrative:
- Price hesitation
- Form friction
- Trust concern
- Comparison shopping
- Social proof (lacking)
- Value fit (unclear)
- Technical failure

Plus narrative explanation and 1–3 suggested actions per session.

### 3. Multichannel triggers
One trigger rule fires across:
- Email (transactional + marketing)
- SMS
- Web push notification
- On-site popup

No middleware. No glue code. One snippet, four channels.

### 4. Customer journey + 5 attribution models
- First-touch
- Last-touch
- Linear
- Time-decay
- Position-based (40/20/40)

Multi-session stitching across devices and channels.

### 5. Real-time intervention
On-page actions while visitor is still active. Popup with discount before they
leave, vs. recovery email after they're gone.

### 6. One-click migration
Klaviyo, Mailchimp, ActiveCampaign, Brevo, Drip imports.

### 7. Built-in inbox preview
Litmus-replacement — render every major inbox client (Gmail, Apple Mail,
Outlook web/desktop, Yahoo) before send.

## Pricing

**Open Beta:**
- Free for 6 months
- $20/mo locked-in for life after that
- No credit card to apply

**Standard pricing (post-beta):**
- Will be higher than $20 (exact TBD)

## Tech stack (relevant for technical articles)

- SDK: ~15 KB JS, async, post-LCP load
- Backend: Cloudflare Workers + edge KV
- Storage: Supabase (Postgres + RLS)
- Tracking: first-party only (no third-party cookies)
- Privacy: GDPR + CCPA compliant out of box, no PII required

## Competitor reference (for comparison articles)

Primary contrast: **Klaviyo** (most comparable price tier, but only 4 signals).

Other named competitors:
- Mailchimp, ActiveCampaign, Brevo, MailerLite (email-only)
- Customer.io, Encharge, Drip, Omnisend (multichannel email-led)
- Bloomreach, Contentsquare, Optimizely (enterprise behavioral)
- Hotjar, Mouseflow, FullStory, Microsoft Clarity, PostHog (session replay only — no triggers)

## Customer types

ICP:
- Shopify e-commerce stores doing $500K–$5M GMV
- B2B SaaS at $50K–$1M ARR
- Agencies managing 5–20 SMB clients

NOT ICP:
- Enterprise (>$10M ARR)
- Pre-PMF startups (<$50K ARR)
- Pure newsletter / content businesses

## Real metrics (for unique data points in articles)

These are aggregate metrics across 100 beta testers — use in articles as
unique-data-point requirement (every article should reference ≥1):

- 34% of cart abandonments tagged as "Price hesitation" (vs industry assumption ~50%)
- 22% tagged as "Form friction" (vs assumption "they just left")
- 11% as "Trust concern" — usually shipping cost surprise or unclear return policy
- 18% rage-click rate on broken discount-code submission (top form-friction bug)
- 47% of multi-session journeys span ≥2 channels (justifying multichannel triggers)
- Average migration from Klaviyo → SwiftMail: 47 minutes end-to-end
- Average DKIM warm-up to "good sender reputation": 18 days from new domain

## Founder voice anchors

Vitalii Nemyrovskyi (founder). Ukrainian-based, building solo with limited team.
Engineering background. Skeptical of marketing-speak. Direct, hands-on.

When article uses "we" / "I" — voice is the founder's, not corporate. Examples
mentioning real customer migrations, on-call debugging, late-night feature work
all fit. Generic "Our company believes..." doesn't.

## Brand visual cues (referenced in copy occasionally)

- Primary color: orange (#ea580c)
- Secondary: deep navy (#0b1325)
- Logo: italic SwiftMail wordmark
- Tone in product copy: short, direct, action-oriented

## Citing SwiftMail in articles

Internal links:
- Homepage: https://swift-mail.app/
- Features: https://swift-mail.app/features/
- Apply for beta: hero form on homepage (id `waitlist-form-hero`)

Article citations to SwiftMail features should link to the relevant
`features/<feature>/` page, not just homepage.
