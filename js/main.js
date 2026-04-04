/* ═══════════════════════════════════════════════════════════
   SwiftMail Landing — Main JavaScript
   Scroll animations, FAQ, forms, counters
   ═══════════════════════════════════════════════════════════ */

document.addEventListener('DOMContentLoaded', () => {
  initScrollAnimations();
  initNavbar();
  initFAQ();
  initForms();
  initCounters();
  initLangSwitcher();
  trackPageView();
});

/* ── Scroll Animations (Intersection Observer) ─────────── */
function initScrollAnimations() {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -50px 0px' }
  );

  document.querySelectorAll('.animate-in').forEach((el) => observer.observe(el));
}

/* ── Navbar scroll effect ──────────────────────────────── */
function initNavbar() {
  const navbar = document.getElementById('navbar');
  const toggle = document.getElementById('nav-toggle');
  const links = document.getElementById('nav-links');

  window.addEventListener('scroll', () => {
    navbar.classList.toggle('scrolled', window.scrollY > 50);
  });

  if (toggle && links) {
    toggle.addEventListener('click', () => {
      links.classList.toggle('open');
    });

    // Close mobile nav on link click
    links.querySelectorAll('a').forEach((a) => {
      a.addEventListener('click', () => links.classList.remove('open'));
    });
  }
}

/* ── FAQ Accordion ─────────────────────────────────────── */
function initFAQ() {
  document.querySelectorAll('.faq-question').forEach((btn) => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.faq-item');
      const isOpen = item.classList.contains('open');

      // Close all
      document.querySelectorAll('.faq-item').forEach((i) => i.classList.remove('open'));

      // Toggle current
      if (!isOpen) {
        item.classList.add('open');
      }
    });
  });
}

/* ── Waitlist Forms ────────────────────────────────────── */
function initForms() {
  const forms = document.querySelectorAll('#waitlist-form-hero, #waitlist-form-footer');

  forms.forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = form.querySelector('input[type="email"]');
      const email = input.value.trim();

      if (!email || !isValidEmail(email)) {
        input.style.borderColor = '#ef4444';
        setTimeout(() => (input.style.borderColor = ''), 2000);
        return;
      }

      const btn = form.querySelector('button');
      const originalText = btn.textContent;
      btn.textContent = 'Joining...';
      btn.disabled = true;

      try {
        // Try Supabase first
        if (typeof submitWaitlist === 'function') {
          await submitWaitlist(email);
        }

        // Show success
        input.value = '';
        showToast();
        updateCounters(1);
      } catch (err) {
        console.error('Signup error:', err);
        // Still show success (email might already exist)
        showToast();
      } finally {
        btn.textContent = originalText;
        btn.disabled = false;
      }
    });
  });
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function showToast() {
  const toast = document.getElementById('toast');
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 4000);
}

/* ── Counter Animation ─────────────────────────────────── */
function initCounters() {
  const counters = document.querySelectorAll('.counter');

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting && !entry.target.dataset.animated) {
          entry.target.dataset.animated = 'true';
          animateCounter(entry.target);
        }
      });
    },
    { threshold: 0.5 }
  );

  counters.forEach((c) => observer.observe(c));
}

function animateCounter(el) {
  const target = parseInt(el.dataset.target, 10);
  if (isNaN(target)) return;

  const duration = 1500;
  const start = performance.now();

  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    // Ease out cubic
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(eased * target);

    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }

  requestAnimationFrame(update);
}

function updateCounters(increment) {
  document.querySelectorAll('.counter').forEach((c) => {
    const current = parseInt(c.textContent, 10) || 0;
    c.textContent = current + increment;
    c.dataset.target = String(current + increment);
  });
}

/* ── Mouse Parallax (GPU-optimized) ────────────────────── */
function initParallax() {
  // Only on desktop — skip on touch devices
  if (window.matchMedia('(pointer: coarse)').matches) return;

  const hero = document.getElementById('hero');
  if (!hero) return;

  const shapes = hero.querySelector('.hero-shapes');
  const orbs = hero.querySelector('.hero-orbs');

  let mouseX = 0, mouseY = 0;
  let currentX = 0, currentY = 0;
  let rafId = null;

  document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 2;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 2;

    if (!rafId) {
      rafId = requestAnimationFrame(updateParallax);
    }
  });

  function updateParallax() {
    // Lerp for smooth movement
    currentX += (mouseX - currentX) * 0.08;
    currentY += (mouseY - currentY) * 0.08;

    if (shapes) {
      shapes.style.transform = `translate3d(${currentX * 15}px, ${currentY * 10}px, 0)`;
    }
    if (orbs) {
      orbs.style.transform = `translate3d(${currentX * -8}px, ${currentY * -6}px, 0)`;
    }

    // Keep animating if mouse is still moving
    if (Math.abs(mouseX - currentX) > 0.001 || Math.abs(mouseY - currentY) > 0.001) {
      rafId = requestAnimationFrame(updateParallax);
    } else {
      rafId = null;
    }
  }
}

/* ── UTM Extraction ────────────────────────────────────── */
function getUTMParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    utm_source: params.get('utm_source') || null,
    utm_medium: params.get('utm_medium') || null,
    utm_campaign: params.get('utm_campaign') || null,
  };
}

/* ── Language Switcher ─────────────────────────────────── */
function initLangSwitcher() {
  const switcher = document.getElementById('lang-switcher');
  if (!switcher) return;
  const btn = switcher.querySelector('.lang-btn');
  btn.addEventListener('click', function(e) {
    e.stopPropagation();
    switcher.classList.toggle('open');
  });
  document.addEventListener('click', function() {
    switcher.classList.remove('open');
  });
}

/* ── Page View Tracking ────────────────────────────────── */
function trackPageView() {
  if (typeof trackPageViewToSupabase === 'function') {
    trackPageViewToSupabase();
  }
}
