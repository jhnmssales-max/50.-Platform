// The sentences a dealer's own customers read, and the trade-neutral wording
// used wherever a dealer has not written their own.
//
// Where these end up: a rep collects them on the lead (rep_leads.copy), the
// build screen shows them again, and approving a build writes them into that
// dealer's tenants.branding.copy. From there every public page reads them
// through tenant-branding.js's `copy()` and the invite email through its own
// `offerHow` argument. One list, one place to add a key.
//
// Why GENERIC and not the shed wording: tenant-branding.js's DEFAULT_COPY is
// still the original shed-dealer wording, and it has to stay that way — the
// tenants that predate this (Good Steward, North Mountain) render from it and
// changing it would silently rewrite their live pages. But a roofing company
// must never inherit "Buy a shed from us", so a NEW dealer's blanks are filled
// from GENERIC_COPY below rather than left to fall through to DEFAULT_COPY.
//
// {reward} is replaced with that dealer's card amount, {name} with their
// business name, and {card} with whatever they call their gift card
// (cardNoun), wherever those appear. {card} exists so the offer line does not
// promise an emailed Amazon card to a dealer who posts real ones -- the
// default used to say exactly that. **bold** is honored in the invite
// email only.

// Ordered as the rep meets them, which is also how the reps page groups them.
// `where` is shown under the field on that page — keep it plain, it is read by
// someone sitting across from a business owner.
const COPY_FIELDS = [
  {
    key: 'offerHow',
    stage: 'The invite email, and their share page',
    label: 'How the program works, in one or two sentences',
    where: 'The main offer line, the first thing a past customer reads. **stars** bold a phrase in the email.',
    max: 600,
    multiline: true,
  },
  {
    key: 'inviteSubject',
    stage: 'The invite email',
    label: 'Subject line',
    where: 'The only thing most people read. {name} is the company, {reward} the amount.',
    max: 150,
  },
  {
    key: 'inviteOpening',
    stage: 'The invite email',
    label: 'Opening line',
    where: 'The first thing after \u201cHi Dana\u201d. Thank them for the purchase they just made.',
    max: 400,
    multiline: true,
  },
  {
    key: 'inviteHowItWorks',
    stage: 'The invite email',
    label: 'How it works (optional)',
    where: 'What happens after they share. Left out of the email entirely when blank.',
    max: 700,
    multiline: true,
  },
  {
    key: 'inviteAfterLink',
    stage: 'The invite email',
    label: 'Under the link (optional)',
    where: 'A nudge about where to share it. Left out when blank.',
    max: 300,
  },
  {
    key: 'inviteClosing',
    stage: 'The invite email',
    label: 'Closing line',
    where: 'The last line before any signature.',
    max: 400,
    multiline: true,
  },
  {
    key: 'inviteSignature',
    stage: 'The invite email',
    label: 'Signature (optional)',
    where: 'A real person\u2019s name and the company, on their own lines. Left out when blank.',
    max: 200,
    multiline: true,
  },
  {
    key: 'inviteDisclaimer',
    stage: 'The invite email',
    label: 'Small print (optional)',
    where: 'Conditions on the reward, under the signature. Left out when blank.',
    max: 400,
    multiline: true,
  },
  {
    key: 'friendGreeting',
    stage: 'The page a referred friend lands on',
    label: 'How the referrer opens',
    where: 'First line of the landing page, in the referrer\u2019s own voice. {referrer} is their first name.',
    max: 120,
  },
  {
    key: 'friendPitch',
    stage: 'The page a referred friend lands on',
    label: 'What the referrer says about the business',
    where: 'The recommendation itself, written as the friend speaking. Name what the business actually sells. {name} is the company, {reward} the amount, {card} what you call the card.',
    max: 600,
    multiline: true,
  },
  {
    key: 'leadButton',
    stage: 'The page a referred friend lands on',
    label: 'The button that submits the form',
    where: 'The conversion point. {reward} is the amount.',
    max: 80,
  },
  {
    key: 'leadPrompt',
    stage: 'The page a referred friend lands on',
    label: 'The question above the message box',
    where: 'Asks what they are after. Short and conversational beats formal.',
    max: 120,
  },
  {
    key: 'leadPlaceholder',
    stage: 'The page a referred friend lands on',
    label: 'The grey example inside the message box',
    where: 'Concrete examples of what people ask for, so the box does not look like homework.',
    max: 200,
  },
  {
    key: 'responseNote',
    stage: 'The page a referred friend lands on',
    label: 'The reassurance under the button',
    where: 'When they will hear back, and when the card arrives. {name} is the company.',
    max: 300,
  },
  {
    key: 'rewardNoteReferrer',
    stage: 'The "send the gift cards" alert',
    label: 'What to say to the customer who referred someone',
    where: 'Printed in the alert email, ready to copy into the gift card or an email. {name} is their first name, {reward} the amount, {card} what you call the card, {business} the company.',
    max: 600,
    multiline: true,
  },
  {
    key: 'rewardNoteFriend',
    stage: 'The "send the gift cards" alert',
    label: 'What to say to the friend who bought',
    where: 'The same, for the person who was referred in and placed the order. Same tokens.',
    max: 600,
    multiline: true,
  },
  {
    key: 'shareButton',
    stage: 'The invite email, and their share page',
    label: 'The button a customer presses to share their link',
    where: 'The main call to action, on the page and in the email. Keep it short — it is a button.',
    max: 80,
  },
  {
    key: 'cardNoun',
    stage: 'The invite email, and their share page',
    label: 'What the gift card is called',
    where: 'Used wherever the reward is named, right after the amount. Change it for a business that mails real cards rather than emailing them.',
    max: 60,
  },
  {
    key: 'shareTitle',
    stage: 'The invite email, and their share page',
    label: 'Title when a customer shares their link',
    where: 'What shows as the heading on a phone’s share sheet.',
    max: 200,
  },
  {
    key: 'shareText',
    stage: 'The invite email, and their share page',
    label: 'Message the share sheet fills in',
    where: 'The text their customer sends to a friend, before they edit it.',
    max: 400,
    multiline: true,
  },
  {
    key: 'friendAction',
    stage: 'The page a referred friend lands on',
    label: 'What the friend has to do',
    where: 'Finishes: “When you …, you and your friend each get a card.” A few words.',
    max: 120,
  },
  {
    key: 'afterPurchase',
    stage: 'The page a referred friend lands on',
    label: 'The same thing, past tense',
    where: 'Finishes: “Once you have …, you will each get a card.” Shown after they send the form.',
    max: 120,
  },
  {
    key: 'inquiryNoun',
    stage: 'The page a referred friend lands on',
    label: 'What their form submission is called',
    where: 'Used on the privacy page, e.g. “we keep your roofing inquiry”.',
    max: 120,
  },
  {
    key: 'eligibility',
    stage: 'Their terms page',
    label: 'Who can take part',
    where: 'Finishes: “Anyone who has … may refer a friend.”',
    max: 300,
  },
  {
    key: 'qualifyingEvent',
    stage: 'Their terms page',
    label: 'What earns the reward',
    where: 'Finishes: “A reward is earned when the referred friend …”',
    max: 300,
  },
  {
    key: 'rewardCondition',
    stage: 'Their terms page',
    label: 'What the business confirms before a card goes out',
    where: 'Finishes: “Cards are sent once …” This is what protects them from paying on a cancelled order.',
    max: 600,
    multiline: true,
  },
];

