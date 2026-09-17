// The whole API is one Vercel Function. vercel.json sends every /api path
// here; `pnpm build` produces the bundle this file loads.
export { default } from '../apps/api/dist/vercel.mjs'
