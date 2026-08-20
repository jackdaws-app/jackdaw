# Contributing to Jackdaw

Jackdaw is maintained by one person (David) and is likely to stay that way. That shapes
what's realistic here, so this document is direct about it rather than promising a review
pipeline that doesn't exist.

**Bug reports and observations are valuable and always welcome.** Pull requests are
accepted selectively, and the section below is honest about which ones.

## What helps most

- **Bug reports.** The product page URL, what you expected, what happened, extension and
  browser versions, and a screenshot if it's visual. Reports of a price or stock reading
  that looks wrong are especially useful; they're hard to find from the inside.
- **Reports that a page stopped parsing.** Micro Center changes its markup periodically.
  If the panel goes blank or a figure disappears, that's the highest-priority class of bug
  in the project.
- **Testing on setups I don't have:** different stores, different Chrome versions, other
  Chromium browsers.
- **Documentation fixes.** Anything inaccurate, unclear, or out of date.

None of these require signing anything.

## Pull requests

**Open an issue first and wait for a reply.** This isn't bureaucracy; it's the only way to
avoid someone spending an evening on a patch that was never going to be merged. An
unsolicited PR may sit for a long time or be closed without a detailed review, and that's
a worse outcome for you than a two-line issue would have been.

**Scope, plainly:**

| Usually welcome | Maintainer-only |
|---|---|
| Bug fixes with a clear reproduction | Design, layout, motion, and copy |
| Parser repairs when the site's markup changes | Anything touching data collection |
| Documentation corrections | The metrics, counters, and admin surfaces |
| Compatibility fixes | Schema changes and new backend features |

The second column isn't gatekeeping for its own sake. Data collection carries legal
constraints that aren't obvious from the code: the collector is forbidden from making any
network request the user's own browsing didn't already make, and a well-meaning
optimization that fetches one missing field would undo the project's entire posture. See
[DATA-POLICY.md](DATA-POLICY.md). Design is maintainer-only because the bar is specific and
easier to demonstrate than to specify; [CONVENTIONS.md](CONVENTIONS.md) is the attempt to
write it down anyway.

**Read [CONVENTIONS.md](CONVENTIONS.md) before writing code.** It's the house style: code
shape, visual and motion rules, the collection constraints, and a list of gotchas that each
cost a day to discover. A patch that works but violates it will be asked to change.

**Then:** fork, branch from `main`, keep it to one fix per PR, and describe what you
verified and how.

`main` is protected and takes no direct pushes. Every change, including the maintainer's,
arrives as a pull request, and `.github/CODEOWNERS` puts one reviewer on all of them. The
CLA check runs on each PR too. A first-time contributor's workflow run needs manual
approval before it starts, so a pending check on your first PR is normal and not a
failure.

## On AI-assisted contributions

Use whatever tools you like. The requirement is about you, not the tool:

- **Disclose it** in the PR description. A one-liner is fine. It changes how the patch gets
  reviewed, not whether it's welcome.
- **You are the author.** You need to understand every line well enough to explain why it's
  there, what it changes, and what else it touches. If a review question can't be answered,
  the PR gets closed. That isn't a judgment about tooling; unexplainable code can't be
  maintained.
- **Verify it on a real page before submitting.** Generated patches for this project tend
  to fail in a specific way: they look correct, follow the surrounding style, and are wrong
  about something only visible when the extension is loaded and driven. See the checklist
  at the end of [CONVENTIONS.md](CONVENTIONS.md).
- **Don't open a PR you haven't run.** The same line has always applied; it just gets
  crossed more often now.

## Checks

Run these before opening a PR:

```bash
npx tsc --noEmit
```

```bash
cp extension/content.js /tmp/x.js && node --check /tmp/x.js
```

(`background.js` and `config.js` are ES modules, so copy those to `.mjs`; the rest are
classic scripts and `.js` is right. Repeat for each file you touched.) Then load the
extension unpacked and drive the change on a real page.

CI runs the mechanical half on every pull request: `tsc --noEmit`, `node --check` over
each `extension/*.js`, and an esbuild parse of every stylesheet. Run them locally first
anyway. CI tells you a file is broken. Only driving the page tells you the change is
right, and that is what makes it review-ready.

## Running the project

See the [README](README.md) for setup: loading the extension unpacked and starting the
Convex dev backend.

One thing that will otherwise cost you an hour: **after editing a content script or the
manifest, click the reload icon on the Jackdaw card at `chrome://extensions`, and then
refresh the page.** Chrome silently keeps a stale in-memory copy if you skip either step,
so your change appears not to have taken effect. If behaviour looks impossibly old, that's
why.

## Why a CLA?

When you open your first pull request, a bot will comment asking you to sign the
[Contributor License Agreement](CLA.md). It's a one-time thing: reply to the bot's
comment and it remembers you for future PRs. Here's the honest explanation.

Jackdaw is licensed under **AGPL-3.0**, a deliberately strong copyleft licence: anyone who
distributes Jackdaw or runs a modified version as a service has to share their changes
under the same terms. (That covers Jackdaw's own code. The third-party files in
`site/vendor/` keep their own licences; see [LICENSE-EXCEPTIONS.md](LICENSE-EXCEPTIONS.md),
which matters if you ever vendor something new: say so in the PR, and add it to the table in that file
and to `site/vendor/NOTICE.md`.)

The CLA exists for one reason: **it keeps open the option of relicensing or dual-licensing
the project in future**, for example offering the backend under different terms, without
having to track down every past contributor. Without a CLA, relicensing an AGPL project
requires the agreement of everyone who ever contributed a line.

To be fully transparent about what that means: **by signing, you're trusting the project
owner with relicensing rights over your contributions.** Your code in the AGPL version
stays AGPL forever; that can't be taken back from anyone who received it. But the owner
could also offer your contribution under other terms, including proprietary ones, without
asking again or paying you. You keep ownership of your code and can do anything you like
with it elsewhere; the CLA is a licence grant, not a copyright transfer.

If that trade-off doesn't sit right, that's a legitimate position. Bug reports, testing,
and feedback require signing nothing and are worth a great deal.

The full text is in [CLA.md](CLA.md). It's short; please read it.

## Security

Security problems do not go through a pull request or a public issue. Report them
privately, through the repository's *Security* tab or `security@jackdaws.app`, and read
[SECURITY.md](SECURITY.md) first, particularly the request to keep testing off the
production deployment.

## Questions

Open an issue. A slow reply is likely; silence is never deliberate.
