# 21st.dev CLI in this project

## Install

```bash
npm i -g @21st-dev/cli
```

## Auth

Three ways, in the order the CLI checks them:

1. `21st login` — opens a browser and saves a token in your home directory
   (not in this repo). Use this on your own machine.
2. `TWENTYFIRST_TOKEN` or `API_KEY_21ST` environment variable.
3. `--api-key <key>` on any command.

For CI and scripts, skip the browser login entirely:

```bash
export API_KEY_21ST="…"        # store as a secret, never commit it
21st search "product card" --json

# or per command
21st search "product card" --api-key "$API_KEY_21ST" --json
```

Get a key at https://21st.dev/mcp — keys and tokens must never be committed.

## Commands that need no login

`21st logo <query>` (brand/UI SVG search) and `21st init --design-context` both
work signed out. Everything else — `search`, `get`, `generate`, `publish` — needs auth.

## Design context

`design.json` + `DESIGN.md` in this folder describe the site's palette, motion
and hard constraints so generated UI matches the real design.

**Do not run `21st init --design-context --refresh`.** The scanner expects a
React/Tailwind project; here it detects nothing and overwrites both files with
an empty context. They are hand-written — edit them directly.

## Fit warning

21st.dev produces React + Tailwind (shadcn) components. This site is plain
HTML/CSS/JS with no build step, so nothing can be dropped in as-is — any
component has to be rewritten as markup plus rules in `css/style.css`. The CLI
is most useful here for `21st logo`, browsing patterns for inspiration, and
`21st review` for local UI linting.
