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
// accentDark, bg, logoUrl, contactEmail.
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
    contactEmail: null
  };

  var current = DEFAULT;

  function formatAmount(cents, currency){
    var whole = cents % 100 === 0;
    var n = whole ? String(cents / 100) : (cents / 100).toFixed(2);
    return (currency || "USD").toUpperCase() === "USD" ? "$" + n : n + " " + currency;
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
        bg: t.bg || d.bg
      },
      logoUrl: t.logoUrl || DEFAULT.logoUrl,
      rewardAmountCents: (tenant && tenant.reward_amount_cents) || DEFAULT.rewardAmountCents,
      rewardCurrency: (tenant && tenant.reward_currency) || DEFAULT.rewardCurrency,
      contactEmail: t.contactEmail || null
    };
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
    document.querySelectorAll('[data-tenant-logo]').forEach(function(el){ el.src = b.logoUrl; el.alt = b.name; });
    document.querySelectorAll('[data-tenant-name],[data-tenant-name-inline]').forEach(function(el){ el.textContent = b.name; });
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
    rewardText: function(){ return formatAmount(current.rewardAmountCents, current.rewardCurrency); }
  };

  apply(DEFAULT);
})();
