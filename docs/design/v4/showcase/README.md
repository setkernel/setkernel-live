# Live v4 prototype: the showcase

The prototype for setkernel-live#52. It makes live.setkernel.com the page that wins customers: a
visitor sees the team working now, learns how a change gets from an idea to production, sees the
numbers, reads an example daily brief, and books a live demo. Day (setkernel-live#48) stays the
base. This is a prototype: nothing under `public/` changes until Raghav picks a direction from
these screenshots.

**To open it,** double-click `index.html`. It is one file, with the fonts, the publisher and the
evidence embedded, and it needs no server and no network. The dark strip at the top is the
prototype's switcher and is not part of the design. It switches between the page and demo mode.

| Page, 1440×900 | Page, 2560×1440 |
|---|---|
| ![page 1440](page-1440x900.png) | ![page 2560](page-2560x1440.png) |

| Page, 1440, full | Phone, 375×812 | Phone, 375, full |
|---|---|---|
| ![page 1440 full](page-1440-full.png) | ![page 375](page-375x812.png) | ![page 375 full](page-375-full.png) |

| Step 1: the idea | Step 2: the charter | Step 3: the build |
|---|---|---|
| ![step 1](step-1-1440.png) | ![step 2](step-2-1440.png) | ![step 3](step-3-1440.png) |

| Step 4: the evidence | Step 5: the review | Step 6: the merge |
|---|---|---|
| ![step 4](step-4-1440.png) | ![step 5](step-5-1440.png) | ![step 6](step-6-1440.png) |

| Step 7: checked in production | Step 5, phone | Step 4, 2560 |
|---|---|---|
| ![step 7](step-7-1440.png) | ![step 5 phone](step-5-375.png) | ![step 4 2560](step-4-2560.png) |

| The numbers, 1440 | The daily brief, 1440 |
|---|---|
| ![numbers](numbers-1440.png) | ![brief](brief-1440.png) |

| Demo mode, 1440×900 | Demo mode, step 5 | Demo mode, another repo |
|---|---|---|
| ![demo](demo-1440x900.png) | ![demo step 5](demo-step5-1440x900.png) | ![demo other](demo-other-repo-1440x900.png) |

| Demo mode, 2560×1440 | Demo mode, phone |
|---|---|
| ![demo 2560](demo-2560x1440.png) | ![demo 375](demo-375x812.png) |

| The live view at 1440 (the wall, edge to edge) | At 1024 (Day's page layout) | At 375 |
|---|---|---|
| ![live 1440](live-1440.png) | ![live 1024](live-1024.png) | ![live 375](live-375.png) |

## The page, top to bottom
1. **The promise.** One sentence, a paragraph on how the team works, "Book a live demo", and three
   real numbers under it.
2. **The team, right now.** This is the Day prototype (`docs/design/v3/day/index.html`), unchanged, in a
   frame. At 1440 px and wider, the frame is the wall, edge to edge: the 1440×810 canvas at a
   scale of 1 or more, so nothing in it is under 12 px. Narrower than that, the wall would shrink
   the 12 px axis, so the frame shows Day's own page layout instead. Below 720 px it shows Day's
   phone layout, cut to 720 px tall, with "Show the whole day".
3. **How it works.** Seven steps, one per screen: the idea, the charter, the build, the evidence,
   the independent review, the merge, and the check in production. The example is one real
   change in a public repo, the Day build (setkernel-live, issue 48 and its pull request), and
   each step links its public record. On the right of each step is a redacted copy of the real
   artefact: the issue's lines and its acceptance criteria as bars, the checks, the review log,
   the time from opened to merged, the deploy's checks. You can click the steps or use ← → Home End.
4. **The numbers.** Throughput, lead time, pass rate, revert rate and time to recover, for the
   whole team, computed by `teamNumbers()` over the public repos for 30 days.
5. **The daily brief.** An example email, written by hand, with the client's details redacted.
6. **Book a live demo,** and the footer: what the page never shows, and the way into demo mode.

## Demo mode (for a call)
The "Demo mode" button in the footer, or `#view=demo`, opens a full-screen dialog with the same
seven steps, one size larger, for a shared screen. It has:
- **a list** of six real public pull requests, built in: the walkthrough's example, its prototype,
  and the newest merged one in each other public repo;
- **any public pull request:** paste a link or `repo#number`. The browser asks GitHub's API
  without a token, so only public repos answer. The same `publishEvidence` the build uses then
  checks it again, and refuses anything else. This is the one place the prototype uses the network.
  In the build it would be a Worker route (see the open questions);
- **keys:** ← and → move between steps, and Esc leaves.

## Privacy, in code
`src/evidence.js` is the publisher. It is an allowlist: every field it returns is built by a rule
from GitHub's REST shapes, and nothing else passes. It is tested in `test/evidence.test.mjs`.
- **Repos:** only one of setkernel's public repos (`private: false`, visibility public, owner
  setkernel). An issue is followed only in the same repo, so "Closes setkernel/hq#…" is never
  fetched or shown. `fetchEvidence` asks nothing more about a private repo.
- **People:** star names only (`<star>-setkernel` logins). Anyone else is "a person", and a bot
  is "automation". No login reaches the page.
- **Text:** none. Titles, bodies, commit messages, branches, file paths and code are read only to
  count things (words, acceptance criteria, screenshots, test files, reviewer blockers). The
  output also passes `guard()`, the page's NEVER list.
- **Security:** a pull request labelled `security` (on it or its issue) is withheld until 24
  hours after it merges. An unmerged one is never shown.
- **Numbers:** team totals only, never per person. Titles are read only to count reverts.
- **The CI test** `test/private-repos.test.mjs` lists setkernel's public repos live from the
  GitHub API. Every repo named by the demo data, by `evidence.json` and by the page's and the
  showcase's links must be on that list. It needs no token, so it runs on fork pull requests too.
  With `SETKERNEL_REPO_TOKEN` it also searches the same text for every private name.

## Open questions for Raghav
1. **Links with numbers.** The page never shows issue or pull request numbers or titles, but the
   steps link the public pull request, and its URL has the number in it. The link text names no
   number. Is a link to a public record acceptable?
2. **Public text.** The steps show the issue's lines as bars, even though the issue is public.
   Should a hand-picked example quote a reviewed line of the real text?
3. **"A second model."** Step 5 says the review comes from a second model, as the spec does. The
   GitHub data can't show which model reviewed. Is it true of every pull request?
4. **The numbers count public repos only** (6 repos, 44 merges in the 30 days to 15 October).
   Client work is private and counts nowhere. Should the publisher (hq) send team totals from
   private repos too? That is another rule on both sides of the allowlist. Time to recover rests
   on a single recovery so far.
5. **"Book a live demo" goes nowhere yet.** The choices are a booking link, a form or an email
   address. A form or an external booking host would change the CSP.
6. **Demo mode in the build** can't call api.github.com from the page, because the CSP allows only
   'self'. It would be a Worker route (`/api/evidence?pr=repo#n`) running the same `fetchEvidence`
   and `publishEvidence`, with a token that can read public repos and a cache.
7. **Day at 1024.** In the page-layout frame at 1024 (926 px wide), Day's axis labels "00:00 ADT"
   and "16:40" overlap. This is Day's own layout at that width, which this prototype does not change.
8. **Fonts:** this keeps Day's two Google Fonts families, Manrope and IBM Plex Mono, self-hosted
   from `public/fonts/`, with only weights 400 and 600. No new family was added.

## Build and shots
```sh
node docs/design/v4/showcase/build.mjs            # rebuild index.html from evidence.json
node docs/design/v4/showcase/build.mjs --fetch    # first refresh evidence.json from GitHub (gh api)
npm i --prefix "$TMPDIR/pw" playwright && npx --prefix "$TMPDIR/pw" playwright install chromium
PLAYWRIGHT_DIR="$TMPDIR/pw" node docs/design/v4/showcase/shoot.mjs   # retake every PNG, in Halifax time
```
`shoot.mjs` fails if the page throws, if it makes any request that isn't to `file:` or `data:`, if
it scrolls sideways, or if any visible text is under 12 px. The Day frame's clock is v3's: Wednesday
14 October 2026, 16:40 ADT, on sample data. The evidence and the numbers are real, as of `evidence.json`'s
`asOf`.
