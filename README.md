# parked-domain-tools

Reconciles the parked-domain repos in the `keepassweb` org against
[`domains.json`](domains.json). For each listed domain it ensures:

- the repo exists,
- its content matches the
  [`keepass-web/keepass-web.github.io`](https://github.com/keepass-web/keepass-web.github.io)
  template (excluding `CNAME`),
- its `CNAME` file matches the manifest (or is absent, if `cname` is `null`),
- GitHub Pages is enabled, serving from `main`,
- Issues, Wiki, Projects, and Discussions are disabled,
- interactions (opening issues/PRs, commenting) are limited to
  collaborators only.

It never deletes anything. Retiring a domain: remove its entry from
`domains.json`, then `gh repo delete keepassweb/<repo> --yes` yourself.

## Usage

Requires `git`, `gh` (authenticated), and Node.js. No install step.

```
node sync.mjs --plan    # default — show what would change
node sync.mjs --apply   # actually create/update repos
```

## Adding a domain

1. Add an entry to `domains.json`, run `--plan` to check it, then
   `--apply`. Do this before DNS is set up.
2. Point DNS at GitHub Pages (provider-agnostic — set these at whichever
   registrar/DNS host the domain uses):

   | Type | Host | Value |
   |---|---|---|
   | A | `@` | `185.199.108.153` |
   | A | `@` | `185.199.109.153` |
   | A | `@` | `185.199.110.153` |
   | A | `@` | `185.199.111.153` |
   | AAAA | `@` | `2606:50c0:8000::153` |
   | AAAA | `@` | `2606:50c0:8001::153` |
   | AAAA | `@` | `2606:50c0:8002::153` |
   | AAAA | `@` | `2606:50c0:8003::153` |
   | CNAME | `www` | `keepassweb.github.io` |

   `sync.mjs` reports DNS status (apex and `www`) until this resolves.
3. Once DNS resolves, verify the domain: repo → Settings → Pages →
   Verify, using the TXT record challenge GitHub gives you. Required per
   domain, not org-wide. `sync.mjs` reports verification status but can't
   perform this step.

## Automation

[`.github/workflows/sync.yml`](.github/workflows/sync.yml) runs `--apply`
weekly, authenticated as the `keepassweb-parked-domain-bot` GitHub App
(installed on the `keepassweb` org with Administration/Contents/Pages
write access). Also runnable manually via Actions → Sync parked domains
→ Run workflow.
