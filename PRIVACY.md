# Privacy Policy

*Last updated: August 17, 2026.*

This Privacy Policy describes how the Jackdaw browser extension ("Jackdaw," "we," "our") collects, uses, and shares information. **Jackdaw does not require an account.** All features work anonymously; an optional account may be created to sync alerts across browsers and to claim a handle, and is described in Section 2.

## 1. Information We Collect (all users)

- **Device identifier.** A randomly generated identifier (UUID) created by your browser when the extension is installed. It is not derived from your name or email address, and for users without an account it is not linked to any identity.
- **Price observations.** When you visit a Micro Center product page, the extension reads product information already displayed on that page — the product's identifiers (product ID, SKU, and the manufacturer and barcode numbers where the page carries them), its name, brand, category, and its own path on the retailer's site; its price, together with any open-box or advertised original price shown beside it; its stock status; and your selected store number — and submits it to the shared community database. On Micro Center search and category pages it does the same for the product listings already displayed on the page you are viewing, submitting them together as one batch. In both cases it reads only what your browser has already loaded: it does not open pages, load products in the background, follow links, or request anything from Micro Center on your behalf. None of this happens until you turn on "Contributing" — the extension asks once when it is installed, and again in its toolbar popup until you answer — and you can turn it off again at any time; the rest of the extension works either way.
- **Price-history requests.** To display price history on a page you are already viewing, the extension asks our servers for the recorded history of the products shown on that page. Such a request contains the product identifiers and nothing else: no device identifier, no account, no page address, no search terms, and no filters. These requests only read the database; no record of them is written to it. On search and category pages, this display can be turned off from the extension's toolbar popup, under "Showing." That setting is separate from "Contributing," because it governs what the extension shows you rather than what it submits.
- **User content.** Comments, votes, reports, price-alert targets, and the name displayed on your comments. Without an account, that name is self-selected text and is not verified. With an account, it is the handle you claim under Section 2.
- **Anonymous diagnostic counts.** Aggregate tallies of two kinds, used to detect outages and faults in the extension itself. The first counts events such as "price report failed" or "product data not found." The second counts, for each page from which observations are submitted, how many product listings the extension was able to read and which of the page elements it looks for were present; this is submitted only together with an observation, and is governed by the same "Contributing" setting. Both are counts only: they contain no identifier, no page address, and no content, and neither varies with who is browsing.
- **Anonymous alert counts.** When you click one of Jackdaw's price-alert notifications, the extension increments a single shared counter, so that we can tell how often alerts are acted on. The request carries no arguments at all: no device identifier, no product, no store, and nothing about the alert. Only the total and the date it arrived are recorded.

## 2. Optional Accounts

Creating an account is entirely optional. If you create one:

- **We collect your email address**, used to send you a sign-in code and, if you enable it, price-drop alerts. We do not use it for marketing and do not share or sell it.
- Your existing alerts and watchlist are linked to the account so they survive clearing your browser data and follow you to other browsers.
- **You may claim a handle.** A handle is a name displayed on your comments together with a verified marker indicating that no other user may post under it. Claiming a handle is optional, and a handle is permanent: it cannot be changed, transferred, or released while the account exists. Comments you post while signed in are displayed under your handle, and the name field is not used.
- You can delete your account at any time from the extension. Deleting it removes your email address and all sign-in sessions, and removes the verified marker from comments you posted. Price observations and comments you contributed remain part of the community record; they are no longer linked to your account or email address. If you claimed a handle, that handle is retained in a list of retired handles so that it cannot be claimed by another user; the list records the handle and the date it was retired, and contains no email address or other identifier.

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

Data is stored with our backend provider, Convex (United States). Aggregate price history is public by design: it is displayed to all users and may be published in open formats. Comments, the names displayed on them, and handles are visible to all users. Device identifiers, email addresses, and alert targets are not publicly displayed.

Some information is held only in your browser and is never transmitted to us: your extension settings, and a short list of the products the extension has recently reported, which it keeps so that revisiting or re-filtering the same listings does not report the same item repeatedly. That list contains product and store identifiers only, expires automatically after a few minutes, and is removed when you uninstall the extension.

## 6. Data Retention and Deletion

Uninstalling the extension deletes the device identifier from your browser. If you created an account, deleting it removes your email address and sessions immediately. Previously contributed price observations remain in the community database and carry no identifier of any kind. Comments, votes, and reports remain as well; they retain the device identifier they were submitted under, which is used only for moderation and vote counting and is not linked to any name, email address, or account. Comments posted under a handle continue to display that handle as written at the time of posting, without the verified marker. Retired handles are retained indefinitely, as described in Section 2, so that a handle cannot be reassigned to another user. To request removal of specific content you posted, open an issue in the project's GitHub repository.

## 7. Children

Jackdaw is not directed at children under 13, and we do not knowingly collect information from them.

## 8. Changes to This Policy

We may update this policy. Material changes will be reflected by the "Last updated" date above and in the project repository's change history.

## 9. Contact

Questions or requests: open an issue in the Jackdaw GitHub repository.
