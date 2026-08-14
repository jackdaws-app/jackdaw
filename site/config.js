// Which Convex deployment the site's admin panel talks to.
// Mirrors extension/config.js so both are swapped together at release.
//
//   DEV  https://calculating-shepherd-148.convex.cloud  (seeded demo data)
//   PROD https://insightful-wren-655.convex.cloud       (kept clean)
//
// Keep this on DEV while developing: the panel's moderation actions write,
// and prod's counters (especially alerts:clicked) have no decrement path.
window.JACKDAW_CONVEX_URL = "https://calculating-shepherd-148.convex.cloud";
