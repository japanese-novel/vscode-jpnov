# jpnov.com

The product site for the Japanese Novel extension: Astro + Tailwind CSS 4 + GSAP, Japanese only,
built as a check by `.github/workflows/website.yml` and deployed to GitHub Pages only for a
release tag or a manual run.

Prerequisites: Node 24 (`nvm use` at the repository root) and a root `npm ci`. The site renders
its manuscript samples through the extension's own compiler, which needs the root's generated
modules, and it lints with the root's ESLint and TypeScript install in the house config
(`eslint.house.mjs`, `tsconfig.base.json`). The packages the site shares with the root are kept
in lockstep by `test/deps.test.ts`; the README specimens it renders live in `docs/specimens/`.

```sh
cd website
npm ci
npm run dev       # local server
npm run verify    # astro check + eslint + tests + build
npm run fonts     # regenerate the committed Noto Serif JP subset after copy changes
```
