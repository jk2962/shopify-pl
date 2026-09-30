# shopify-pl

A Google Sheet that syncs Shopify orders via GraphQL and shows profit/loss by day, week, month, and year. The owner edits costs in the sheet and P/L recalculates instantly without re-syncing.

## Locked stack
- Google Apps Script (V8, plain JavaScript), deployed with clasp.
- Shopify GraphQL Admin API only.
- Tests: Node's built-in `node:test`.

Read docs/SPEC.md before any feature work.

## Rules
- Pure logic lives in `src/pl.js` and must run in both Node and Apps Script.
- Secrets ONLY in Script Properties — never in sheet cells, code, or the repo.
- The only approved dependency is `@google/clasp` (dev).
- Ask before adding a dependency, running `clasp push`, or touching files outside this repo.
- Run `npm test` before every commit.
- Make one small conventional commit per completed step.
