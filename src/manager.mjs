import { createHash } from 'node:crypto';

export const BRANCH_PREFIX = 'hasm/dependency-updates/';
export const CHECK_NAME = 'dependency-ready';
const CHECK_EXTERNAL_ID = 'hasm-dependency-manager:dependency-ready';

export function orderRepositories(config) {
  if (!/^[A-Za-z0-9-]+$/.test(config.owner)) throw new Error('Invalid repository owner.');
  const order = [];
  const active = new Set();
  const done = new Set();
  function visit(name) {
    if (done.has(name)) return;
    if (active.has(name)) throw new Error(`Dependency cycle at ${name}.`);
    const repo = config.repositories[name];
    if (!repo || !/^[A-Za-z0-9_.-]+$/.test(name)) {
      throw new Error(`Unknown or invalid repository: ${name}.`);
    }
    if (!repo.branch || !repo.submodules) throw new Error(`Incomplete configuration for ${name}.`);
    active.add(name);
    for (const [path, dependency] of Object.entries(repo.submodules)) {
      if (!path || path.startsWith('/') || path.includes('\\')
        || path.split('/').some((part) => !part || part === '.' || part === '..')) {
        throw new Error(`Unsafe submodule path: ${name}:${path}.`);
      }
      visit(dependency);
    }
    active.delete(name);
    done.add(name);
    order.push(name);
  }
  for (const name of Object.keys(config.repositories)) visit(name);
  return order;
}

export function parseGitmodules(text, owner) {
  const modules = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (/^\[submodule "[^"]+"\]$/.test(line)) {
      current = {};
      modules.push(current);
      continue;
    }
    const match = /^([a-zA-Z]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!current || !match) throw new Error(`Unsupported .gitmodules line: ${line}`);
    if (Object.hasOwn(current, match[1])) throw new Error(`Duplicate .gitmodules key: ${line}`);
    current[match[1]] = match[2];
  }
  const result = {};
  for (const module of modules) {
    const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(module.url ?? '');
    if (!module.path || !match || match[1].toLowerCase() !== owner.toLowerCase()) {
      throw new Error('Submodules must have a path and an allowlisted GitHub owner.');
    }
    if (Object.hasOwn(result, module.path)) throw new Error(`Duplicate submodule: ${module.path}`);
    result[module.path] = match[2];
  }
  return result;
}

export function validateTree(name, tree, modules, config) {
  const expected = config.repositories[name].submodules;
  const actual = Object.fromEntries(tree.filter((entry) => entry.mode === '160000')
    .map((entry) => [entry.path, modules[entry.path]]));
  const entries = (object) => JSON.stringify(Object.entries(object).sort());
  if (entries(modules) !== entries(expected) || entries(actual) !== entries(expected)) {
    throw new Error(`${name}: .gitmodules/gitlinks differ from repositories.json; update the configuration manually.`);
  }
}

export function assertPointerOnly(baseTree, headTree, modules) {
  const base = new Map(baseTree.map((entry) => [entry.path, entry]));
  const head = new Map(headTree.map((entry) => [entry.path, entry]));
  for (const path of new Set([...base.keys(), ...head.keys()])) {
    const old = base.get(path);
    const next = head.get(path);
    // Directory tree IDs change when a descendant gitlink changes.
    if (old?.type === 'tree' && next?.type === 'tree') continue;
    if (old?.sha === next?.sha && old?.mode === next?.mode) continue;
    if (!Object.hasOwn(modules, path) || old?.mode !== '160000' || next?.mode !== '160000') {
      throw new Error(`Automatic PR contains a non-gitlink change: ${path}.`);
    }
  }
}

export class Manager {
  constructor(api, config, { dryRun = false, log = console.log } = {}) {
    this.api = api;
    this.config = config;
    this.order = orderRepositories(config);
    this.dryRun = dryRun;
    this.log = log;
    this.snapshots = new Map();
    this.targets = new Map();
    this.pulls = new Map();
    this.managed = new Map();
  }

