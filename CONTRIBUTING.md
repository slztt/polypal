# Contributing to PolyPal

Thanks for wanting to help out! You don't need write access to the repository to
pick up a ticket, work on it, and ship a fix — here's how the flow works.

## Finding something to work on

- Browse [open issues](https://github.com/slztt/polypal/issues).
- Issues labeled `good first issue` are a good place to start if you're new to
  the codebase. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for an architecture overview.

## Claiming a ticket

Comment on the issue you want to work on so others know it's taken.

## Submitting your work

1. **Fork** the repository and create a branch for your change.
2. Make your change. Keep it focused — one issue, one PR.
3. Run the checks locally before opening a PR:
   ```bash
   npm run lint
   npm run test
   ```
4. Open a **pull request** against `dev`. Include `Closes #<issue-number>` in
   the PR description so it's linked to the ticket and closes it automatically
   on merge.

Opening a PR from your fork moves the linked issue to **Ready to review** on
the board. Once a maintainer approves the review, it moves to **Ready to
test**; once merged, it moves to **Done**.

## Getting help

If something in an issue is unclear, ask in a comment on the issue itself
before starting — it's cheaper to clarify scope up front than to redo work
later.
