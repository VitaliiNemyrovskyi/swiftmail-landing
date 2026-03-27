/* ═══════════════════════════════════════════════════════════
   Supabase Integration — Waitlist + Analytics
   Replace YOUR_SUPABASE_URL and YOUR_SUPABASE_ANON_KEY
   with your actual Supabase project credentials.
   ═══════════════════════════════════════════════════════════ */

const SUPABASE_URL = 'https://umglfmgfsmujggtcxrke.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_GRJDeE6pVPMa0Ic_pgHH7w_xPFu9Gk0';

let supabase = null;

// Initialize only if keys are configured
if (SUPABASE_URL !== 'YOUR_SUPABASE_URL' && typeof window.supabase !== 'undefined') {
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  console.log('[SwiftMail] Supabase connected');

  // Load real waitlist count on page load
  getWaitlistCount().then((count) => {
    document.querySelectorAll('.counter[data-target]').forEach((c) => {
      c.dataset.target = String(count);
      c.textContent = String(count);
    });
  });
} else {
  console.log('[SwiftMail] Supabase not configured — running in demo mode');
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
    // Unique constraint = already signed up
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

  const { count, error } = await supabase
    .from('waitlist_signups')
    .select('*', { count: 'exact', head: true });

  if (error) {
    console.error('[SwiftMail] Count error:', error);
    return 0;
  }

  return count || 0;
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
    // Non-critical, silently fail
    console.error('[SwiftMail] Page view tracking error:', err);
  }
}
