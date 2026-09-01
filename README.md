# coconut

`coco` — command-line client for the **Coconut Context** HTTP API:
pages, structured metadata, search and metadata queries, typed records,
templates, spaces (export/import), and space agents.

- Built on [`coconut-sdk`](https://github.com/lovelybunch/coconut-sdk) —
  every API call goes through the typed client; the CLI adds auth flows,
  profiles, and terminal UX.
- Node ≥ 20, one runtime dependency beyond the SDK (`commander`).
- The REST contract in
  [`openapi.yaml`](https://github.com/lovelybunch/coconut-sdk/blob/main/openapi.yaml)
  (vendored in the SDK repo) is the source of truth for everything the CLI
  does.

## Install

```bash
npm install -g coconut
coco --help    # `coconut` works too — both names install the same binary
```

## Auth

Two credential types, stored in named **profiles** in
`~/.config/coco/config.json` (`XDG_CONFIG_HOME` respected, file mode `0600`):

```jsonc
{
  "profiles": {
    "<name>": { "baseUrl": "…", "orgSlug": "…", "auth": { /* key or oauth */ } }
  },
  "activeProfile": "<name>"
}
```

### OAuth (interactive humans)

```bash
coco auth login --base-url https://api.example.com
```

Discovers the endpoints from `/.well-known/oauth-authorization-server`,
dynamically registers a client with a loopback redirect URI
(`http://127.0.0.1:<random-port>/callback`, cached per profile), opens your
browser at `/oauth/authorize` (PKCE S256 + `state`), and exchanges the code.
**The browser step needs a signed-in human** — OAuth is the interactive path.
Scopes default to `context:read context:write`; pass `--read-only` for a
`context:read`-only token (writes are then denied with 403 regardless of
role). Access tokens refresh automatically (proactively before expiry, and
once after a 401); rotated tokens are persisted immediately since refresh
tokens are single-use. When refresh fails you get a clear
"run `coco auth login`" message (exit code 4).

### Agent keys (headless: CI, scripts, agents)

```bash
coco auth login --key                    # prompts with echo off
echo "$COCO_KEY" | coco auth login --key # stdin, for scripts
```

Keys look like `coco_...`; the local dev stack seeds
`dev-agent-key-change-me`. The secret is never accepted as an argv argument.

### Endpoint trust rules

The OAuth flow refuses to proceed unless the discovery document's `issuer`
matches the base URL (RFC 8414) and every endpoint is on that same origin —
mix-up protection: the code, PKCE verifier, client secret, and refresh token
are only ever sent to the server you asked to sign in to. Endpoints must be
`https`; plain `http` is allowed only for loopback hosts (localhost dev
stacks). Redirects are never followed on the discovery, registration, or
token requests, and only `http(s)` URLs are ever handed to the system
browser (never through a shell).

### Checking

```bash
coco auth status   # /health + who/what the credential is (secrets redacted)
coco whoami        # just the principal
coco auth logout   # remove the credential, keep the profile
```

### Profiles, flags, environment

```bash
coco profile list | use <name> | remove <name>
```

Every command takes `--profile`, `--base-url`, `--org-slug`, `--json`,
`--quiet`. Precedence: **flags > environment > profile**. Environment
overrides: `COCO_BASE_URL`, `COCO_API_KEY`, `COCO_ORG_SLUG` — so CI needs no
config file at all:

```bash
COCO_BASE_URL=https://api.example.com COCO_API_KEY=$KEY coco spaces list
```

## Output & exit codes

Human-readable tables by default. `--json` prints the raw API payload alone
on stdout (pipe it to `jq`); informational chatter goes to stderr and
`--quiet` silences it. `NO_COLOR` is respected.

| Exit | Meaning |
|---|---|
| 0 | success |
| 1 | unexpected error (incl. a watched agent run that failed) |
| 2 | usage error / invalid input (CLI args or API 400 validation) |
| 3 | could not reach the server |
| 4 | authentication failed (401, no credential, token refresh failed) |
| 5 | not found (404) |
| 6 | conflict — 409, 412 concurrent edit, 428 missing precondition |
| 7 | permission denied (403; `reasonCode` + `nextSteps` are printed) |
| 8 | rate limited (429) |
| 9 | server error (5xx / feature unavailable in this runtime) |

## Command surface

```text
coco spaces   list [--stats] · pages <space> · export <space> [-o f]
              import <space> <bundle.json> [--overwrite] · broken-links <space>
coco page     get <space/path> [--json|--md] [--version N]
              put <space/path> [-f file|-] [--title] [--template] [--metadata k=v…]
                  [--frontmatter json] [--note]
              edit <space/path>            ($EDITOR round-trip, If-Match)
              versions · restore <v> · links · delete (personal/… only)
coco meta     get | patch [--set k=v… --append k=v… --append-unique k=v…] | history
coco search   <query> [--space] [--limit]
coco query    --filter k=v --filter 'score>=0.7' [--space] [--order-by k --desc]
coco records  types <space> · list <space> <type> [--filter…] · create <space> <type> <path>
coco templates list [--space]
coco space-templates list | show <source> <id> | create-space <source> <id> --slug s
coco agent    list · tasks <space> · task get|put <space> <task> · run <space> <task> [--watch]
              runs <space> <task> · run-show <space> <run-id> [--transcript]
              instructions get|set <space> · models
coco personal list | get | put | delete <path>
coco whoami · coco health
```

Filter syntax (`--filter`, AND-ed): `k=v` `k!=v` `k>v` `k>=v` `k<v` `k<=v`
`k~v` (contains) `k:exists` `k:missing`. Values are JSON-parsed when they
look like JSON (`0.7` is a number, `"0.7"` a string, `true` a boolean).
The same rule applies to `--metadata` / `--set` values, and `--set k=null`
deletes a key.

Writes are safe by construction: `page put` / `page edit` read the current
version and send `If-Match`; a concurrent edit surfaces as a clear 412
conflict message (exit 6) instead of a silent overwrite. A leading `---`
block of flat `key: value` lines in content you provide is folded into
title/frontmatter client-side (the REST API stores content verbatim); for
nested structures use `--frontmatter` with one-line JSON.

## A worked session

```bash
# 1. Sign in (headless path shown; `coco auth login` for the browser flow)
echo dev-agent-key-change-me | coco auth login --key --base-url http://localhost:8787
coco auth status

# 2. Author a record type: a template with a metadata schema
coco page put demo/templates/deal-memo --title "Deal memo" \
  --frontmatter '{"description":"Investment memo","defaultPathPrefix":"deals",
    "metadataSchema":{"fields":[
      {"key":"stage","type":"select","options":["sourcing","diligence","closed"],"default":"sourcing","required":true},
      {"key":"conviction-score","type":"number","min":0,"max":1,"default":0.5},
      {"key":"sources","type":"list"}]}}' \
  --file memo-skeleton.md

# 3. Create records — born conforming, schema-validated
coco records create demo deal-memo deals/acme --title "Acme Corp" \
  --metadata stage=diligence --metadata conviction-score=0.82
coco records create demo deal-memo deals/bad --metadata stage=wonn   # → 400, exit 2

# 4. Work the pipeline
coco query --filter stage=diligence --filter 'conviction-score>=0.7' \
  --space demo --order-by conviction-score --desc
coco meta patch demo/deals/acme --set stage=closed \
  --append-unique sources=https://news.example/acme
coco page edit demo/deals/acme          # $EDITOR, saves with If-Match
coco page versions demo/deals/acme

# 5. Move a space around
coco spaces export demo -o demo.json
coco spaces import demo-staging demo.json --overwrite

# 6. Ask the space agent to work
coco agent task put demo daily-digest --title "Daily digest" \
  --schedule "0 7 * * 1-5" --tz UTC --enable --file digest-task.md
coco agent run demo daily-digest --watch
```

## Development

```bash
pnpm install
pnpm build   # tsc → dist/
pnpm test    # vitest (mock-fetch unit tests)
pnpm lint    # typecheck incl. tests
```

To develop against a local checkout of the SDK, `pnpm link ../coconut-sdk`
(then `pnpm install` again to go back to the registry version).

Smoke-test against any Coconut Context deployment (or a local dev stack of
the product):

```bash
echo "$COCO_KEY" | coco auth login --key --base-url https://api.example.com
coco whoami
```

Shell completion is not bundled (commander does not generate it); PRs welcome.

## Releasing

Bump `version` in `package.json` (and the `coconut-sdk` range if the release
needs a newer SDK), commit, tag `vX.Y.Z` (matching), push the tag —
[`release.yml`](.github/workflows/release.yml) builds, tests, and publishes to
npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers)
(OIDC: tokenless, with automatic provenance attestations).

## License

[Apache-2.0](LICENSE) © Coconut AI Inc.
