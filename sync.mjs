#!/usr/bin/env node
// Reconciles the parked-domain repos in the keepassweb org against
// domains.json. For each entry, ensures the repo exists, its content
// matches the keepass-web/keepass-web.github.io template (excluding
// CNAME), its CNAME matches the manifest, and GitHub Pages is enabled.
// DNS and domain verification are reported but never written — see the
// comment above GITHUB_PAGES_A below for why, and README.md for the
// manual steps.
//
// Never deletes anything. Retiring a domain: remove its entry from
// domains.json, then `gh repo delete keepassweb/<repo> --yes` yourself.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, copyFileSync, writeFileSync } from "node:fs";
import { resolve4, resolve6 } from "node:dns/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

const ORG = "keepassweb";
const TEMPLATE_REPO = "keepass-web/keepass-web.github.io";
const BRANCH = "main";

// DNS and domain verification are both out of scope for automation (see
// README) — Namecheap's API requires IP-whitelisting incompatible with
// GitHub-hosted runners, and GitHub has no API for domain verification
// at all (confirmed unavailable as of a 2022 community request that's
// still open). Both are checked read-only and reported; neither is ever
// written by this script.
const GITHUB_PAGES_A = ["185.199.108.153", "185.199.109.153", "185.199.110.153", "185.199.111.153"];
const GITHUB_PAGES_AAAA = [
  "2606:50c0:8000::153",
  "2606:50c0:8001::153",
  "2606:50c0:8002::153",
  "2606:50c0:8003::153",
];

// Issues/Wiki/Projects/Discussions can be fully disabled via the API.
const LOCKED_SETTINGS = { has_issues: false, has_wiki: false, has_projects: false, has_discussions: false };

// Pull requests (and issues/comments, redundantly with the above) from
// non-collaborators are blocked via interaction limits, not a plain
// repo setting — allow_forking:false (the more obvious lever) is
// rejected by the API for public repos, which these have to stay for
// free Pages hosting. Unlike LOCKED_SETTINGS, this expires — the API
// requires an expiry and six_months is the longest option, so it's
// refreshed on every reconcile run rather than set once.
const INTERACTION_LIMIT = "collaborators_only";
const INTERACTION_LIMIT_EXPIRY = "six_months";
const INTERACTION_LIMIT_REFRESH_MARGIN_DAYS = 30;

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const unknown = args.filter((a) => a !== "--apply" && a !== "--plan");
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(" ")}`);
  console.error("Usage: node sync.mjs [--plan|--apply]");
  process.exit(1);
}
console.log(apply ? "Mode: apply\n" : "Mode: plan (dry run — pass --apply to make changes)\n");

function run(cmd, cmdArgs, opts = {}) {
  return execFileSync(cmd, cmdArgs, { encoding: "utf8", ...opts });
}

function tryRun(cmd, cmdArgs, opts = {}) {
  try {
    return { ok: true, output: run(cmd, cmdArgs, opts) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

const repoExists = (org, repo) => tryRun("gh", ["repo", "view", `${org}/${repo}`, "--json", "name"]).ok;

function pagesConfig(org, repo) {
  const result = tryRun("gh", ["api", `repos/${org}/${repo}/pages`]);
  return result.ok ? JSON.parse(result.output) : null;
}

async function dnsStatus(domain) {
  const [a, aaaa] = await Promise.all([resolve4(domain).catch(() => []), resolve6(domain).catch(() => [])]);
  if (GITHUB_PAGES_A.every((ip) => a.includes(ip))) return "OK";
  if (a.length > 0) return `WRONG — resolves to ${a.join(", ")}, not GitHub Pages`;
  return "NOT CONFIGURED";
}

function verificationStatus(pages) {
  if (!pages) return "N/A — Pages not configured yet";
  switch (pages.protected_domain_state) {
    case "verified":
      return "verified";
    case "pending":
      return "pending — TXT record not yet detected";
    default:
      return "NOT VERIFIED";
  }
}

function currentSettings(org, repo) {
  const result = tryRun("gh", ["api", `repos/${org}/${repo}`]);
  return result.ok ? JSON.parse(result.output) : null;
}

const settingsLocked = (settings) =>
  Object.entries(LOCKED_SETTINGS).every(([key, value]) => settings?.[key] === value);

function interactionLimitNeedsRefresh(org, repo) {
  const result = tryRun("gh", ["api", `repos/${org}/${repo}/interaction-limits`]);
  if (!result.ok) return true;
  const current = JSON.parse(result.output);
  if (current.limit !== INTERACTION_LIMIT) return true;
  if (!current.expires_at) return true;
  const marginMs = INTERACTION_LIMIT_REFRESH_MARGIN_DAYS * 24 * 60 * 60 * 1000;
  return new Date(current.expires_at).getTime() - Date.now() < marginMs;
}

const listTrackedFiles = (dir) => run("git", ["-C", dir, "ls-files"]).trim().split("\n").filter(Boolean);

function cloneTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "pdt-template-"));
  run("git", ["clone", "--quiet", "--depth", "1", "--branch", BRANCH, `https://github.com/${TEMPLATE_REPO}.git`, dir]);
  return { dir, files: listTrackedFiles(dir).filter((f) => f !== "CNAME") };
}

