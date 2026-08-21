import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Scheduled jobs
//
// There is exactly one, and it should stay that way without a reason: every
// cron is a function that runs whether or not anybody is using the product, so
// each one is a standing cost and a standing way to be wrong at 3am with nobody
// watching. Anything that can be driven by a user's own action belongs on that
// path instead — which is where the rest of Jackdaw's work already lives.
//
// WHY THIS ONE CANNOT. Browser alerts are a pull: chrome.alarms wakes hourly
// and calls watches:check. That covers the shopper with a browser open and
// nobody else, and "nobody else" is precisely who asked for an email — the
// person who armed a watch and shut the laptop. A push needs a clock that is
// not theirs.
// ---------------------------------------------------------------------------

const crons = cronJobs();

// Hourly, matching the browser alarm's cadence deliberately: the two halves
// answer the same question and a shopper with both should not see them disagree
// about how fresh "just now" is. It is also the interval the data can support —
// a sighting only exists because somebody walked past a shelf, so sweeping
// every ten minutes would mostly be reading rows nothing had touched.
crons.hourly(
  "email price alerts",
  { minuteUTC: 20 },
  internal.alerts.sweep,
  {},
);

// Sign-in codes are written the moment a code is REQUESTED, before any
// account exists, so an address typed into the sign-in box and then abandoned
// is data we hold on behalf of someone who never became a user. Nothing in a
// read path clears it: a consumed code is inert but immortal. The policy says
// an unfinished sign-in expires, so something has to make that true on its own
// rather than when a maintainer remembers.
//
// Bounded per run and reports `more` — at a volume where one daily pass stops
// keeping up, raise the frequency rather than the cap.
crons.daily(
  "purge spent sign-in codes and dead sessions",
  { hourUTC: 8, minuteUTC: 10 },
  internal.auth.purgeExpired,
  {},
);

export default crons;
