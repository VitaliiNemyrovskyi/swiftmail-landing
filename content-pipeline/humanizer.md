# Humanizer Skills

Universal rules for "doesn't read like generic AI". Applied alongside voice.md.
voice.md tells the LLM how SwiftMail sounds; humanizer.md tells it how to write
naturally regardless of brand.

## 1. Sentence-Length Variance

AI tendency: consistent 18–25 word sentences. Humans vary 5–40.

Force this distribution per article:
- ≥1 in 5 sentences under 8 words
- ≥1 in 10 sentences over 25 words
- 1–2 fragments per article (not more). Like this.

Sentence-variance score = standard-deviation of sentence-length / mean.
Target ≥ 0.4. AI typically scores 0.15–0.25. Humans 0.4–0.6.

## 2. Front-Loaded Specifics

AI: principle → example. Humans often: example → principle.

❌ "Many businesses see significant improvements when they..."
✅ "Bonobos abandoned 11K carts last Q4. Their flow missed three things:"

❌ "Pricing changes can affect customer lifetime value..."
✅ "Klaviyo raised prices 25% in May 2024. Average bill jumped from $400 to $500/mo. Migration searches spiked 8x within 30 days."

## 3. Mid-Thought Pivot / Self-Correction

AI is monotonously right. Humans change their minds mid-paragraph.

✅ "Most guides recommend daily emails. Skip that — outdated since iOS 15."
✅ "We thought engagement would dip. It didn't. The opposite happened."
✅ "I assumed bounce-rate spikes meant a list-quality problem. After three days of digging — it was DNS."

## 4. Anti-Templated Structure

AI: every article = intro → 5 H2s → conclusion. Humans vary.

Per-article structure should differ:
- Some: 7 short H2s
- Some: 2 long H2s with nested H3s
- Some: 1 H2 + a long-form story
- Some: pure listicle, no narrative
- Some: narrative with no list at all

Article 1 ≠ structure of article 2. **No template repetition across consecutive
articles.**

## 5. Voice / First-Person Markers

AI: third-person, generic. Humans: show their work.

✅ "I queried sessions where dwell_time > 90s AND no_purchase. 412 hits last week."
✅ "Our SwiftMail data shows 34% of abandonment is price-related — and that's after we filtered out coupon-hunters."
✅ "We migrated [Customer] last Tuesday. Took 47 minutes end-to-end. Here's where the time went:"

## 6. Concrete Time/Date Anchors

AI is timeless. Humans live in time.

✅ "Before Apple's MPP in 2021..."
✅ "Klaviyo's May 2024 pricing change..."
✅ "Last Tuesday I watched a customer's bounce rate climb from 1.2% to 8.7% in 4 hours."
✅ "When DMARC moved from quarantine to reject default..."

## 7. Surface-Level Tells (Banned)

These are the dead-giveaway phrases. Pure ban list:

| Banned phrase | Replace with |
|---|---|
| "delve into" | "look at" / "examine" |
| "tapestry" | nothing — just delete |
| "in today's fast-paced world" | a concrete year/event |
| "in conclusion" | quiet final sentence |
| "it's important to note" | just say the thing |
| "a wide variety of" | a number ("23 different") |
| "leverage" (verb) | "use" |
| "unleash" / "elevate" | concrete verb |
| "robust" / "seamless" / "cutting-edge" | concrete attribute |
| "navigate" (figurative) | "go through" / specific verb |
| "comprehensive solution" | what it actually does |
| "game-changer" | specific outcome |

## 8. Em-Dash Discipline

AI signature: 5+ em-dashes per article. Humans: 1–2 per article max.

Replace excess with:
- Commas (most cases)
- Parentheses (asides)
- New sentences (when interrupting your own point)

## 9. Imperfect Parallelism

AI loves perfect parallel lists: "Increase X. Reduce Y. Improve Z."
Humans break the pattern.

❌ "Increase open rates. Reduce bounce rates. Improve deliverability."
✅ "Open rates climbed 8%. Bounce rate finally dropped — took 6 weeks. Deliverability is its own story; we'll get there."

## 10. Bullet List Discipline

AI loves bullets. Humans use prose more.

Rule: max 1 bullet list per 600 words.

When a list of 3 items appears, convert to prose:
❌
- Set up SPF
- Configure DKIM
- Enable DMARC

✅ "Set up SPF first, then DKIM, then DMARC last (when you've watched 30 days of reports)."

## 11. Predictable Transitions (Limited Use)

Use these rarely:
- "Furthermore" — max 1 per article
- "Additionally" — max 1 per article
- "However" — max 2 per article
- "Moreover" — banned

Prefer:
- "Here's the catch:"
- "Compare:"
- "What this means is —"
- Start with "And" or "But"
- No transition; just next paragraph

## 12. Strategic Informalities

When tone allows:
- Contractions: don't, won't, it's, they're (avoid in technical sections)
- Sentence fragments: For emphasis. Sparingly.
- Parenthetical asides (with personality)
- Industry slang used naturally (not over-explained)

## 13. Sensory / Physical Language

Even in B2B technical content, use tactile verbs:
- "Email queue backs up"
- "Dashboard goes red"
- "Bounce rate creeping up"
- "Inbox fills with returns"

## 14. Embraced Contradictions

AI prefers clean assertions. Humans hold nuance.

✅ "It works. Mostly. The 20% where it doesn't is interesting because..."
✅ "Yes — but only if X. If not, do Y instead."
✅ "Counter-intuitive: more frequency *raised* engagement here. We didn't expect that."

## 15. Contrarian Devices (use 1 per article max)

These are signature human-writing moves. AI rarely produces these:

1. **Calling someone wrong** — "Most SaaS blogs recommend X. They're wrong here. Why:"
2. **Self-deprecation** — "We tried Y first. It failed. Here's what we learned."
3. **Unfinished thought as device** — "And about that 99% deliverability claim..." (next paragraph picks up)
4. **Sentence start with number** — "11 wasn't enough. We needed 14."
5. **Quote without lead-in** — Just drop a quote, attribute below.
6. **Outright disagreement with prior section** — section 3 contradicts section 2's hint.

## 16. Show Your Work

Demonstrate first-hand experience (EEAT critical for Google):
- "I queried our database for..."
- "We tested 3 variants over 48 hours..."
- "When we shipped this to 100 beta testers..."
- "We watched DKIM key rotation cause..."

## 17. Asymmetric Paragraph Lengths

AI tends 3–4 line paragraphs uniform. Humans vary.

Mix:
- 1-line paragraph for emphasis.
- 5–7 line paragraphs for explanation.
- Single-sentence answer to a posed question.

## 18. Cite Where Specific, Don't Where Generic

For specific facts/data: outbound citation to authoritative source.
For common knowledge: no citation.

Citation format: inline `[domain.com](https://...)` or footnote-style `¹`.
Cite 2–5 per article — too few = ungrounded; too many = research paper, not blog.

## 19. Internal Linking

Each article should link to **≥2 other SwiftMail blog posts** where relevant.
This builds topical authority and aids navigation.

## 20. Original Data Point per Article

Every article must contain **≥1 unique data point** — internal SwiftMail metric,
customer quote (anonymized), or original observation that exists nowhere else.

This is the #1 EEAT signal. Without it, the article is generic and Google demotes
even if every other rule is followed.