  path(repo, suffix) {
    return `/repos/${this.config.owner}/${repo}${suffix}`;
  }

  async snapshot(repo, sha) {
    const key = `${repo}:${sha}`;
    if (this.snapshots.has(key)) return this.snapshots.get(key);
    const commit = await this.api.request('GET', this.path(repo, `/git/commits/${sha}`));
    const tree = await this.api.request('GET', this.path(repo, `/git/trees/${commit.tree.sha}?recursive=1`));
    if (tree.truncated) throw new Error(`${repo}: Git tree was truncated; refusing partial validation.`);
    const moduleEntry = tree.tree.find((entry) => entry.path === '.gitmodules');
    let modules = {};
    if (moduleEntry) {
      const blob = await this.api.request('GET', this.path(repo, `/git/blobs/${moduleEntry.sha}`));
      if (blob.encoding !== 'base64') throw new Error(`${repo}: Unexpected .gitmodules encoding.`);
      modules = parseGitmodules(Buffer.from(blob.content, 'base64').toString('utf8'), this.config.owner);
    }
    validateTree(repo, tree.tree, modules, this.config);
    const snapshot = {
      sha, treeSha: commit.tree.sha, tree: tree.tree,
      links: Object.fromEntries(tree.tree.filter((entry) => entry.mode === '160000')
        .map((entry) => [entry.path, entry.sha])),
    };
    this.snapshots.set(key, snapshot);
    return snapshot;
  }

  async load() {
    for (const repo of this.order) {
      const pulls = await this.api.pulls(this.config.owner, repo);
      this.pulls.set(repo, pulls);
      const managed = pulls.filter((pr) => pr.state === 'open' && this.isManaged(repo, pr));
      if (managed.length > 1) throw new Error(`${repo}: multiple automatic PRs; resolve them manually.`);
      if (managed.length) {
        this.managed.set(repo, managed[0]);
        const previous = await this.latestCheck(repo, managed[0].head.sha);
        if (!previous || previous.status === 'in_progress' || previous.conclusion === 'success') {
          await this.check(repo, managed[0].head.sha, 'in_progress',
            'Refreshing HASM dependency references.', previous?.id);
        }
      }
    }
    for (const repo of this.order) {
      const metadata = await this.api.request('GET', this.path(repo, ''));
      const branch = this.config.repositories[repo].branch;
      if (metadata.default_branch !== branch) {
        throw new Error(`${repo}: default branch changed from ${branch} to ${metadata.default_branch}.`);
      }
      const ref = await this.api.request('GET', this.path(repo, `/git/ref/heads/${encodeURIComponent(branch)}`));
      this.targets.set(repo, await this.snapshot(repo, ref.object.sha));
    }
  }

  isManaged(repo, pr) {
    return pr.head.ref.startsWith(BRANCH_PREFIX)
      && pr.head.repo?.full_name === `${this.config.owner}/${repo}`;
  }

  async blockers(repo, snapshot, prefix = '', ancestry = new Set()) {
    const key = `${repo}:${snapshot.sha}`;
    if (ancestry.has(key)) throw new Error(`Recursive gitlink cycle at ${key}.`);
    const nextAncestry = new Set([...ancestry, key]);
    const result = [];
    for (const [path, dependency] of Object.entries(this.config.repositories[repo].submodules)) {
      const actual = snapshot.links[path];
      const expected = this.targets.get(dependency).sha;
      const location = prefix ? `${prefix}/${path}` : path;
      if (actual !== expected) {
        result.push({ repository: repo, dependency, path, location, actual, expected });
      }
      result.push(...await this.blockers(
        dependency, await this.snapshot(dependency, actual), location, nextAncestry,
      ));
    }
    return result;
  }

