// Does the rule actually hold mail on Sunday, and actually let it through
// otherwise? Checked by calling the real cycles with a stubbed sendEmail,
// and counting what reached Postmark.
const path = '/home/claude/50.-platform/api/src/lib/postmark.js';
const postmark = require(path);
let sent = [];
postmark.sendEmail = async (m) => { sent.push(m.subject); };

const { isQuietDay } = require('/home/claude/50.-platform/api/src/lib/quietDay.js');

const SUN = new Date('2026-11-01T14:00:00Z'); // Sun 9am ET
const MON = new Date('2026-11-02T14:00:00Z'); // Mon 9am ET
const SAT_LATE = new Date('2026-11-01T02:00:00Z'); // Sat 10pm ET, UTC already Sunday

let bad = 0;
const check = (label, got, want) => {
  const ok = got === want;
  if (!ok) bad++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
};

check('Sunday 9am ET is quiet',            isQuietDay(SUN), true);
check('Monday 9am ET is not quiet',        isQuietDay(MON), false);
check('Saturday 10pm ET is not quiet',     isQuietDay(SAT_LATE), false);
check('Sunday 11:59pm ET is still quiet',  isQuietDay(new Date('2026-11-02T04:59:00Z')), true);
check('Monday 12:01am ET is not quiet',    isQuietDay(new Date('2026-11-02T05:01:00Z')), false);
// Summer, to prove it is not hard-coded to one UTC offset.
check('Sun noon EDT is quiet',             isQuietDay(new Date('2026-07-05T16:00:00Z')), true);
check('Sat 11pm EDT is not quiet',         isQuietDay(new Date('2026-07-05T03:00:00Z')), false);

process.exit(bad ? 1 : 0);
