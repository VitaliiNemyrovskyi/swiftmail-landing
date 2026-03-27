/* ═══════════════════════════════════════════════════════════
   Supabase Integration — Waitlist + Analytics
   ═══════════════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://umglfmgfsmujggtcxrke.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GRJDeE6pVPMa0Ic_pgHH7w_xPFu9Gk0';

let supabase = null;

// Initialize Supabase client
try {
  const sb = window.supabase;
  if (sb && sb.createClient) {
    supabase = sb.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
} catch (e) {
  console.error('[SwiftMail] Supabase init error:', e);
}

if (supabase) {
  console.log('[SwiftMail] Supabase connected');

  // Load real waitlist count on page load
  getWaitlistCount().then((count) => {
    document.querySelectorAll('.counter').forEach((c) => {
      c.dataset.target = String(count);
      c.textContent = String(count);
    });
    document.querySelectorAll('.spots-remaining').forEach((el) => {
      el.textContent = String(Math.max(0, 500 - count));
    });
  });
} else {
  console.log('[SwiftMail] Supabase not loaded — running in demo mode');
}

/**
 * Submit email to waitlist
 */
async function submitWaitlist(email) {
  if (!supabase) {
    console.log('[Demo] Waitlist signup:', email);
    return;
  }

  const utmParams = getUTMParams();

  const { error } = await supabase.from('waitlist_signups').insert({
    email,
    utm_source: utmParams.utm_source,
    utm_medium: utmParams.utm_medium,
    utm_campaign: utmParams.utm_campaign,
    referrer: document.referrer || null,
  });

  if (error) {
    if (error.code === '23505') {
      console.log('[SwiftMail] Email already on waitlist');
      return;
    }
    throw error;
  }

  console.log('[SwiftMail] Waitlist signup successful:', email);
}

/**
 * Get total waitlist count
 */
async function getWaitlistCount() {
  if (!supabase) return 0;

  try {
    const { data, error } = await supabase
      .from('waitlist_signups')
      .select('id');

    if (error) {
      console.error('[SwiftMail] Count error:', error);
      return 0;
    }

    console.log('[SwiftMail] Waitlist count:', data.length);
    return data ? data.length : 0;
  } catch (err) {
    console.error('[SwiftMail] Count fetch failed:', err);
    return 0;
  }
}

/**
 * Track anonymous page view
 */
async function trackPageViewToSupabase() {
  if (!supabase) return;

  const utmParams = getUTMParams();

  try {
    await supabase.from('page_views').insert({
      path: window.location.pathname,
      referrer: document.referrer || null,
      utm_source: utmParams.utm_source,
      user_agent: navigator.userAgent.substring(0, 500),
    });
  } catch (err) {
    console.error('[SwiftMail] Page view tracking error:', err);
  }
}