function cloneTarget(org, repo) {
  const dir = mkdtempSync(join(tmpdir(), "pdt-target-"));
  run("git", ["clone", "--quiet", `https://github.com/${org}/${repo}.git`, dir]);
  run("git", ["-C", dir, "checkout", "--quiet", "-B", BRANCH]);
  return dir;
}

function copyIntoTarget(templateDir, targetDir, relPath) {
  const dest = join(targetDir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(join(templateDir, relPath), dest);
}

async function reconcileOne(entry, template) {
  const { repo, cname } = entry;
  const label = cname ?? repo;
  const actions = [];

  if (cname) {
    console.log(`${label}: DNS ${await dnsStatus(cname)}`);
  }

  if (!repoExists(ORG, repo)) {
    actions.push("create repo");
    if (apply) {
      run("gh", ["repo", "create", `${ORG}/${repo}`, "--public", "--description", "Parked GitHub Pages site — see keepass-web.app"]);
    } else {
      console.log(`${label}: would create repo, lock down settings, configure Pages, and push initial content\n`);
      return { repo, status: "would-create" };
    }
  }

  let targetDir;
  try {
    targetDir = cloneTarget(ORG, repo);

    for (const existing of listTrackedFiles(targetDir)) {
      rmSync(join(targetDir, existing));
    }
    for (const file of template.files) {
      copyIntoTarget(template.dir, targetDir, file);
    }
    if (cname) {
      writeFileSync(join(targetDir, "CNAME"), `${cname}\n`);
    }

    run("git", ["-C", targetDir, "add", "-A"]);
    const contentChanged = !tryRun("git", ["-C", targetDir, "diff", "--cached", "--quiet"]).ok;

    if (contentChanged) {
      actions.push("sync content");
      if (apply) {
        run("git", ["-C", targetDir, "commit", "--quiet", "-m", "Sync parked-domain page from template"]);
        run("git", ["-C", targetDir, "push", "--quiet", "-u", "origin", BRANCH]);
      }
    }

    const pages = pagesConfig(ORG, repo);
    if (cname) {
      console.log(`${label}: domain verification ${verificationStatus(pages)}`);
    }

    if (!pages) {
      actions.push("enable Pages");
      if (apply) {
        run("gh", ["api", "-X", "POST", `repos/${ORG}/${repo}/pages`, "--input", "-"], {
          input: JSON.stringify({ build_type: "legacy", source: { branch: BRANCH, path: "/" } }),
        });
      }
    }

    if (!settingsLocked(currentSettings(ORG, repo))) {
      actions.push("lock down settings (no issues/wiki/projects/discussions)");
      if (apply) {
        run("gh", ["api", "-X", "PATCH", `repos/${ORG}/${repo}`, "--input", "-"], {
          input: JSON.stringify(LOCKED_SETTINGS),
        });
      }
    }

    if (interactionLimitNeedsRefresh(ORG, repo)) {
      actions.push("refresh collaborators-only interaction limit");
      if (apply) {
        run("gh", ["api", "-X", "PUT", `repos/${ORG}/${repo}/interaction-limits`, "--input", "-"], {
          input: JSON.stringify({ limit: INTERACTION_LIMIT, expiry: INTERACTION_LIMIT_EXPIRY }),
        });
      }
    }
  } finally {
    if (targetDir) rmSync(targetDir, { recursive: true, force: true });
  }

  if (actions.length === 0) {
    console.log(`${label}: up to date\n`);
    return { repo, status: "unchanged" };
  }
  console.log(`${label}: ${apply ? "" : "would "}${actions.join(", ")}\n`);
  return { repo, status: apply ? "updated" : "would-update" };
}

const manifest = JSON.parse(readFileSync(new URL("./domains.json", import.meta.url), "utf8"));
const template = cloneTemplate();

const results = [];
try {
  for (const entry of manifest.domains) {
    try {
      results.push(await reconcileOne(entry, template));
    } catch (err) {
      console.error(`${entry.repo}: FAILED — ${err.message}\n`);
      results.push({ repo: entry.repo, status: "failed" });
    }
  }
} finally {
  rmSync(template.dir, { recursive: true, force: true });
}

console.log("Summary:");
for (const r of results) console.log(`  ${r.repo}: ${r.status}`);

if (results.some((r) => r.status === "failed")) process.exitCode = 1;
