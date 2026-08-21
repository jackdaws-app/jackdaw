# Privacy Policy

*Last updated: August 20, 2026.*

This Privacy Policy describes how the Jackdaw browser extension ("Jackdaw," "we," "our") collects, uses, and shares information. **Viewing and contributing to Jackdaw do not require an account.** Price history is displayed, and price observations are contributed, anonymously. Posting comments, voting, reporting, setting price alerts, and seeing the readings recorded at one particular store require an account, described in Section 2.

## 1. Information We Collect (all users)

- **Device identifier.** A randomly generated identifier (UUID) created by your browser when the extension is installed. It is not derived from your name or email address, and for users without an account it is not linked to any identity.
- **Price observations.** When you visit a Micro Center product page, the extension reads product information already displayed on that page — the product's identifiers (product ID, SKU, and the manufacturer and barcode numbers where the page carries them), its name, brand, category, and its own path on the retailer's site; its price, together with any open-box or advertised original price shown beside it; its stock status; and your selected store number — and submits it to the shared community database. On Micro Center search and category pages it does the same for the product listings already displayed on the page you are viewing, submitting them together as one batch. In both cases it reads only what your browser has already loaded: it does not open pages, load products in the background, follow links, or request anything from Micro Center on your behalf. None of this happens until you turn on "Contributing" — the extension asks once when it is installed, and again in its toolbar popup until you answer — and you can turn it off again at any time; the rest of the extension works either way.
- **Price-history requests.** To display price history on a page you are already viewing, the extension asks our servers for the recorded history of the products shown on that page. Such a request contains the product identifiers, and, when you are signed in, a session token identifying your account; it contains no device identifier, no page address, no search terms, and no filters. The recorded price history is returned in full whether or not you are signed in; the token returns the two per-store readings described in Section 2. These requests only read the database; no record of them is written to it. On search and category pages, this display can be turned off from the extension's toolbar popup, under "Showing." That setting is separate from "Contributing," because it governs what the extension shows you rather than what it submits.
- **User content.** Comments, votes, reports, and price-alert targets. Each of these requires an account. Comments are displayed under the handle claimed on the account that posted them, as described in Section 2.
- **Anonymous diagnostic counts.** Aggregate tallies of two kinds, used to detect outages and faults in the extension itself. The first counts events such as "price report failed" or "product data not found." The second counts, for each page from which observations are submitted, how many product listings the extension was able to read and which of the page elements it looks for were present; this is submitted only together with an observation, and is governed by the same "Contributing" setting. Both are counts only: they contain no identifier, no page address, and no content, and neither varies with who is browsing.
- **Anonymous alert counts.** When you click one of Jackdaw's price-alert notifications, the extension increments a single shared counter, so that we can tell how often alerts are acted on. The request carries no arguments at all: no device identifier, no product, no store, and nothing about the alert. Only the total and the date it arrived are recorded.

## 2. Optional Accounts

An account is not needed to view price history or to contribute price observations. It is required to post comments, vote, report, set price alerts, and see the readings recorded at one particular store. If you create one:

- **We collect your email address**, used to send you a sign-in code and, if you enable it, alerts for the products you are watching. Email alerts are off until you turn them on, from the extension's toolbar popup; every message we send carries a link that turns them off again, and using that link requires no account and no sign-in. We do not use your address for marketing, we do not send advertising or sponsored content, and we do not sell it. It is disclosed only to the providers named in Section 5, and only so that the messages described above can be delivered.
- Your existing alerts and watchlist are linked to the account so they survive clearing your browser data and follow you to other browsers.
- **You see the per-store readings.** Two of the readings Jackdaw records describe one location rather than the whole country: the most recent shelf reading at your selected store, and the open-box price recorded there. Both are returned only to a signed-in request. The price history itself — every price, its date, and whether the item was in stock, pooled across every store — is returned to everyone, with or without an account.
- **You may claim a handle.** A handle is a name displayed on your comments together with a verified marker indicating that no other user may post under it. Claiming a handle is required to post comments and is otherwise optional. A handle is permanent: it cannot be changed, transferred, or released while the account exists. Comments you post are displayed under your handle.
- You can delete your account at any time from the extension. Deleting it removes your email address, all sign-in sessions, and your price alerts, and removes the verified marker from comments you posted. Price observations and comments you contributed remain part of the community record; they are no longer linked to your account or email address. If you claimed a handle, that handle is retained in a list of retired handles so that it cannot be claimed by another user; the list records the handle and the date it was retired, and contains no email address or other identifier.

If you never create an account, we never collect an email address.

## 3. Information We Do Not Collect

- No name, postal address, or password (sign-in uses a one-time emailed code).
- No email address unless you choose to create an account.
- No browsing history. The extension runs only on `microcenter.com` product, search, and category pages, and collects nothing elsewhere. On search and category pages it records the products that were displayed; it does not record the address of the page, the search terms you typed, or the filters you applied.
- No purchase, payment, or cart information. The extension does not run on checkout pages.
- No advertising identifiers and no third-party analytics.
- No cross-site tracking. Jackdaw does not track users over time across other websites, and therefore does not respond to "Do Not Track" browser signals.

## 4. How We Use Information

Information is used solely to operate the service: displaying community price history, discussion, and price alerts. We do not sell or rent any information, and we do not use it for advertising.

Jackdaw adheres to the Chrome Web Store User Data Policy, including its Limited Use requirements: the information described in this policy is used only to provide the features it describes, is never sold, is never used or transferred for advertising or for purposes unrelated to those features, and is never used to determine creditworthiness or for lending.

## 5. Data Storage and Sharing

Data is stored with our backend provider, Convex (United States). Email is delivered by our email provider, Resend (United States). It receives your email address and the contents of the message addressed to you, such as a sign-in code, or an alert naming the product you are watching, the price and store number recorded for it, when it was recorded, the price you asked to be notified at, a link to the product page, and a link that turns these emails off. It is provided this information only for the purpose of delivering the message. Aggregate price history is public by design: it is displayed to all users and may be published in open formats. Comments and the names displayed on them are visible to all users. Device identifiers, email addresses, and alert targets are not publicly displayed.

Some information is held only in your browser and is never transmitted to us: your extension settings, and a short list of the products the extension has recently reported, which it keeps so that revisiting or re-filtering the same listings does not report the same item repeatedly. That list contains product and store identifiers only, expires automatically after a few minutes, and is removed when you uninstall the extension.

## 6. Data Retention and Deletion

Uninstalling the extension deletes the device identifier from your browser. If you created an account, deleting it removes your email address and sessions immediately. Previously contributed price observations remain in the community database and carry no identifier of any kind. Comments, votes, and reports remain as well. Comments are unlinked from the deleted account and continue to display the handle as written at the time of posting, without the verified marker. Votes and reports retain an internal account reference used only for moderation and vote counting; once the account is deleted, it no longer corresponds to any email address or identity. Comments also retain the anonymous device identifier of the browser that posted them, kept for the same purpose. It is not linked to an email address or identity. Votes and reports submitted before accounts were required for participation may retain that identifier in place of an account reference, used the same way. Retired handles are retained indefinitely, as described in Section 2, so that a handle cannot be reassigned to another user. To request removal of specific content you posted, open an issue in the project's GitHub repository.

## 7. Children

Jackdaw is not directed at children under 13, and we do not knowingly collect information from them.

## 8. Changes to This Policy

We may update this policy. Material changes will be reflected by the "Last updated" date above and in the project repository's change history.

## 9. Contact

Jackdaw is operated by David, an individual based in the United States ("we", "us", "our"). Questions or requests: open an issue in the Jackdaw GitHub repository.