  body(repo, snapshot, blockers) {
    const owner = this.config.owner;
    const modules = this.config.repositories[repo].submodules;
    const lines = [
      '## HASM dependency update', '',
      '**Manual merge only.** This PR updates registered gitlink IDs, not application code.',
      'CI is supporting evidence, not a compatibility approval. Review the upstream changes and test manually.', '',
      '### Direct references', '',
      '| Path | Repository | Selected merged commit |',
      '| --- | --- | --- |',
    ];
    for (const [path, dependency] of Object.entries(modules)) {
      const sha = snapshot.links[path];
      lines.push(`| \`${path}\` | [${dependency}](https://github.com/${owner}/${dependency}) | [\`${sha.slice(0, 12)}\`](https://github.com/${owner}/${dependency}/commit/${sha}) |`);
    }
    lines.push('', '### Prerequisite merges', '');
    if (!blockers.length) {
      lines.push('- [x] Selected direct and nested references are aligned with the captured default-branch commits.',
        '- [ ] Human compatibility review and manual merge.');
    } else {
      const repositories = [...new Set(blockers.map((item) => item.repository))];
      for (const dependency of repositories) {
        const pr = this.managed.get(dependency);
        lines.push(pr
          ? `- [ ] Merge [${dependency} #${pr.number}](${pr.html_url}), then wait for this PR to refresh.`
          : `- [ ] Update and merge [${dependency}](https://github.com/${owner}/${dependency}/pulls); no automatic PR is available yet.`);
      }
      lines.push('', '| Nested path | Current commit | Required commit |',
        '| --- | --- | --- |');
      for (const item of blockers) {
        lines.push(`| \`${item.location}\` | \`${item.actual.slice(0, 12)}\` | [\`${item.expected.slice(0, 12)}\`](https://github.com/${owner}/${item.dependency}/commit/${item.expected}) |`);
      }
    }
    lines.push('', '### Merge gate', '',
      blockers.length
        ? '`dependency-ready` is failing. Keep this PR in draft until prerequisite merges and reference updates are complete.'
        : '`dependency-ready` verifies reference consistency only. A human must approve compatibility and merge.',
      '', 'The manager maintains this PR body and appends one commit per changed submodule path.',
      'Do not add application-code changes to this branch. Resolve rejected updates manually.',
      'Required checks must be bound to the HASM dependency GitHub App; disable bypasses and require human review.',
    );
    return lines.join('\n');
  }

  async check(repo, sha, status, summary, id) {
    if (this.dryRun) {
      this.log(`${repo}@${sha.slice(0, 12)} ${CHECK_NAME}: ${status}`);
      return undefined;
    }
    const body = {
      name: CHECK_NAME,
      ...(id ? {} : { head_sha: sha, external_id: CHECK_EXTERNAL_ID }),
      status: status === 'in_progress' ? 'in_progress' : 'completed',
      ...(status === 'in_progress' ? {} : { conclusion: status }),
      output: { title: CHECK_NAME, summary: summary.slice(0, 60_000) },
    };
    const result = await this.api.request(id ? 'PATCH' : 'POST',
      this.path(repo, id ? `/check-runs/${id}` : '/check-runs'), body);
    return result.id;
  }

  async publishCheck(repo, sha, conclusion, summary, previous) {
    if (previous?.status === 'completed'
      && previous.conclusion === conclusion
      && previous.output?.summary === summary) return previous.id;
    const id = previous?.status === 'in_progress' ? previous.id : undefined;
    return this.check(repo, sha, conclusion, summary, id);
  }

  async latestCheck(repo, sha) {
    const result = await this.api.request('GET', this.path(
      repo, `/commits/${encodeURIComponent(sha)}/check-runs?check_name=${CHECK_NAME}&per_page=100`,
    ));
    return result.check_runs
      .filter((run) => run.external_id === CHECK_EXTERNAL_ID)
      .sort((left, right) => right.id - left.id)[0];
  }