const COPY_KEYS = COPY_FIELDS.map((f) => f.key);

// Deliberately says nothing about any trade. A dealer who fills in nothing
// still reads correctly to a roofer's, a car lot's or a tree service's
// customers — it just says less than their own words would.
const GENERIC_COPY = {
  offerHow:
    "Here's how it works: make a purchase with us and you'll receive your own referral link to share. When a friend buys through that link, you each receive a **{reward} {card}**.",
  shareButton: 'Share My Referral Link',
  // The invite email, as blocks. The optional ones default to empty, so a
  // dealer that sets nothing gets exactly the email that shipped before
  // these existed -- no dealer's mail changes because this went in.
  inviteSubject: '{name} wants to say thank you.',
  inviteOpening:
    "When you recommend **{name}** to a friend, you're trusting us to take good care of someone you know. That means a lot to us. That's why we designed our new referral program as a simple way to say thank you.",
  inviteHowItWorks: '',
  inviteAfterLink: '',
  inviteClosing:
    'Thank you for supporting our business and giving us the opportunity to serve the people you care about.',
  inviteSignature: '',
  inviteDisclaimer: '',
  // The landing page speaks as the friend who shared the link, not as the
  // business. The recommendation is the thing being traded on, and it is
  // theirs to make.
  friendGreeting: "Hey, it's {referrer}.",
  friendPitch:
    "I had a great experience with {name} and thought of you. Fill out the form below, and if you end up buying something, we'll each get a {reward} {card}!",
  leadButton: 'Get my {reward} offer',
  leadPrompt: 'What are you thinking about?',
  leadPlaceholder: 'A rough idea is plenty.',
  responseNote: '{name} will reach out within one business day. Gift cards are sent after your purchase.',
  // Written to be pasted into a gift card's own message box, so: no
  // greeting line of its own beyond the name, no signature, nothing that
  // assumes it is an email rather than a card.
  rewardNoteReferrer:
    "Hi {name} — thank you for recommending {business}. Your friend's order came through, so here is the {reward} {card} we promised you. It means a lot that you trusted us with someone you know.",
  rewardNoteFriend:
    'Hi {name} — thank you for your order, and for coming to us through a friend. Here is your {reward} {card}. You have a referral link of your own now too, so if you know someone else who could use us, it works the same way.',
  cardNoun: 'electronic gift card',
  shareTitle: 'Get {reward} when you make a purchase from {name}',
  shareText: 'I referred you — make your purchase through my link and we both get {reward}.',
  friendAction: 'make your purchase',
  afterPurchase: 'made your purchase',
  inquiryNoun: 'inquiry',
  eligibility: 'have made a purchase with us',
  qualifyingEvent: 'places and completes a qualifying order',
  rewardCondition:
    'confirms the referred order has actually been placed and a qualifying deposit received. Cancelled, refunded, or unfulfilled orders do not qualify for a reward.',
};

// Keeps only the keys that belong, trimmed, dropping blanks — so a form that
// posts nine empty boxes stores nothing rather than nine empty strings, and a
// cleared box means "go back to the generic wording" rather than "show an
// empty sentence".
function cleanCopy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const { key, max } of COPY_FIELDS) {
    const v = input[key];
    if (typeof v !== 'string') continue;
    const t = v.trim();
    if (t) out[key] = t.slice(0, max);
  }
  return Object.keys(out).length ? out : null;
}

// What actually gets written onto a new dealer: their own words where they
// wrote them, the trade-neutral wording everywhere else. Every key is always
// present, so nothing on a new dealer's pages can fall through to the shed
// default.
function copyForNewTenant(leadCopy) {
  const own = cleanCopy(leadCopy) || {};
  const out = {};
  for (const key of COPY_KEYS) out[key] = own[key] || GENERIC_COPY[key];
  return out;
}

module.exports = { COPY_FIELDS, COPY_KEYS, GENERIC_COPY, cleanCopy, copyForNewTenant };
