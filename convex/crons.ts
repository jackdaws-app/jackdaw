import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

// ---------------------------------------------------------------------------
// Scheduled jobs
//
// Two, and each one had to earn it: a cron runs whether or not anybody is using
// the product, so it is a standing cost and a standing way to be wrong at 3am
// with nobody watching. Anything that can be driven by a user's own action
// belongs on that path instead — which is where the rest of Jackdaw's work
// already lives.
//
// WHY THE EMAIL PASS CANNOT BE DRIVEN ENTIRELY THAT WAY. Browser alerts are a
// pull: chrome.alarms wakes hourly and calls watches:check. That covers the
// shopper with a browser open and nobody else, and "nobody else" is precisely
// who asked for an email — the person who armed a watch and shut the laptop. A
// push needs a clock that is not theirs.
//
// A SIGHTING NOW DRIVES ONE TOO, and the two are not redundant. Recording a
// price that moved schedules `alerts.fanOut` over the products it moved for
// (`observations.ts`), and arming a watch schedules one for that product
// (`watches.ts`), so the common case — somebody walks past the shelf, the
// watcher hears about it — no longer waits for the top of the hour. That path
// is an ACCELERATOR WITH NO CORRECTNESS OBLIGATIONS: it is capped per pass, it
// is skipped for a sighting that changed nothing, and it cannot see the cases
// where a row becomes emailable with no sighting behind it at all (turning
// email alerts on, adopting a device's watches into an account). THE CRON IS
// THE GUARANTEE. Every one of those reaches the same code by the same door
// within the hour, which is why it stays hourly rather than dropping to a daily
// backstop: what the fast path misses is not only failed sends.
// ---------------------------------------------------------------------------

const crons = cronJobs();

// Hourly, matching the browser alarm's cadence deliberately: the two halves
// answer the same question and a shopper with both should not see them disagree
// about how fresh "just now" is. It is also the interval the data can support —
// a sighting only exists because somebody walked past a shelf, so sweeping
// every ten minutes would mostly be reading rows nothing had touched.
//
// It is unchanged by the fan-out above it. Sweeping less often would trade a
// bound this pass holds for one only the fast path holds, and the fast path
// holds none: it is capped, and it does not run for a watch that became
// emailable without a sighting. It also bounds how long a claim left behind by
// a crashed send can sit — see EMAIL_CLAIM_TTL_MS in `watches.ts`.
//
// THE SEND CAP IS PER PASS, NOT PER HOUR. One tick starts a pass; a pass that
// fills EMAIL_SEND_LIMIT and sent something schedules the next pass itself
// (`alerts.sweep`'s `hop`), up to MAX_HOPS deep, so the hourly throughput is
// the chain's, not one action's. What this schedule decides is how long a
// row can wait to be NOTICED, never how many can be sent once it is.
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
