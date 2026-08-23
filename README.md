# Jackdaw

Every price has a history. Jackdaw remembers Micro Center's: what a part used to cost, what it typically costs, and whether today's price is a good one. Free and open source.

**[Add to Chrome](https://jackdaws.app/#install)** (Chrome Web Store listing coming soon) &middot; **[jackdaws.app](https://jackdaws.app)**

## What you get

- A price history chart on every product page, with open-box prices and a verdict on today's number
- Alerts: name your price, or watch for open-box and back-in-stock at your store
- Notes from shoppers who were standing in the aisle, threaded on the product page
- Dark mode and a toolbar watchlist

**How data is gathered (no scraping):** the extension reads the prices already on a page the user chose to open, and reports those readings to the shared database. It opens no pages of its own, follows no links, and stores no product images. Contributing is a single opt-in switch, off until the user turns it on, and every other feature works either way. See [DATA-POLICY.md](DATA-POLICY.md) for the full posture.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require signing [CLA.md](CLA.md).

Found a vulnerability? Please report it privately, through the *Security* tab above or `security@jackdaws.app`; see [SECURITY.md](SECURITY.md).

## Supporting it

Jackdaw is free, and every part of it stays free. Donations cover hosting, the domain, and the Chrome Web Store fee, nothing more; there is a Sponsor button at the top of this repository. Donations are ordinary income to the maintainer and are not tax-deductible.

## License

Jackdaw's own source is licensed under AGPL-3.0; see [LICENSE](LICENSE). Anyone who distributes Jackdaw, or runs a modified version as a network service, has to share their changes under the same terms.

That grant stops at `site/vendor/`, which holds third-party files redistributed unmodified under their own licenses: GSAP (a proprietary GreenSock license), Lenis (MIT), and two SIL OFL fonts. [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md) states the scope and reserves the Jackdaw name and bird mark, which the code license never conveyed: fork it freely, and ship the result under a name of your own. **If you fork this and intend to charge for the result, read the GSAP terms first.**
