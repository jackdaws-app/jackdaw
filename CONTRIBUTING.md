# Contributing to Jackdaw

Thanks for wanting to help! Jackdaw is a community price-tracking Chrome extension, and it only works because people like you spot bugs, add store support, and improve the data. All kinds of contributions are welcome — code, bug reports, docs fixes, and ideas.

## How to contribute

### Issues

- **Bugs**: open an issue with the store URL, what you expected, what actually happened, and (if relevant) a screenshot. Extension version and browser version help a lot.
- **Feature requests**: describe the problem you're trying to solve, not just the solution — it helps us find the simplest fix.
- Before opening a new issue, do a quick search to see if it already exists.

### Pull requests

1. Fork the repo and create a branch from `main`.
2. Make your change, keeping it focused — one fix or feature per PR.
3. Test it locally (see the [README](README.md) for how to load the extension unpacked and run the Convex backend).
4. Open a PR with a short description of what changed and why.

Small PRs get reviewed faster. If you're planning something big, open an issue first so we can talk it through before you invest the time.

### Code style

- **Extension**: plain, no-build vanilla JavaScript. No bundlers, no transpilers, no frameworks — what you write is what ships. Keep it that way: prefer small, readable functions over clever abstractions, and don't add dependencies without discussing it first.
- **Backend**: [Convex](https://convex.dev) functions live in the `convex/` directory. Follow the existing patterns for queries, mutations, and schema.
- Match the style of the surrounding code. When in doubt, boring and consistent beats novel.

### Running the project

See the [README](README.md) for setup and run instructions (loading the extension, starting the Convex dev backend).

## Why a CLA?

When you open your first pull request, a bot will comment asking you to sign our [Contributor License Agreement](CLA.md). Signing is a one-time thing — you just reply to the bot's comment, and it remembers you for all future PRs. Here's the honest explanation of why we ask.

Jackdaw is licensed under **AGPL-3.0**. That's a deliberately strong copyleft license: it guarantees that the community's work stays open — anyone who distributes Jackdaw or runs a modified version as a service has to share their changes under the same terms.

The CLA exists for one reason: **it lets the project owner (David) keep the option of relicensing or dual-licensing parts of the project in the future** — for example, offering the backend under different terms — without having to track down and get permission from every person who ever contributed a line of code. Without a CLA, relicensing an AGPL project requires the agreement of all past contributors, which in practice becomes impossible as a project grows.

To be fully transparent about what this means: **by signing, you're trusting the project owner with relicensing rights over your contributions.** Your code in the AGPL version stays AGPL forever — that can't be taken back from anyone who received it — but the owner could also offer your contribution under other terms, including proprietary ones, without asking you again or paying you. You keep ownership of your code and can do anything you like with it elsewhere; the CLA is a license grant, not a copyright transfer.

If that trade-off doesn't sit right with you, that's a completely legitimate position — you can still help enormously through bug reports, testing, and feedback, none of which require signing anything.

The full text is in [CLA.md](CLA.md). Please read it — it's short.

## Questions?

Open an issue or start a discussion. We're friendly.
