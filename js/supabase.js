/* ═══════════════════════════════════════════════════════════
   Supabase Integration — Waitlist + Analytics (no SDK, pure fetch)
   ═══════════════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://umglfmgfsmujggtcxrke.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GRJDeE6pVPMa0Ic_pgHH7w_xPFu9Gk0';

const headers = {
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': 'Bearer ' + SUPABASE_ANON_KEY,
  'Content-Type': 'application/json',
  'Prefer': 'return=minimal'
};

// Load waitlist count on init
getWaitlistCount().then(function(count) {
  document.querySelectorAll('.waitlist-count').forEach(function(c) {
    c.textContent = String(count);
  });
  document.querySelectorAll('.spots-remaining').forEach(function(el) {
    el.textContent = String(Math.max(0, 500 - count));
  });
});

// Track page view
trackPageViewToSupabase();

/**
 * Submit email to waitlist
 */
async function submitWaitlist(email) {
  var utmParams = getUTMParams();

  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/waitlist_signups', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        email: email,
        utm_source: utmParams.utm_source || null,
        utm_medium: utmParams.utm_medium || null,
        utm_campaign: utmParams.utm_campaign || null,
        referrer: document.referrer || null
      })
    });

    if (!res.ok) {
      var err = await res.json().catch(function() { return {}; });
      if (err.code === '23505') return; // duplicate
      throw new Error(err.message || 'Submit failed');
    }
  } catch (e) {
    console.error('[SwiftMail] Waitlist error:', e);
  }
}

/**
 * Get total waitlist count
 */
async function getWaitlistCount() {
  try {
    var res = await fetch(SUPABASE_URL + '/rest/v1/waitlist_signups?select=id', {
      headers: { 'apikey': SUPABASE_ANON_KEY, 'Authorization': 'Bearer ' + SUPABASE_ANON_KEY }
    });
    if (!res.ok) return 0;
    var data = await res.json();
    return data ? data.length : 0;
  } catch (e) {
    return 0;
  }
}

/**
 * Track anonymous page view
 */
async function trackPageViewToSupabase() {
  var utmParams = getUTMParams();

  try {
    fetch(SUPABASE_URL + '/rest/v1/page_views', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        path: window.location.pathname,
        referrer: document.referrer || null,
        utm_source: utmParams.utm_source || null,
        user_agent: navigator.userAgent.substring(0, 500)
      })
    });
  } catch (e) {}
}
