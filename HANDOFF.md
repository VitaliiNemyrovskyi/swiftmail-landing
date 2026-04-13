# Session Handoff

> This file helps maintain context between Claude Code sessions.
> Last updated: 2026-04-13

## What was done this session
- Analyzed full project structure (SwiftMail landing page)
- Added favicon.ico (multi-size: 16-256px), apple-touch-icon.png (180px), favicon-192.png (192px)
- Added `<link>` tags to all 29 HTML files
- Favicon generated from logo-orange.svg via resvg → Pillow, fills 100% width
- Created PR #1, merged to main
- Note: Social Proof section was removed from all HTML + CSS (done in previous session, merged with this PR)

## Current state
- Branch: `main` (up to date)
- Deployed via Cloudflare Pages (auto-deploy on push to main)
- gh CLI on this machine is broken npm version (v2.8.9) — use GitHub REST API with curl instead

## What's next
- Nothing pending — waiting for user direction

## Gotchas
- Supabase anon key is in public JS — RLS must be configured server-side
- `getWaitlistCount()` fetches all rows and counts `.length` — will be slow at scale
- `trackPageViewToSupabase()` is called twice (supabase.js + main.js)
- `initParallax()` is defined but never called