  async pointerCommit(repo, parent, path, sha) {
    const snapshot = await this.snapshot(repo, parent);
    const tree = await this.api.request('POST', this.path(repo, '/git/trees'), {
      base_tree: snapshot.treeSha,
      tree: [{ path, mode: '160000', type: 'commit', sha }],
    });
    const commit = await this.api.request('POST', this.path(repo, '/git/commits'), {
      message: `chore(deps): update ${path} to ${sha.slice(0, 12)}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`,
      tree: tree.sha,
      parents: [parent],
    });
    return commit.sha;
  }

  async validateBranch(repo, pr) {
    if (pr.base.ref !== this.config.repositories[repo].branch) {
      throw new Error(`${repo}: automatic PR targets the wrong base branch.`);
    }
    const base = this.targets.get(repo);
    const compare = await this.api.request('GET',
      this.path(repo, `/compare/${base.sha}...${pr.head.sha}`));
    const mergeBase = await this.snapshot(repo, compare.merge_base_commit.sha);
    const head = await this.snapshot(repo, pr.head.sha);
    assertPointerOnly(mergeBase.tree, head.tree, this.config.repositories[repo].submodules);
    return head;
  }

  async update(repo) {
    const modules = this.config.repositories[repo].submodules;
    let pr = this.managed.get(repo);
    let current = pr ? await this.validateBranch(repo, pr) : this.targets.get(repo);
    const changes = Object.entries(modules).filter(
      ([path, dependency]) => current.links[path] !== this.targets.get(dependency).sha,
    );
    if (!pr && !changes.length) {
      const waiting = await this.blockers(repo, current);
      if (waiting.length) this.log(`${repo}: waiting for prerequisite merges; no direct diff to open a PR yet.`);
      return;
    }
    if (this.dryRun) {
      for (const [path, dependency] of changes) {
        this.log(`${repo}: commit ${path} -> ${this.targets.get(dependency).sha}`);
      }
      const candidate = { ...current, links: { ...current.links } };
      for (const [path, dependency] of changes) candidate.links[path] = this.targets.get(dependency).sha;
      const waiting = await this.blockers(repo, candidate);
      this.log(this.body(repo, candidate, waiting));
      return;
    }
    let branch;
    if (!pr) {
      const fingerprint = createHash('sha256').update(JSON.stringify({
        base: current.sha,
        targets: Object.fromEntries(Object.keys(modules).map(
          (path) => [path, this.targets.get(modules[path]).sha],
        )),
      })).digest('hex').slice(0, 20);
      branch = `${BRANCH_PREFIX}${fingerprint}`;
      const rejected = this.pulls.get(repo).find(
        (item) => item.head.ref === branch && item.state === 'closed' && !item.merged_at,
      );
      if (rejected) {
        this.log(`${repo}: identical update was closed without merging (#${rejected.number}); not reopening it.`);
        return;
      }
      // A ref may remain after an interrupted run. Never overwrite it.
      const matchingRefs = await this.api.request('GET',
        this.path(repo, `/git/matching-refs/heads/${encodeURIComponent(branch)}`));
      if (matchingRefs.some((ref) => ref.ref === `refs/heads/${branch}`)) {
        throw new Error(`${repo}: orphan update branch ${branch}; inspect and remove it manually.`);
      }
    }
    if (pr && changes.length) await this.api.draft(pr, true);
    let sha = current.sha;
    for (const [path, dependency] of changes) {
      sha = await this.pointerCommit(repo, sha, path, this.targets.get(dependency).sha);
    }
    if (!pr) {
      await this.api.request('POST', this.path(repo, '/git/refs'), {
        ref: `refs/heads/${branch}`, sha,
      });
      current = await this.snapshot(repo, sha);
      pr = await this.api.request('POST', this.path(repo, '/pulls'), {
        title: 'chore(deps): align HASM submodule references',
        head: branch,
        base: this.config.repositories[repo].branch,
        draft: true,
        body: this.body(repo, current, await this.blockers(repo, current)),
      });
      this.managed.set(repo, pr);
      this.log(`${repo}: created ${pr.html_url}`);
    } else if (sha !== current.sha) {
      const latest = await this.api.request('GET', this.path(repo, `/pulls/${pr.number}`));
      if (latest.state !== 'open' || latest.head.sha !== pr.head.sha) {
        throw new Error(`${repo}: PR changed during update; retry after inspecting it.`);
      }
      await this.api.request('PATCH',
        this.path(repo, `/git/refs/heads/${encodeURIComponent(pr.head.ref)}`), {
          sha, force: false,
        });
      pr.head.sha = sha;
      this.log(`${repo}: appended ${changes.length} gitlink commits to ${pr.html_url}`);
    }
  }

