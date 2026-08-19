<!-- Hand-written for this project. See the warning below before running `21st init --design-context --refresh`. -->
# Project Design Context

Design context for **quartzmolle.dk** — a Danish stone-ground flour mill webshop.

> **Do not run `21st init --design-context --refresh`.**
> The scanner looks for React / Tailwind / shadcn projects. This site is plain
> HTML, CSS and browser JS with no `package.json`, so a refresh detects nothing
> and overwrites both files in this folder with an empty context. Everything
> below was written by hand from `css/style.css` and is the useful version.
> Edit these files directly instead.

## Project

- Name: quartzmolle
- Product type: E-commerce (single-page product catalogue + Stripe hosted checkout)
- Stack: HTML, CSS, vanilla JS — no build step, no framework, no npm dependencies
- Color mode: light
- Density: comfortable

## Tokens

Source of truth: the `:root` block in `css/style.css`.

| Token | Value |
| --- | --- |
| `--cream` | `#faf7f2` |
| `--warm-white` | `#f5f0e8` |
| `--brand-blue` | `#273071` |
| `--brand-blue-dark` | `#1b2252` |
| `--brand-blue-light` | `#3a4599` |
| `--brand-blue-softbg` | `rgba(39, 48, 113, 0.08)` |
| `--text` | `#1a1611` |
| `--dark` | `#000000` |
| `--nav-h` | `72px` |

- Type: `'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif`
- Radii: 6px / 12px / 16px, `999px` pills, `50%` circles
- Motion: sheets `cubic-bezier(0.32, 0.72, 0, 1)` at `0.4s`; general
  `cubic-bezier(0.23, 1, 0.32, 1)`; presses `scale(0.97)` over `140ms`;
  popovers spring on `cubic-bezier(0.34, 1.56, 0.64, 1)`

## Patterns already in the codebase

- Product card with quick-add popover (`.qa-btn` / `.qa-pop`)
- Slide-in cart drawer (`.cart-drawer` / `.cart-panel`)
- Accordion via `grid-template-rows: 0fr -> 1fr`
- Full-screen brand loader before the Stripe redirect

## Constraints

### Must

- Plain HTML, CSS and browser JS only — there is no build step and no `package.json`
- Add styles to `css/style.css`; it is the single stylesheet and the agreed base
- Danish is the source language; new user-facing strings go in `js/i18n.js` (EN + ES)
- Mobile-first — most visitors and the owner are on iPhone
- Touch targets at least 44px; keyboard focus visible via `:focus-visible`
- Guard every animation with `prefers-reduced-motion`

### Avoid

- React, JSX, Tailwind, shadcn or any framework output
- npm dependencies, bundlers, CDN scripts or external stylesheets
- New fonts or new colour palettes — the palette above is fixed
- Layout overhauls or redesigns; changes stay polish-level
- Hover-only affordances that stick after a tap on touch devices

## Decisions

- The cream + brand-blue palette comes from the printed flour label artwork and is not up for redesign
- The cart drawer uses `visibility` (not `display: none`) so its slide animation can run
- Closing the cart reloads only on the homepage, where the fixed video stage causes iOS render artifacts
