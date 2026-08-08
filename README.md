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

Add an entry to `domains.json`, run `--plan` to check it, then `--apply`.
DNS for the domain still has to be pointed at GitHub Pages separately —
this tool only configures the GitHub side.

## Automation

[`.github/workflows/sync.yml`](.github/workflows/sync.yml) runs `--apply`
weekly, authenticated as the `keepassweb-parked-domain-bot` GitHub App
(installed on the `keepassweb` org with Administration/Contents/Pages
write access). Also runnable manually via Actions → Sync parked domains
→ Run workflow.
