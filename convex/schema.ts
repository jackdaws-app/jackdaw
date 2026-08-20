import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  products: defineTable({
    productId: v.string(),
    sku: v.string(),
    name: v.string(),
    brand: v.optional(v.string()),
    category: v.optional(v.string()),
    mpn: v.optional(v.string()),
    ean: v.optional(v.string()),
    urlPath: v.string(),

    // -----------------------------------------------------------------------
    // Rolling price summary, maintained on every accepted sighting.
    //
    // WHY IT IS DENORMALIZED. A grid page shows up to 96 cards and the badge on
    // each one needs that product's range. Reading the points would be up to
    // 96 x 1000 documents against a 16,384-document ceiling, so the badge reads
    // 96 product rows instead. Same rule as `counters`: a stats read is never
    // allowed to scan.
    //
    // WHY TWO PAIRS. products.history only lets a price be NAMED a record when
    // it is corroborated — seen twice, or read from a product page rather than
    // matched out of card text. The CORROB pair is that extreme; the ANY pair
    // includes lone catalog sightings and is the fallback for a product that
    // has never been seen any other way. Keeping both means `provisional` is
    // derivable here exactly as the read path derives it, so a badge and the
    // panel behind it cannot disagree about whether a number is a record.
    //
    // These only ever widen. Nothing deletes a pricePoint today; anything that
    // ever does must recompute the summary, because a low that outlives its own
    // evidence is a number with nothing behind it. `products:recompute` rebuilds
    // it from the points and is also the consistency check — it reports how many
    // rows it had to change, and that number is expected to be zero.
    lowCorrob: v.optional(v.number()),
    highCorrob: v.optional(v.number()),
    lowAny: v.optional(v.number()),
    highAny: v.optional(v.number()),
    // The newest sighting whatever its provenance, matching how history derives
    // `currentPrice`, and carried with its age for the same reason: it is the
    // most recent SIGHTING, not a live feed.
    lastPrice: v.optional(v.number()),
    lastSeenAt: v.optional(v.number()),

    // The normalized twin of `category`, kept so a category can be looked UP as
    // well as displayed.
    //
    // WHY NOT INDEX `category` ITSELF. The admin panel names categories from
    // the `obs:cat:` counter keys, which `categoryKey()` has already lowercased
    // and trimmed. An index on the raw string could not be queried with one of
    // those names, so the category list and the products behind it would be
    // addressing two different spellings and every lookup would come back
    // empty. Same normalizer on both sides or neither.
    //
    // Derived, so `products:recompute` owns it the way it owns the summary
    // above: the write paths maintain it, and the one pass that sees every row
    // is what backfills rows written before it existed and repairs any drift.
    categoryKey: v.optional(v.string()),

    // Refurbished or not, read off a parenthesised "(Refurbished)" anywhere in
    // `name` — lib.ts conditionFromName, whose comment carries the survey and
    // the reason it is not anchored to the end of the string. Derived from a
    // field we already store, so it costs no request and no payload field, and
    // `products:recompute` owns the backfill for the same reason it owns
    // `categoryKey`.
    //
    // A LITERAL rather than a string union, deliberately. Exactly one condition
    // is recognisable today: "Open Box" is not a product record at all (it is a
    // per-store shelf state on an ordinary listing, already carried by
    // storeStock.openBoxUnits), and "(Certified Refurbished)" is the same
    // physical claim under a manufacturer's programme name, so it folds into
    // this value rather than earning a second one.
    // Widening this later should require editing the schema and thinking about
    // it, not slipping a new string in through a write path.
    condition: v.optional(v.literal("refurbished")),
  })
    .index("by_productId", ["productId"])
    .index("by_categoryKey", ["categoryKey"]),

  pricePoints: defineTable({
    productDocId: v.id("products"),
    storeNum: v.string(),
    price: v.number(),
    inStock: v.boolean(),
    availability: v.optional(v.string()),
    openBoxPrice: v.optional(v.number()),
    // The retailer's OWN "Original price" — the struck-through figure beside a
    // "Save $120.00" on a grid card (`div.standardDiscount` inside the card's
    // `.price` block). Absent when no discount was advertised, and absent on
    // every row written before this field existed.
    //
    // It is here rather than on `products` because it is a price, it moves, and
    // it belongs to the same reading as the price beside it — a "was $799.99"
    // is only meaningful next to the "now" it was printed with. That also makes
    // it the one field Jackdaw holds that dates a promotion from the retailer's
    // own words rather than from inference, which is what a lone reading of a
    // brand-new product can otherwise never have: a card that has been seen
    // exactly once still carries a reference price.
    //
    // ONE NUMBER, not two. The card also prints "Save $120.00", and across 180
    // discount blocks on two page templates `strike - price === savings` held
    // every single time with zero exceptions. Storing the savings as well would
    // be a derived duplicate that can only ever disagree with its own inputs.
    //
    // Written by the catalog path when the card was legible, and CARRIED
    // FORWARD by both paths otherwise — see the carry-forward rule in
    // observations.reportBatch, and the note in observations.report, which
    // never observes this field at all and so must never be able to clear it.
    listPrice: v.optional(v.number()),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
    reportCount: v.number(),
    // Where the sighting came from. Absent means a product page, which is every
    // row written before catalog collection existed. A catalog card carries less
    // than a product page does (no MPN/EAN, stock as a bucket, and an open-box
    // price only when the card's `.clearance` div is legible), so the reader has
    // to be able to tell the two apart — see the carry-forward rule in
    // observations.reportBatch.
    source: v.optional(v.literal("catalog")),
  })
    .index("by_product", ["productDocId"])
    .index("by_product_store", ["productDocId", "storeNum"]),

  // What the last shopper saw on one shelf, at one store. ONE ROW PER
  // (product, store), OVERWRITTEN IN PLACE — there is deliberately no history
  // here and no index that could reconstruct one.
  //
  // That constraint is the whole point of the table existing. A unit count is
  // fine as an answer to "what was on the shelf when somebody last looked";
  // the same number appended once an hour for a year is a per-store depth and
  // sell-through series, which is a materially different and more sensitive
  // artefact than a price history and not something a price tracker needs. The
  // *history* stays boolean (pricePoints.inStock); the *number* lives here and
  // only ever describes now. Making it a single mutable row means no future
  // change can quietly turn it into a series without changing the schema.
  storeStock: defineTable({
    productDocId: v.id("products"),
    storeNum: v.string(),
    inStock: v.boolean(),
    // Absent when the page said "IN STOCK" with no number beside it.
    units: v.optional(v.number()),
    // "25+ IN STOCK" — Micro Center caps the display, so the reading is a
    // floor, not a count, and the UI has to say so.
    atLeast: v.optional(v.boolean()),
    // How many open-box units this store had ("2 open box from $339.96"). It is
    // here rather than on pricePoints for exactly the reason the table exists:
    // the open-box *price* is a price and belongs in the series, the *count* is
    // shelf depth for one store and must not accumulate into one. Only a grid
    // card carries it — a product page shows the open-box price with no count —
    // so it is absent on rows only a product page has ever touched.
    openBoxUnits: v.optional(v.number()),
    observedAt: v.number(),
  }).index("by_product_store", ["productDocId", "storeNum"]),

  comments: defineTable({
    productDocId: v.id("products"),
    deviceId: v.string(),
    // The name shown on the comment, frozen at post time. For an anonymous
    // comment it is whatever was typed; for a signed-in one the server
    // overwrites it with the account's claimed handle and ignores the client's
    // argument entirely (comments.ts). Storing the text rather than resolving
    // it through accountId on read is what keeps a thread readable after the
    // account is deleted — and is safe precisely because a handle is permanent
    // once claimed, so the copy can never drift from the original.
    displayName: v.string(),
    body: v.string(),
    score: v.number(),
    voteCount: v.number(),
    parentId: v.optional(v.id("comments")),
    hidden: v.optional(v.boolean()),
    reportCount: v.optional(v.number()),
    // Set only when the comment was posted through a session that resolved to
    // an account holding a handle. It is the ONLY source of the verified marker
    // (comments:list derives `verified` from its presence), which is why
    // auth:deleteAccount clears it: once the account is gone nobody can prove
    // that identity, so the tick has to go with it while the words stay.
    accountId: v.optional(v.id("accounts")),
  })
    .index("by_product", ["productDocId"])
    .index("by_parent", ["parentId"])
    .index("by_reportCount", ["reportCount"])
    // The delete-account sweep, which unlinks this account's comments in
    // bounded batches. Same shape and same reason as watches' by_account_active
    // one table over: an account-scoped teardown must never scan comments.
    .index("by_account", ["accountId"]),

  // Votes and reports are keyed by ACCOUNT since participation moved behind
  // sign-in (2026-08-20): a deviceId is client-forgeable, so "one vote per
  // device" was one vote per curl call, and the auto-hide threshold below it
  // was five curl calls. Rows written before that carry deviceId and no
  // accountId — they stay as counted history (the score they built is real)
  // but no longer match any voter, which is acceptable: the worst case is a
  // person re-voting once on a comment they voted on anonymously.
  reports: defineTable({
    commentId: v.id("comments"),
    // Legacy anonymous rows only; the write path no longer records a device.
    deviceId: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
  })
    .index("by_comment_account", ["commentId", "accountId"])
    .index("by_comment", ["commentId"]),

  votes: defineTable({
    commentId: v.id("comments"),
    // Legacy anonymous rows only; the write path no longer records a device.
    deviceId: v.optional(v.string()),
    accountId: v.optional(v.id("accounts")),
    value: v.union(v.literal(1), v.literal(-1)),
  })
    .index("by_comment_account", ["commentId", "accountId"])
    .index("by_comment", ["commentId"]),

  watches: defineTable({
    deviceId: v.string(),
    productDocId: v.id("products"),
    priceAtWatch: v.number(),
    active: v.boolean(),
    // The scope watches.ts reads and writes by (as of 2026-08-20 every watch
    // is account-scoped; the mutations refuse SIGN_IN_REQUIRED without a
    // session). Optional only for legacy pre-gating rows: a device-keyed row
    // with no accountId is invisible to every read until auth:verifyCode
    // adopts it into the signing-in account — deviceId names the browser that
    // wrote the row, accountId names its owner.
    accountId: v.optional(v.id("accounts")),

    // ---------------------------------------------------------------------
    // Triggers
    //
    // A watch is ONE alert with up to three reasons to fire, because ack
    // disarms the whole row — so two reasons firing at once would produce two
    // notifications a single dismissal could not both answer.
    //
    // The price trigger is deliberately NOT store-scoped. Micro Center prices
    // nationally — 12 products sampled across GPUs, laptops, CPUs and SSDs
    // against 4-5 stores each showed zero price variation (2026-08-15) — so
    // "newest observation from any store" is both correct and the freshest
    // reading available, and filtering it to one store would only make alerts
    // staler while changing no number.
    //
    // Two facts DO vary by store, and the fields below are for those: whether
    // the item is in stock, and the open-box price, which is the only
    // genuinely per-store price on the page because an open-box unit is one
    // physical item at one location.
    //
    // All four are optional so every row written before this existed keeps
    // working untouched — absent means "price trigger only", which is what
    // those rows have always meant.
    // ---------------------------------------------------------------------

    // Whether priceAtWatch is a live trigger. Absent means yes, which is what
    // every row predating this field meant and still means.
    //
    // It can be switched off because price wins ties and ack disarms the whole
    // watch: somebody who wants "tell me when it's back in stock at Westmont"
    // and is forced to carry a price target gets the price alert first, acks
    // it, and the restock alert they actually asked for is silently gone. The
    // flag is what makes a store-only alert a real thing rather than a price
    // alert wearing a hat.
    alertPrice: v.optional(v.boolean()),
    // The store the per-store triggers below apply to, captured from the page's
    // own dataLayer when the alert is armed.
    //
    // "029" is NOT a physical store — it is Micro Center's "Shippable Items"
    // pseudo-store and the default for anyone who has never picked a location,
    // and "000" is page-world.js's fallback when the dataLayer carries neither
    // storeNum nor closestStoreId. Neither can satisfy a per-store trigger, so
    // watches.ts refuses to arm one against them rather than storing a watch
    // that could never fire.
    storeNum: v.optional(v.string()),
    // Fire when an open-box unit is seen at storeNum. Open-box is where the
    // real discounts are, and it is invisible from any other store's page.
    alertOpenBox: v.optional(v.boolean()),
    // Fire when storeNum goes out-of-stock -> in-stock. Micro Center's model is
    // in-store pickup ("Available for In-Store Pickup Only" on most hardware),
    // so stock at YOUR store is the fact that decides whether a trip happens.
    alertRestock: v.optional(v.boolean()),
  })
    // Watches are soft-deactivated (toggle/ack set active:false rather than
    // deleting), so a device's row count grows without bound. Scoping the
    // read window to active rows keeps a long tail of dead watches from
    // pushing live ones out of check/dashboard's take(50).
    .index("by_device_active", ["deviceId", "active"])
    .index("by_device_product", ["deviceId", "productDocId"])
    // Deployment-wide active watches, for the admin panel's aggregate watched
    // value. Targets change, so that figure is a bounded live sum rather than
    // a counter.
    .index("by_active", ["active"])
    // Account-scoped reads: the delete-account unlink sweep, and the watchlist
    // a signed-in caller sees on every browser. Same active-first shape as
    // by_device_active, for the same reason.
    .index("by_account_active", ["accountId", "active"])
    // The account's row for one product, for the same reason by_device_product
    // exists one owner up: a signed-in write has to find the alert the person
    // already set on another browser, rather than minting a second row for a
    // product they are already watching.
    .index("by_account_product", ["accountId", "productDocId"]),

  devices: defineTable({
    deviceId: v.string(),
    lastReportKey: v.optional(v.string()),
    lastReportAt: v.optional(v.number()),
    // Same idea one level up, for catalog batches. The key identifies a grid
    // page WITHOUT storing anything about it that a person typed: store number,
    // item count, and a 32-bit fold of the SORTED product ids on the page. Two
    // loads of the same grid inside a minute collapse to one write; a genuinely
    // different page differs in the fold, while a re-render that only reorders
    // the same cards does not. An earlier version keyed on the FIRST product id
    // instead of the fold, and silently dropped a whole page whenever a filter
    // change left the leading card and the card count alone. The search terms
    // that produced the page are never sent here.
    lastBatchKey: v.optional(v.string()),
    lastBatchAt: v.optional(v.number()),
  }).index("by_deviceId", ["deviceId"]),

  // -------------------------------------------------------------------------
  // Accounts
  //
  // Reading stays anonymous — price history, product stats and comment
  // threads never ask who you are. Participation does not (as of 2026-08-20):
  // posting, voting, reporting and every watch/alert path require a signed-in
  // account, because the deviceId is client-forgeable and the account is the
  // only identity the server can actually vouch for. The account still ADOPTS
  // what the device wrote before sign-in (auth:verifyCode), and it is what
  // makes alerts survive cleared browser data.
  //
  // The email address is the only personal data Jackdaw has ever stored, which
  // is why deleteAccount removes the row outright and merely unlinks the
  // watches. Note what unlinking now means: with alerts account-scoped, an
  // unlinked row is dormant until a future sign-in on that device adopts it —
  // it no longer fires on its own.
  // -------------------------------------------------------------------------

  accounts: defineTable({
    // Lowercased and trimmed before both storage and lookup, so "A@b.com" and
    // "a@b.com " are one account rather than two.
    email: v.string(),
    createdAt: v.number(),
    lastLoginAt: v.number(),
    // The claimed handle, in the casing the person typed — this is the string
    // rendered beside the verified marker. Optional because an account without
    // one is a perfectly good account: it syncs watches, it just can't comment
    // until it picks a handle (comments:add answers NEED_HANDLE).
    //
    // PERMANENT ONCE SET. auth:claimHandle refuses a second claim (LOCKED) and
    // there is no rename path anywhere, because comments store the handle text
    // at post time — a rename would leave every earlier comment attributed to a
    // name its author no longer holds, which is exactly the confusion the tick
    // is supposed to end.
    handle: v.optional(v.string()),
    // The collision key: `handle` lowercased with every character outside
    // [a-z0-9] stripped, so Hex_Byte / hex-byte / HEXBYTE / "hex byte" all fold
    // to "hexbyte" (lib.ts handleKeyOf). One key does two jobs — uniqueness
    // between accounts, and the block that stops an anonymous commenter typing
    // a claimed name — and it strips separators because the near-miss is the
    // whole attack: "hex-byte" beside "hex_byte" is indistinguishable to a
    // reader skimming a thread.
    handleKey: v.optional(v.string()),

    // May this account open the admin panel? ABSENT MEANS NO, which is what
    // every account in the table means today and what every account created
    // from here on means until somebody says otherwise. Read as
    // `isAdmin === true` and never for truthiness, the same rule
    // `alertOpenBox === true` follows one table up: the one direction this
    // comparison must never drift is toward admitting an ordinary account.
    //
    // WRITABLE ONLY FROM AN INTERNAL MUTATION — auth:grantAdmin and
    // auth:revokeAdmin, run from a CLI session that already holds the
    // deployment's admin key. No public function reads this field as an
    // argument, sets it, or takes any input that could reach it, which is what
    // makes the blast radius of a bug in the public sign-in surface bounded:
    // the worst a broken verify path can hand out is a session on an ordinary
    // account, and an ordinary account is not an admin. Privilege is granted
    // out of band or not at all.
    //
    // Not indexed. The table holds a handful of rows and the only read that
    // wants this field is auth:listAdmins, a CLI chore — an index here would
    // cost a write on every sign-in to serve it.
    isAdmin: v.optional(v.boolean()),
  })
    .index("by_email", ["email"])
    // Point lookups only, from two paths: claiming (is this key free?) and
    // anonymous commenting (is this typed name someone's claimed handle?).
    // Rows with no handle sort under `undefined` and can never match a string
    // probe, so the index stays exact without a partial-index equivalent.
    .index("by_handleKey", ["handleKey"]),

  // Handles belonging to deleted accounts. A retired key is never re-claimable
  // and stays un-typeable by anonymous commenters, forever.
  //
  // Without this, someone claims a deleted user's handle and their new ticked
  // comments sit in the same threads as the old unticked ones under the same
  // name — the tick would then be actively misleading rather than merely
  // meaningless, which is worse than having no marker at all.
  //
  // This survives auth:deleteAccount deliberately and is not a hole in erasure:
  // a handle is a pseudonym the person chose to publish next to their comments,
  // and those comments are still there. The email address — the one piece of
  // personal data Jackdaw holds — is deleted outright.
  retiredHandles: defineTable({
    handleKey: v.string(),
    retiredAt: v.number(),
  }).index("by_handleKey", ["handleKey"]),

  // A session is a bearer token: whoever holds it is the account. Only the
  // hash is ever stored, so a database dump is not a pile of live credentials —
  // the token itself is returned to the client exactly once, by verifyCode.
  sessions: defineTable({
    accountId: v.id("accounts"),
    tokenHash: v.string(),
    createdAt: v.number(),
    expiresAt: v.number(),
    lastUsedAt: v.number(),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_account", ["accountId"]),

  // One live code per email (storeCode replaces rather than appends), hashed
  // the same way sessions are. `attempts` is what makes a 6-digit secret
  // defensible at all: the code dies after MAX_CODE_ATTEMPTS wrong guesses,
  // which is why auth:consumeCode returns its verdict in-band instead of
  // throwing — a throwing mutation would roll the increment back and hand an
  // attacker unlimited guesses at a one-in-a-million number.
  loginCodes: defineTable({
    email: v.string(),
    codeHash: v.string(),
    expiresAt: v.number(),
    attempts: v.number(),
    consumedAt: v.optional(v.number()),
    // DEVELOPMENT ONLY. Written by auth:sendCode solely when RESEND_API_KEY is
    // unset — i.e. when there is no mail provider to deliver the code and
    // `npx convex run auth:devPeekCode` is the only way to read it. A
    // deployment with mail configured never populates this field, so the
    // plaintext of a live code is never at rest in production.
    devCode: v.optional(v.string()),
  }).index("by_email", ["email"]),

  // The published text of PRIVACY.md and TERMS.md, so the two documents can be
  // amended from the admin panel instead of a deploy.
  //
  // APPEND-ONLY. A publish inserts; nothing here is ever patched or deleted,
  // including a revert, which republishes an old body as a new version. A
  // policy that can be edited in place is not a policy — the whole value of
  // keeping the history is being able to say what a user agreed to on a given
  // day, and a mutable row cannot answer that.
  //
  // `slug` is a closed union rather than free text for the same reason
  // EVENT_NAMES is: the doc pages ask for exactly these two, and a caller who
  // could mint a third would be publishing a document no page renders and no
  // one reviews.
  //
  // The committed HTML remains the floor. site/privacy.html and site/terms.html
  // carry the last committed body baked in and a `data-policy-version`; the
  // page swaps to the row below only when this `version` is higher and the
  // markdown parses. A reader with JavaScript off, a printer, and a store
  // reviewer therefore always see text that is in git.
  policyDocs: defineTable({
    slug: v.union(v.literal("privacy"), v.literal("terms")),
    // 1-based, contiguous per slug, assigned from the current maximum at
    // publish. Not `_creationTime`: the pages compare it against a number
    // written into committed HTML, so it has to be small, stable and readable.
    version: v.number(),
    markdown: v.string(),
    publishedAt: v.number(),
    // Why this version exists, for the history list. Never rendered publicly.
    note: v.optional(v.string()),
  }).index("by_slug_version", ["slug", "version"]),

  // Incremental metrics for the admin panel. Every number the dashboard shows
  // is maintained on write, because counting on demand (e.g. all pricePoints)
  // would blow the ~16k document read limit as history accumulates.
  //
  // Keys are namespaced and ordered so a prefix range read is possible:
  //   obs:total · obs:store:<storeNum> · obs:day:<YYYY-MM-DD>
  //   pricepoints:total · products:total · devices:total
  //   comments:total · comments:day:<YYYY-MM-DD> · comments:hidden
  //   reports:total · alerts:armed · alerts:fired · handles:claimed
  //   evt:<name> · evt:<name>:day:<YYYY-MM-DD>
  //
  // The evt: namespace is client health telemetry. <name> is one of the six
  // fixed names in lib.ts's EVENT_NAMES and can only ever be one of those —
  // metrics:events validates against a closed union, so no caller can mint a
  // key here. Nothing in the namespace is derivable from the tables (an event
  // is a moment, not a row), so admin:backfillCounters leaves it alone.
  //
  // These are plain documents, so a single key is a contention point under
  // heavy concurrent writes. At Jackdaw's volume (one report per device per
  // product per minute) that's far from an issue; if "obs:total" ever starts
  // throwing OCC conflicts, move the hot keys to @convex-dev/sharded-counter.
  counters: defineTable({
    key: v.string(),
    value: v.number(),
  }).index("by_key", ["key"]),
});
