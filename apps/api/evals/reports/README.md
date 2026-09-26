# Eval reports

Each run of `pnpm --filter @erp/api eval` writes two files here:
`<start time>-<model>.json` for comparing runs and `.md` for reading.
They hold the answers the assistant gave about the seeded Sunrise school,
which is made-up data. The files are not committed; keep the ones you need
for a release decision with that decision.

See [docs/assistant/EVALS.md](../../../../docs/assistant/EVALS.md).