  async evaluate(repo, pr) {
    let previous;
    let sha = pr.head.sha;
    try {
      const latest = await this.api.request('GET', this.path(repo, `/pulls/${pr.number}`));
      if (latest.state !== 'open') return;
      pr = latest;
      sha = pr.head.sha;
      // Checks belong to a commit SHA, not a PR. A second, ordinary PR for
      // the same commit must not turn a blocked automatic update green.
      if (!this.isManaged(repo, pr) && this.managed.has(repo)) {
        const automatic = await this.api.request('GET',
          this.path(repo, `/pulls/${this.managed.get(repo).number}`));
        if (automatic.state === 'open' && automatic.head.sha === sha) pr = automatic;
      }
      previous = await this.latestCheck(repo, sha);
      if (!this.isManaged(repo, pr)) {
        await this.publishCheck(repo, sha, 'success',
          'Not a HASM automatic update branch. Human review and normal CI still apply.', previous);
        return;
      }
      const snapshot = await this.validateBranch(repo, pr);
      const blockers = await this.blockers(repo, snapshot);
      const body = this.body(repo, snapshot, blockers);
      if (!this.dryRun) {
        if (pr.body !== body) await this.api.request('PATCH', this.path(repo, `/pulls/${pr.number}`), { body });
        await this.api.draft(pr, blockers.length > 0);
      }
      // Never complete a check for a head that changed while it was being inspected.
      const final = await this.api.request('GET', this.path(repo, `/pulls/${pr.number}`));
      if (final.state !== 'open' || final.head.sha !== sha) {
        throw new Error(`${repo}: PR head/state changed during dependency evaluation.`);
      }
      await this.publishCheck(repo, sha, blockers.length ? 'failure' : 'success', body, previous);
    } catch (error) {
      await this.publishCheck(
        repo, sha, 'failure', `Dependency validation failed: ${error.message}`, previous,
      );
      if (!this.dryRun && this.isManaged(repo, pr) && pr.state === 'open') {
        await this.api.draft(pr, true);
      }
      throw error;
    }
  }

  async run() {
    await this.load();
    const errors = [];
    const failedRepositories = new Set();
    for (const repo of this.order) {
      try {
        if (Object.keys(this.config.repositories[repo].submodules).length) await this.update(repo);
      } catch (error) {
        this.log(`ERROR ${repo}: ${error.message}`);
        errors.push(error);
        failedRepositories.add(repo);
        const pr = this.managed.get(repo);
        if (pr) {
          await this.check(repo, pr.head.sha, 'failure', error.message);
          if (!this.dryRun) await this.api.draft(pr, true);
        }
      }
    }
    for (const repo of this.order) {
      const open = new Map(this.pulls.get(repo).filter((pr) => pr.state === 'open').map((pr) => [pr.number, pr]));
      const managed = this.managed.get(repo);
      if (managed) open.set(managed.number, managed);
      for (const pr of open.values()) {
        if (failedRepositories.has(repo)
          && (this.isManaged(repo, pr) || pr.head.sha === managed?.head.sha)) continue;
        try {
          await this.evaluate(repo, pr);
        } catch (error) {
          this.log(`ERROR ${repo} #${pr.number}: ${error.message}`);
          errors.push(error);
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, `${errors.length} dependency operation(s) failed.`);
  }
}
