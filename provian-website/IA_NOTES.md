# Information architecture & cross-link policy

These rules exist because the site once overwhelmed newcomers: too many "front
doors," and cards that each linked elsewhere, so visitors hopped page-to-page
instead of reading a story. Keep them.

## One front door, one path

A cold visitor should travel a single arc, not pick among competing intros:

```
Homepage (/, an argument in three films: To The Stars · Genesis Is Open ·
          Nothing Unwitnessed, then one first step)
  → Start (/start, a person's path in order: one line per step, at most one action)
      → Where to start (the one branch point): Coding and AI on your computer ·
        Connect an AI agent · A wallet you already hold · Every way to earn
  → Vision (the long thesis, /vision) — the manifesto, read top-to-bottom
  → Foundation (Universal Basic Participation, /ubp), reached once
```

- The homepage carries its own first step ("Get the app", with "Connect an agent"
  and "Build on Provian" beside it); everything explanatory is one click down. Its
  body links to neither Start nor Vision; both are in the primary nav.
- **Start** and **Vision** are both primary-nav items, with Start first, so the
  relationship reads "short path, then the full story." They are NOT competing
  front doors: Start's foot links onward to Vision ("Read the full vision"). Vision
  is a read, not a dispatch hub — its hero carries no "ways in" CTAs; its actions
  sit at the page foot (Get the app · Join as an agent · Build an integration).
- Keep **Start short**. It is the path, not a thesis: one line per step, the
  receipt it leaves, and at most one action; the explaining lives on the homepage
  and Vision. No screen-filling glossary: define a term inline the first time the
  narrative uses it; the canonical long-form definitions live in the Library.

## Cross-link policy (every page)

1. **Cards are not links.** A card is explanatory content (title + prose). If an
   action is needed, it's a button *below* the card cluster — never the whole
   tile. The one exception is a deliberate dispatch/index block (Start's "where to
   start" links, the Library index), where routing *is* the job.
2. **≤ 2 contextual in-body links per page**, only for a real scope handoff
   ("the agent controls are the Agents story → see Agents"), never to restate a
   destination the nav/footer already offers.
3. **One "where to next" block at the page foot.** At most ~3 forward links. No
   competing CTA rows, no duplicate CTA pairs higher up.
4. **If it's already in the nav or footer, don't add an in-body link to it**
   unless it's a forward action the chrome can't express ("Set up the desktop app",
   "Get the app", "Prove a wallet and start earning").
5. **Don't guide the reader away mid-narrative.** Other pages elaborate; trust
   them. Let the page tell its story to the end first.

## Navigation

- Primary nav is **four flat items**: Start · Agents · Vision · Foundation. While
  the Genesis window is open a gold **Genesis** item with the days left leads them
  (the header renders it inside GenesisGate, so it removes itself at the close).
  A **"More" dropdown** (MORE_NAV) and the "Get the app" button follow. Keep the
  flat row to those four core path items; new secondary destinations go in the
  "More" dropdown, never as new flat items.
- The **"More" dropdown** is one short list: Atlas, Films, Commons, Library,
  Developers, Gates, FAQ, About.
- The footer is the **full sitemap** in three columns (Participate · Explore ·
  Company). It repeats the primary nav and the "More" dropdown's links, and it is
  the only place in the site chrome for Ways to earn, Desktop app, Blog, Contact,
  For organizations, Collaborate and Support; Privacy and Terms sit beneath it on
  every page. That duplication is fine now that the top row is a clean four + one
  overflow menu — the "don't mirror" rule existed only to stop a 9-item *flat* nav
  being echoed wholesale at the bottom.

Source of truth for nav/footer/routes: `src/lib/routes.ts`.
