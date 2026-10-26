// Shared per-tenant branding for every public page a customer or referred
// friend sees: the customer share page, the lead page, and the privacy
// and terms pages they link to. These pages used to hardcode Good Steward
// Structures' name, colors and logo, so every tenant's customers saw GSS.
// Now each page starts hidden (html.branding-pending), looks up the link
// code it was opened with, and re-skins itself from that tenant's own
// row: tenants.name, tenants.branding and tenants.reward_amount_cents, all
// already returned by the public GET /api/links/:code endpoint.
//
// Branding keys read (all optional; missing ones fall back to 50.'s own
// neutral look): primaryColor, primaryDark, secondary, accentColor,
// accentDark, bg, taglineColor, logoUrl, contactEmail.
(function(){
  var DEFAULT = {
    name: "50.",
    colors: {
      primary: "#1C2B33",
      primaryDark: "#33475A",
      secondary: "#7C9FBB",
      accent: "#C9974B",
      accentDark: "#8B6B2E",
      bg: "#F7F4EE"
    },
    logoUrl: "assets/50-platform-logo.png",
    rewardAmountCents: 5000,
    rewardCurrency: "USD",
    contactEmail: null,
    copy: null // filled in just below, once DEFAULT_COPY is defined
  };

  // Industry wording shown to customers and referred friends. Every key can
  // be overridden per tenant in tenants.branding.copy (strings only; {reward}
  // and {name} are filled in; **bold** is honored in the invite email). The
  // defaults below are the original shed-dealer wording, so a tenant that sets
  // nothing looks exactly as it always did.
  var DEFAULT_COPY = {
    offerHow: "Here's how it works: Buy a shed from us and receive your own referral link to share. When your friend buys a building through that link, you each receive a {reward} Amazon E-Gift Card.",
    shareButton: "Share My Referral Link",
    friendGreeting: "Hey, it's {referrer}.",
    friendPitch: "I had a great experience with {name} and thought of you. Fill out the form below, and if you end up buying something, we'll each get a {reward} {card}!",
    leadButton: "Get my {reward} offer",
    leadPrompt: "What are you thinking about?",
    leadPlaceholder: "A rough idea is plenty.",
    responseNote: "{name} will reach out within one business day. Gift cards are sent after your purchase.",
    shareTitle: "Get {reward} when you make a purchase from {name}",
    shareText: "I referred you \u2014 make your purchase through my link and we both get {reward}.",
    afterPurchase: "made your purchase",
    eligibility: "have placed an order with us",
    qualifyingEvent: "places and completes an order for a building",
    rewardCondition: "confirms the referred order has actually been placed and a qualifying deposit received. Cancelled, refunded, or unfulfilled orders do not qualify for a reward.",
    inquiryNoun: "building inquiry",
    // mergeCopy only keeps keys that exist here, so a key missing from this
    // object is silently dropped from every tenant's wording. cardNoun was
    // added to fill() without being added here, which meant a dealer who
    // mails physical cards still had "electronic gift card" on their
    // customers' pages while the wizard showed their chosen wording.
    cardNoun: "electronic gift card"
  };
  DEFAULT.copy = DEFAULT_COPY;

  var current = DEFAULT;
  // The first name of the person who shared the link. Null until the lead
  // page resolves the code, so {referrer} falls back to "a friend" rather
  // than printing a raw token at someone.
  var referrerFirstName = null;

  function formatAmount(cents, currency){
    var whole = cents % 100 === 0;
    var n = whole ? String(cents / 100) : (cents / 100).toFixed(2);
    return (currency || "USD").toUpperCase() === "USD" ? "$" + n : n + " " + currency;
  }

  function mergeCopy(over){
    var out = {};
    Object.keys(DEFAULT_COPY).forEach(function(k){
      out[k] = (over && typeof over[k] === 'string' && over[k].trim()) ? over[k].trim() : DEFAULT_COPY[k];
    });
    return out;
  }

  function fromLinkTenant(tenant){
    var t = (tenant && tenant.branding) || {};
    var d = DEFAULT.colors;
    return {
      name: (tenant && tenant.name) || DEFAULT.name,
      colors: {
        primary: t.primaryColor || d.primary,
        primaryDark: t.primaryDark || d.primaryDark,
        secondary: t.secondary || d.secondary,
        accent: t.accentColor || d.accent,
        accentDark: t.accentDark || d.accentDark,
        bg: t.bg || d.bg,
        // No default: unset means the tagline keeps following the accent, which
        // is how every page already looked.
        tagline: t.taglineColor || null
      },
      logoUrl: t.logoUrl || DEFAULT.logoUrl,
      rewardAmountCents: (tenant && tenant.reward_amount_cents) || DEFAULT.rewardAmountCents,
      rewardCurrency: (tenant && tenant.reward_currency) || DEFAULT.rewardCurrency,
      contactEmail: t.contactEmail || null,
      copy: mergeCopy(t.copy)
    };
  }

  function fill(text, b){
    return String(text)
      .replace(/\*\*/g, '')
      .replace(/\{reward\}/g, formatAmount(b.rewardAmountCents, b.rewardCurrency))
      .replace(/\{name\}/g, b.name)
      // Whatever this dealer calls their gift card. Falls back to the
      // wording the pages ship with rather than leaving a raw token on a
      // customer's screen.
      .replace(/\{card\}/g, (b.copy && b.copy.cardNoun) || 'electronic gift card')
      .replace(/\{referrer\}/g, referrerFirstName || 'a friend');
  }

  function apply(b){
    current = b;
    var r = document.documentElement.style;
    r.setProperty('--primary', b.colors.primary);
    r.setProperty('--primary-dark', b.colors.primaryDark);
    r.setProperty('--secondary', b.colors.secondary);
    r.setProperty('--accent', b.colors.accent);
    r.setProperty('--accent-dark', b.colors.accentDark);
    r.setProperty('--bg', b.colors.bg);
    if(b.colors.tagline) r.setProperty('--tagline', b.colors.tagline);
    document.querySelectorAll('[data-tenant-logo]').forEach(function(el){
      // A broken image icon is never what anyone wants on a page a customer
      // has been emailed a link to. If the logo will not load -- a URL that
      // 404s, a dealer with none set and a fallback that does not resolve from
      // this path -- the image is removed and the wordmark below it carries the
      // branding on its own, which is how the page looks for a dealer who never
      // had a logo at all.
      // Both handlers, not just the failure one. apply() can run more than
      // once -- the neutral default first, then the tenant's own logo once the
      // link resolves -- and hiding on the first failure without un-hiding on a
      // later success leaves a perfectly good logo invisible. That is worse
      // than the broken icon this was written to prevent.
      el.onerror = function(){ el.style.display = 'none'; };
      el.onload  = function(){ el.style.display = ''; };
      el.alt = b.name;
      el.src = b.logoUrl;
    });
    document.querySelectorAll('[data-tenant-name],[data-tenant-name-inline]').forEach(function(el){ el.textContent = b.name; });
    document.querySelectorAll('[data-copy]').forEach(function(el){
      var key = el.getAttribute('data-copy');
      var text = b.copy && b.copy[key];
      if(text) el.textContent = fill(text, b);
    });
    // Same wording system, but into the placeholder attribute rather than
    // the element's text.
    document.querySelectorAll('[data-copy-placeholder]').forEach(function(el){
      var key = el.getAttribute('data-copy-placeholder');
      var text = b.copy && b.copy[key];
      if(text) el.setAttribute('placeholder', fill(text, b));
    });
    var amount = formatAmount(b.rewardAmountCents, b.rewardCurrency);
    document.querySelectorAll('[data-reward-amount]').forEach(function(el){ el.textContent = amount; });
    document.querySelectorAll('[data-contact-email]').forEach(function(el){
      if(b.contactEmail){
        el.textContent = b.contactEmail;
        el.href = 'mailto:' + b.contactEmail;
      }
    });
    // A tenant with no contact email set hides the whole "Questions?" line
    // rather than showing another business's address.
    document.querySelectorAll('[data-contact-line]').forEach(function(el){
      el.style.display = b.contactEmail ? '' : 'none';
    });
  }

  function reveal(){ document.documentElement.classList.remove('branding-pending'); }

  // Never leave a page blank: if the lookup hangs, show it with whatever
  // branding is applied by then.
  setTimeout(reveal, 4000);

  window.TenantBranding = {
    // Told by the lead page once it knows who shared the link. Re-applies,
    // because the copy carrying {referrer} was already written to the page
    // with the fallback in it.
    setReferrer: function(firstName){
      referrerFirstName = (firstName && String(firstName).trim()) || null;
      apply(current);
    },
    // Call with the JSON from GET /api/links/:code (or null if the code
    // didn't resolve — the page then shows 50.'s neutral look, never
    // another tenant's).
    applyFromLink: function(link){
      apply(link && link.tenant ? fromLinkTenant(link.tenant) : DEFAULT);
      reveal();
    },
    // For pages that only need the branding (privacy, terms): looks the
    // code up itself.
    loadForCode: function(apiBase, code){
      if(!code){ TenantBranding.applyFromLink(null); return Promise.resolve(null); }
      return fetch(apiBase + '/links/' + encodeURIComponent(code))
        .then(function(res){ return res.ok ? res.json() : null; })
        .catch(function(){ return null; })
        .then(function(link){ TenantBranding.applyFromLink(link); return link; });
    },
    name: function(){ return current.name; },
    copy: function(key){ return fill(current.copy[key], current); },
    rewardText: function(){ return formatAmount(current.rewardAmountCents, current.rewardCurrency); }
  };

  apply(DEFAULT);
})();
