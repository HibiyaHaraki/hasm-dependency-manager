# HASM dependency manager

Coordinates submodule update pull requests across the HASM repositories.
**Merging is always manual. CI success is not compatibility approval.**

## Dependencies

This repository has **no Git submodules and no third-party npm dependencies**.
It requires Node.js 24+, GitHub Actions, and a GitHub App installed on the eight
repositories below. [repositories.json](repositories.json) is the explicit
allowlist; it is verified against each repository's actual `.gitmodules`,
gitlinks, and default branch on every run.

| Repository | Default branch | Direct Git-submodule dependencies |
| --- | --- | --- |
| [hasm_color_pattern](https://github.com/HibiyaHaraki/hasm_color_pattern) | `master` | `hasm_logger` |
| [hasm_logger](https://github.com/HibiyaHaraki/hasm_logger) | `master` | None |
| [hasm_visualizer](https://github.com/HibiyaHaraki/hasm_visualizer) | `main` | None; runtime sibling imports require `hasm_color_pattern` and `hasm_logger` |
| [hasm_logo](https://github.com/HibiyaHaraki/hasm_logo) | `master` | `hasm_color_pattern` |
| [hasm_example_generator](https://github.com/HibiyaHaraki/hasm_example_generator) | `master` | `hasm_logger` |
| [hasm_markdown](https://github.com/HibiyaHaraki/hasm_markdown) | `main` | `hasm_logger` (two paths), `hasm_color_pattern`, `hasm_logo` |
| [hasm](https://github.com/HibiyaHaraki/hasm) | `master` | `hasm_logger` (two paths), `hasm_color_pattern`, `hasm_markdown`, `hasm_logo`, `hasm_visualizer` |
| [hasm-top](https://github.com/HibiyaHaraki/hasm-top) | `master` | `hasm`, `hasm_markdown`, `hasm_logo`, `hasm_logger`, `hasm_color_pattern`, `hasm_visualizer` |

## How it works

1. Capture the merged heads of the configured default branches. Unmerged
   upstream PR commits are never used as update targets.
2. Process dependencies before their consumers. For each changed **direct path**,
   create a separate commit containing only that gitlink, on one update branch
   per repository. Existing update branches receive additional commits without
   force-pushing or replacing human commits.
3. Open a draft PR, or update the existing PR, with direct commit links, nested
   reference mismatches, and links to the prerequisite PRs that need manual merges.
4. Publish the App-owned `dependency-ready` check on the exact PR head. It fails
   until all direct and recursive pointers agree with the captured merged heads.
   Application-code changes on an automatic branch also fail the check. Repeated
   runs reuse an unchanged result instead of publishing duplicate check runs.
5. After a prerequisite is manually merged, a subsequent run appends the
   consumer's gitlink update, refreshes its body and check, and marks it ready
   only when the prerequisite references are aligned. A human reviews and merges.

For example, `hasm-top` can contain one commit updating its direct `hasm_logo`
and another updating `hasm` after the latter's `hasm_logo` update is merged.
The nested pointer itself must first be committed and merged in `hasm`.

The branch prefix `hasm/dependency-updates/` is reserved for this automation.
Normal PRs receive a successful `dependency-ready` check without having their
body, code, or draft status changed: their compatibility remains a human decision.
Do not move automatic updates to a normal branch to evade the dependency gate.

### Waiting, rejection and conflicts

- If only nested dependencies need updates and there is **no direct gitlink
  difference yet**, GitHub cannot create a useful PR. The workflow summary lists
  the waiting repository; its PR is created after a prerequisite merge produces
  a direct difference.
- Closing an automatic PR without merging suppresses that exact base/target
  update. New base or target commits can produce a new proposal. Reopen the
  rejected PR to resume the existing update.
- An orphan branch left by an interrupted PR creation is not overwritten.
  Inspect it and either open its PR manually or remove that specific remote
  branch before retrying.
- Human code edits, unknown submodules, changed default branches, truncated
  API responses and API errors stop the affected operation explicitly. The
  manager does not silently repair configuration or rebase/resolve conflicts.
  Resolve base-branch conflicts manually using gitlink-only commits, or close
  the PR and prepare a fresh update after changing the base.
- Generated artwork, copied design files, package locks and other derived files
  are **not** regenerated or committed here. If an update requires those changes
  or consumer-code changes, handle it in a separate human-owned PR.

## GitHub setup (required before merge blocking is effective)

Local files do not create an App, install secrets, or enable branch protection.
No target-repository workflow files are needed: the manager's App publishes
checks directly to PR heads in all eight repositories.

### 1. Publish the manager

Create the **public** repository `HibiyaHaraki/hasm-dependency-manager` with default
branch `main`, then commit and push this directory. Enable GitHub Actions.
Review and commit the dependency documentation in each other repository separately.
Keep credentials out of Git and out of chat.

The synchronization workflow supports:

- scheduled execution every 10 minutes;
- manual `workflow_dispatch` (defaults to **dry run**; uncheck to apply);
- `repository_dispatch` with type `hasm-dependency-refresh` for an external,
  authenticated webhook service if faster refresh is needed.

Only trusted changes on the manager's default branch should run synchronization.
Its CI runs on Windows and Linux and does not require an App token.
Protect the manager's `main` branch with human-reviewed PRs and its CI check,
and restrict workflow dispatch and App-secret access to trusted maintainers.

### 2. Create and install a GitHub App

Create a GitHub App in your GitHub developer settings. Grant repository permissions:

| Permission | Level | Purpose |
| --- | --- | --- |
| Metadata | Read | Repository identity and default branch |
| Contents | Read and write | Git trees, single-gitlink commits and update refs |
| Pull requests | Read and write | Draft PRs, prerequisite links and readiness |
| Checks | Read and write | App-owned `dependency-ready` results |

No Administration permission is needed. No webhook subscription is required
for polling. Install the App on **all eight HASM repositories** in the table.
Keep installation access limited to those repositories. The manager need not
be part of the installation unless an external service will dispatch to it.

In **the manager repository only**, set:

- Actions variable `HASM_DEPENDENCY_APP_ID`: the App ID (not installation ID).
- Actions secret `HASM_DEPENDENCY_APP_PRIVATE_KEY`: the generated private key.

The workflow uses `actions/create-github-app-token` to obtain a short-lived
installation token. No long-lived PAT or private key is copied into consumers.
The App never calls a merge endpoint or enables automatic merging.

### 3. Run a preview, then publish checks

First run `HASM dependency updates` manually with `dry_run=true`. Inspect its
summary and repository mappings. Then run it with `dry_run=false` to create
proposals and publish the first `dependency-ready` checks.

New ordinary PRs also receive the check during polling. This avoids blocking
normal development forever when the check is required on the entire branch.

### 4. Protect every default branch

For each of the eight repositories, configure an **active Ruleset** targeting
the exact default branch in the table (or equivalent branch-protection rules):

1. Require changes through pull requests.
2. Require at least **one human approval**, dismiss stale approvals when commits
   are pushed, and require approval of the most recent reviewable push.
3. Require the status check named **`dependency-ready`**.
4. Bind its expected source to **your dependency GitHub App**, not "any source"
   and not GitHub Actions. Use the App's integration/App ID when configuring via
   the REST rules API; the App ID is the same as `HASM_DEPENDENCY_APP_ID`.
5. Retain existing required CI checks. They are additional evidence, not a
   substitute for human approval.
6. Require the PR branch to be up to date before merging.
7. Do not grant bypass permissions, including administrator bypasses. Disallow
   force pushes to the protected default branch. Leave merge queues disabled
   unless checks are separately implemented for merge-group heads.
8. Leave automatic merging disabled in repository settings.

Required checks are available for selection after they have been published.
If the UI cannot bind the check to the App, use the repository rules API or
branch-protection API with the expected App ID; do not accept an unbound check.
These are GitHub-side changes to be reviewed and applied by an administrator.

**Acceptance check:** while an upstream dependency PR remains unmerged, manually
mark its consumer PR ready. Confirm GitHub still refuses the merge because the
App-owned `dependency-ready` check fails. After the upstream merge and refresh,
confirm the consumer PR contains the actual merged SHA and still requires
human approval. Also verify that a same-named check from another App cannot
satisfy the protection rule.

### Operational limits

Polling is eventually consistent, not a cross-repository transaction. GitHub
schedules may be delayed; new PRs can wait longer than ten minutes for a check.
On inactive public repositories GitHub can disable scheduled workflows; monitor
and re-enable them. If the App/workflow is unavailable, missing or in-progress
required checks block new unverified heads; old successful checks are not
automatically revoked outside a run.

A successful check certifies the **captured merged commit set**, not perpetual
tracking of the latest future upstream commit and not functional compatibility.
An upstream commit arriving later is considered on the next run. GitHub rules
are essential; draft status and PR checklists alone cannot enforce this policy.
Neither code nor polling can prevent an administrator from disabling the rule
or guarantee atomic readiness against simultaneous updates in different repos.

## Local validation

No dependency installation is needed:

```powershell
node --test
node scripts/run.mjs --dry-run
```

The dry run is strictly read-only and can inspect these public repositories
without a token, subject to GitHub's anonymous rate limit. For a larger preview,
provide `GH_TOKEN` through your local secure environment. For actual updates it
must be a GitHub App installation token with the permissions above.

Tests cover duplicate paths as separate commits, nested prerequisite merges,
one accumulating PR, rejection, idempotence, draft bypass attempts, human edits,
API failures, pagination and read-only execution.
