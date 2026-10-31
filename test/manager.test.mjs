import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GitHub } from '../src/github.mjs';
import {
  Manager, BRANCH_PREFIX, CHECK_NAME, orderRepositories,
  parseGitmodules, validateTree, assertPointerOnly,
} from '../src/manager.mjs';

const config = {
  owner: 'HibiyaHaraki',
  repositories: {
    leaf: { branch: 'master', submodules: {} },
    middle: { branch: 'main', submodules: { leaf: 'leaf' } },
    top: {
      branch: 'master',
      submodules: { 'src/leaf': 'leaf', 'other/leaf': 'leaf', middle: 'middle' },
    },
  },
};

class FakeGitHub {
  constructor() {
    this.config = config;
    this.sequence = 0;
    this.trees = new Map();
    this.commits = new Map();
    this.blobs = new Map();
    this.refs = new Map();
    this.prs = new Map(Object.keys(config.repositories).map((repo) => [repo, []]));
    this.calls = [];
    this.checks = [];
    this.createdCommits = [];
    const oldLeaf = this.commit('leaf', {});
    this.oldLeaf = oldLeaf;
    this.latestLeaf = this.commit('leaf', {}, oldLeaf);
    const middle = this.commit('middle', { leaf: oldLeaf });
    const top = this.commit('top', { 'src/leaf': oldLeaf, 'other/leaf': oldLeaf, middle });
    for (const [repo, sha] of [['leaf', this.latestLeaf], ['middle', middle], ['top', top]]) {
      this.refs.set(`${repo}:${config.repositories[repo].branch}`, sha);
    }
  }

  id() {
    return createHash('sha1').update(String(++this.sequence)).digest('hex');
  }

  commit(repo, links, parent) {
    const tree = [{ path: 'README.md', mode: '100644', type: 'blob', sha: 'fixed-readme' }];
    const modules = this.config.repositories[repo].submodules;
    if (Object.keys(modules).length) {
      const blob = this.id();
      const content = Object.entries(modules).map(([path, name]) => (
        `[submodule "${path}"]\npath = ${path}\nurl = https://github.com/HibiyaHaraki/${name}.git`
      )).join('\n');
      this.blobs.set(blob, { encoding: 'base64', content: Buffer.from(content).toString('base64') });
      tree.push({ path: '.gitmodules', mode: '100644', type: 'blob', sha: blob });
    }
    for (const [path, sha] of Object.entries(links)) {
      tree.push({ path, mode: '160000', type: 'commit', sha });
    }
    const treeSha = this.id();
    this.trees.set(treeSha, tree);
    const sha = this.id();
    this.commits.set(sha, { sha, tree: { sha: treeSha }, parents: parent ? [{ sha: parent }] : [] });
    return sha;
  }

  async pulls(owner, repo) {
    return structuredClone(this.prs.get(repo));
  }

  async draft(pr, draft) {
    this.calls.push({ method: 'GRAPHQL', path: draft ? 'draft' : 'ready', pr: pr.number });
    const stored = [...this.prs.values()].flat().find((item) => item.node_id === pr.node_id);
    stored.draft = draft;
    pr.draft = draft;
  }

  merge(repo) {
    const pr = this.prs.get(repo).find((item) => item.state === 'open');
    assert.ok(pr);
    assert.equal(pr.draft, false);
    pr.state = 'closed';
    pr.merged_at = '2026-10-31T00:00:00Z';
    this.refs.set(`${repo}:${config.repositories[repo].branch}`, pr.head.sha);
  }

  latestCheck(repo, sha) {
    return this.checks.filter((item) => item.repo === repo && item.head_sha === sha).at(-1);
  }

  async request(method, path, body) {
    this.calls.push({ method, path, body: structuredClone(body) });
    if (this.fail?.(method, path, body)) throw new Error('Simulated GitHub failure.');
    const match = /^\/repos\/HibiyaHaraki\/([^/]+)(.*)$/.exec(path);
    assert.ok(match, `Unexpected endpoint ${path}`);
    const [, repo, suffix] = match;
    if (method === 'GET' && !suffix) {
      return { default_branch: this.config.repositories[repo].branch };
    }
    if (method === 'GET' && suffix.startsWith('/git/ref/heads/')) {
      return { object: { sha: this.refs.get(`${repo}:${decodeURIComponent(suffix.slice(15))}`) } };
    }
    if (method === 'GET' && suffix.startsWith('/git/commits/')) {
      return structuredClone(this.commits.get(suffix.slice(13)));
    }
    if (method === 'GET' && suffix.startsWith('/git/trees/')) {
      const tree = this.trees.get(suffix.slice(11).split('?')[0]);
      assert.ok(tree, `Unknown tree ${suffix}`);
      return { truncated: this.truncated ?? false, tree: structuredClone(tree) };
    }
    if (method === 'GET' && suffix.startsWith('/git/blobs/')) {
      return this.blobs.get(suffix.slice(11));
    }
    if (method === 'GET' && suffix.startsWith('/compare/')) {
      const [base, head] = suffix.slice(9).split('...');
      const ancestors = new Set();
      let current = base;
      while (current) {
        ancestors.add(current);
        current = this.commits.get(current).parents[0]?.sha;
      }
      current = head;
      while (!ancestors.has(current)) current = this.commits.get(current).parents[0]?.sha;
      return { merge_base_commit: { sha: current } };
    }
    if (method === 'POST' && suffix === '/git/trees') {
      const tree = structuredClone(this.trees.get(body.base_tree));
      for (const entry of body.tree) {
        const index = tree.findIndex((item) => item.path === entry.path);
        tree[index] = entry;
      }
      const sha = this.id();
      this.trees.set(sha, tree);
      return { sha };
    }
    if (method === 'POST' && suffix === '/git/commits') {
      const sha = this.id();
      this.commits.set(sha, { sha, tree: { sha: body.tree }, parents: body.parents.map((parent) => ({ sha: parent })) });
      this.createdCommits.push({ repo, sha, ...body });
      return { sha };
    }
    if (method === 'GET' && suffix.startsWith('/git/matching-refs/heads/')) {
      const branch = decodeURIComponent(suffix.slice('/git/matching-refs/heads/'.length));
      return this.refs.has(`${repo}:${branch}`) ? [{ ref: `refs/heads/${branch}` }] : [];
    }
    if (method === 'POST' && suffix === '/git/refs') {
      this.refs.set(`${repo}:${body.ref.slice(11)}`, body.sha);
      return { object: { sha: body.sha } };
    }
    if (method === 'PATCH' && suffix.startsWith('/git/refs/heads/')) {
      assert.equal(body.force, false);
      const branch = decodeURIComponent(suffix.slice(16));
      this.refs.set(`${repo}:${branch}`, body.sha);
      for (const pr of this.prs.get(repo)) if (pr.head.ref === branch) pr.head.sha = body.sha;
      return {};
    }
    if (method === 'POST' && suffix === '/pulls') {
      const number = this.prs.get(repo).length + 1;
      const pr = {
        number, node_id: `${repo}:${number}`, state: 'open', draft: body.draft, body: body.body,
        html_url: `https://github.com/HibiyaHaraki/${repo}/pull/${number}`,
        head: { ref: body.head, sha: this.refs.get(`${repo}:${body.head}`), repo: { full_name: `HibiyaHaraki/${repo}` } },
        base: { ref: body.base },
      };
      this.prs.get(repo).push(pr);
      return structuredClone(pr);
    }
    if (suffix.startsWith('/pulls/')) {
      const number = Number(suffix.slice(7));
      const pr = this.prs.get(repo).find((item) => item.number === number);
      assert.ok(pr);
      if (method === 'PATCH') Object.assign(pr, body);
      return structuredClone(pr);
    }
    if (method === 'POST' && suffix === '/check-runs') {
      const check = { id: this.checks.length + 1, repo, ...body };
      this.checks.push(check);
      return check;
    }
    if (method === 'GET' && suffix.includes('/commits/') && suffix.includes('/check-runs?')) {
      const sha = suffix.split('/commits/')[1].split('/check-runs?')[0];
      return {
        check_runs: this.checks
          .filter((check) => check.repo === repo && check.head_sha === sha)
          .sort((left, right) => right.id - left.id),
      };
    }
    if (method === 'PATCH' && suffix.startsWith('/check-runs/')) {
      const check = this.checks.find((item) => item.id === Number(suffix.slice(12)));
      Object.assign(check, body);
      return check;
    }
    assert.fail(`Unexpected endpoint ${method} ${path}`);
  }
}

const run = async (api, options = {}) => {
  const manager = new Manager(api, config, { log() {}, ...options });
  await manager.run();
  return manager;
};

test('real HASM configuration includes all duplicate direct references and has no cycle', async () => {
  const actual = JSON.parse(await readFile(new URL('../repositories.json', import.meta.url), 'utf8'));
  assert.equal(orderRepositories(actual).length, 8);
  assert.equal(actual.repositories.hasm_color_pattern.submodules.hasm_logger, 'hasm_logger');
  assert.equal(actual.repositories.hasm.submodules['src/hasm_logger'], 'hasm_logger');
  assert.equal(actual.repositories.hasm.submodules['src-tauri/src/hasm_logger'], 'hasm_logger');
  assert.equal(actual.repositories['hasm-top'].submodules['src/hasm_visualizer'], 'hasm_visualizer');
});

test('parses HTTPS/SSH URLs, .git suffix, whitespace and branch declaration', () => {
  assert.deepEqual(parseGitmodules(`
[submodule "a"]
 path = src/a
 url = git@github.com:HibiyaHaraki/hasm_logo.git
[submodule "b"]
 path = src/b
 url = https://github.com/HibiyaHaraki/hasm_logger
 branch = master
`, 'HibiyaHaraki'), { 'src/a': 'hasm_logo', 'src/b': 'hasm_logger' });
});

test('rejects unknown owner, duplicate paths and invalid config', () => {
  assert.throws(() => parseGitmodules('[submodule "a"]\npath=x\nurl=https://github.com/Other/x', config.owner));
  assert.throws(() => parseGitmodules('[submodule "a"]\npath=x\npath=y', config.owner));
  const cycle = structuredClone(config);
  cycle.repositories.leaf.submodules = { top: 'top' };
  assert.throws(() => orderRepositories(cycle), /cycle/);
  const unsafe = structuredClone(config);
  unsafe.repositories.top.submodules = { '../leaf': 'leaf' };
  assert.throws(() => orderRepositories(unsafe), /Unsafe/);
  assert.throws(() => validateTree('middle', [], { leaf: 'leaf' }, config), /gitlinks differ/);
});

test('pointer-only validation ignores changed directory IDs but rejects application edits', () => {
  const tree = [
    { path: 'src', type: 'tree', mode: '040000', sha: 'directory-old' },
    { path: 'src/leaf', type: 'commit', mode: '160000', sha: 'old' },
    { path: 'code.js', type: 'blob', mode: '100644', sha: 'code' },
  ];
  const head = structuredClone(tree);
  head[0].sha = 'directory-new';
  head[1].sha = 'new';
  assert.doesNotThrow(() => assertPointerOnly(tree, head, { 'src/leaf': 'leaf' }));
  head[2].sha = 'changed';
  assert.throws(() => assertPointerOnly(tree, head, { 'src/leaf': 'leaf' }), /code.js/);
  assert.throws(() => assertPointerOnly(tree, head.slice(0, 2), { 'src/leaf': 'leaf' }), /code.js/);
});

test('creates one commit per duplicate path, one PR, and blocks nested dependency until manual merge', async () => {
  const api = new FakeGitHub();
  await run(api);
  const middle = api.prs.get('middle')[0];
  const top = api.prs.get('top')[0];
  assert.equal(middle.draft, false);
  assert.equal(top.draft, true);
  assert.match(top.body, /Merge \[middle #1\]/);
  assert.match(top.body, /middle\/leaf/);
  assert.equal(api.latestCheck('top', top.head.sha).conclusion, 'failure');
  assert.equal(api.latestCheck('middle', middle.head.sha).conclusion, 'success');
  assert.equal(api.createdCommits.filter((commit) => commit.repo === 'top').length, 2);
  for (const commit of api.createdCommits) {
    const parent = api.commits.get(commit.parents[0]);
    const oldTree = api.trees.get(parent.tree.sha);
    const newTree = api.trees.get(commit.tree);
    const changed = newTree.filter((entry) => oldTree.find((old) => old.path === entry.path).sha !== entry.sha);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].mode, '160000');
  }
  const firstHead = top.head.sha;
  api.merge('middle');
  await run(api);
  assert.equal(api.prs.get('top').length, 1);
  assert.notEqual(top.head.sha, firstHead);
  assert.equal(api.commits.get(top.head.sha).parents[0].sha, firstHead);
  assert.equal(top.draft, false);
  assert.equal(api.latestCheck('top', top.head.sha).conclusion, 'success');
  assert.equal(api.createdCommits.filter((commit) => commit.repo === 'top').length, 3);
  assert.match(top.body, /Human compatibility review/);
  assert.ok(!api.calls.some((call) => call.path.includes('/merge')));
});

test('idempotent rerun makes no extra commits or PRs', async () => {
  const api = new FakeGitHub();
  await run(api);
  const count = api.createdCommits.length;
  const topCheckCount = api.checks.filter((check) => check.repo === 'top').length;
  await run(api);
  assert.equal(api.createdCommits.length, count);
  assert.equal(api.checks.filter((check) => check.repo === 'top').length, topCheckCount);
  assert.equal(api.prs.get('top').length, 1);
});

test('historical missing submodules warn while prerequisite PRs wait, then clear after merge', async () => {
  const api = new FakeGitHub();
  const updated = structuredClone(config);
  updated.repositories.logger = { branch: 'master', submodules: {} };
  updated.repositories.leaf.submodules = { logger: 'logger' };
  api.config = updated;
  const logger = api.commit('logger', {});
  api.prs.set('logger', []);
  api.refs.set('logger:master', logger);
  const latestLeaf = api.commit('leaf', { logger }, api.latestLeaf);
  api.refs.set('leaf:master', latestLeaf);
  const logs = [];
  const execute = async (dryRun = false) => {
    const manager = new Manager(api, updated, { dryRun, log: (line) => logs.push(line) });
    await manager.run();
    return manager;
  };
  await execute();
  const middle = api.prs.get('middle')[0];
  const top = api.prs.get('top')[0];
  assert.equal(middle.draft, false);
  assert.equal(top.draft, true);
  assert.equal(api.latestCheck('top', top.head.sha).conclusion, 'failure');
  assert.match(top.body, /Merge \[middle #1\]/);
  assert.ok(logs.some((line) => /WARNING leaf@.*historical commit.*logger/.test(line)));
  assert.ok(!logs.some((line) => line.startsWith('ERROR')));
  const checks = api.checks.filter((check) => check.repo === 'top').length;
  await execute();
  assert.equal(api.checks.filter((check) => check.repo === 'top').length, checks);
  api.calls = [];
  await execute(true);
  assert.ok(api.calls.every((call) => call.method === 'GET'));
  api.merge('middle');
  logs.length = 0;
  await execute();
  assert.equal(top.draft, false);
  assert.equal(api.latestCheck('top', top.head.sha).conclusion, 'success');
  assert.ok(!logs.some((line) => line.startsWith('WARNING')));
});

test('historical allowance does not bypass strict snapshots or malformed gitlinks', async () => {
  const api = new FakeGitHub();
  const updated = structuredClone(config);
  updated.repositories.logger = { branch: 'master', submodules: {} };
  updated.repositories.leaf.submodules = { logger: 'logger' };
  const manager = new Manager(api, updated, { log() {} });
  manager.targets.set('leaf', { sha: api.latestLeaf });
  await manager.snapshot('leaf', api.oldLeaf, { allowMissing: true });
  await assert.rejects(manager.snapshot('leaf', api.oldLeaf), /differ from repositories.json/);
  await assert.rejects(
    manager.snapshot('leaf', api.latestLeaf, { allowMissing: true }), /without a validated merged target/,
  );
  const tree = api.trees.get(api.commits.get(api.oldLeaf).tree.sha);
  tree.push({ path: 'logger', mode: '160000', type: 'commit', sha: api.latestLeaf });
  const fresh = new Manager(api, updated, { log() {} });
  fresh.targets.set('leaf', { sha: api.latestLeaf });
  await assert.rejects(
    fresh.snapshot('leaf', api.oldLeaf, { allowMissing: true }), /differ from repositories.json/,
  );
});

test('unmerged missing-submodule commits are not treated as expected waiting', async () => {
  const api = new FakeGitHub();
  const updated = structuredClone(config);
  updated.repositories.logger = { branch: 'master', submodules: {} };
  updated.repositories.leaf.submodules = { logger: 'logger' };
  const unmerged = api.commit('leaf', {}, api.oldLeaf);
  const manager = new Manager(api, updated, { log() {} });
  manager.targets.set('leaf', { sha: api.latestLeaf });
  await assert.rejects(
    manager.snapshot('leaf', unmerged, { allowMissing: true }), /outside the merged target history/,
  );
});

test('missing current submodules, unknown historical paths and remapped repositories remain errors', async () => {
  const api = new FakeGitHub();
  const middle = api.refs.get('middle:main');
  api.trees.set(api.commits.get(middle).tree.sha, []);
  await assert.rejects(run(api), /differ from repositories.json/);
  const tree = [{ path: 'leaf', mode: '160000', type: 'commit', sha: api.oldLeaf }];
  assert.throws(
    () => validateTree('middle', tree, { leaf: 'top' }, config, { allowMissing: true }),
    /differ from repositories.json/,
  );
  assert.throws(
    () => validateTree('middle', [{ ...tree[0], path: 'unknown' }], { unknown: 'leaf' },
      config, { allowMissing: true }),
    /differ from repositories.json/,
  );
});

test('dry-run never mutates GitHub even with existing automatic PRs', async () => {
  const api = new FakeGitHub();
  await run(api);
  api.calls = [];
  await run(api, { dryRun: true });
  assert.ok(api.calls.every((call) => call.method === 'GET'));
});

test('human-added application changes fail the gate without overwriting the branch', async () => {
  const api = new FakeGitHub();
  await run(api);
  const pr = api.prs.get('middle')[0];
  const commit = api.commits.get(pr.head.sha);
  api.trees.get(commit.tree.sha).find((entry) => entry.path === 'README.md').sha = 'human-edit';
  const original = pr.head.sha;
  await assert.rejects(run(api), AggregateError);
  assert.equal(pr.head.sha, original);
  assert.equal(pr.draft, true);
  assert.equal(api.latestCheck('middle', original).conclusion, 'failure');
});

test('manually marking a blocked PR ready does not bypass the required check', async () => {
  const api = new FakeGitHub();
  await run(api);
  const pr = api.prs.get('top')[0];
  pr.draft = false;
  await run(api);
  assert.equal(pr.draft, true);
  assert.equal(api.latestCheck('top', pr.head.sha).conclusion, 'failure');
});

test('an unmerged direct dependency commit cannot satisfy the gate', async () => {
  const api = new FakeGitHub();
  await run(api);
  const top = api.prs.get('top')[0];
  const middle = api.prs.get('middle')[0];
  const commit = api.commits.get(top.head.sha);
  api.trees.get(commit.tree.sha).find((entry) => entry.path === 'middle').sha = middle.head.sha;
  const manager = new Manager(api, config, { log() {} });
  await manager.load();
  await manager.evaluate('top', structuredClone(top));
  assert.equal(api.latestCheck('top', top.head.sha).conclusion, 'failure');
  assert.equal(top.draft, true);
});

test('a PR head changing during update is not overwritten', async () => {
  const api = new FakeGitHub();
  await run(api);
  api.merge('middle');
  const top = api.prs.get('top')[0];
  const original = top.head.sha;
  const request = api.request.bind(api);
  let changed = false;
  api.request = async (method, path, body) => {
    if (!changed && method === 'GET' && path === '/repos/HibiyaHaraki/top/pulls/1') {
      const commit = api.commits.get(original);
      const sha = api.id();
      api.commits.set(sha, { ...structuredClone(commit), sha, parents: [{ sha: original }] });
      top.head.sha = sha;
      changed = true;
    }
    return request(method, path, body);
  };
  await assert.rejects(run(api), AggregateError);
  assert.notEqual(top.head.sha, original);
  assert.equal(api.latestCheck('top', original).conclusion, 'failure');
  assert.ok(!api.calls.some((call) => call.method === 'PATCH' && call.path.includes('/git/refs/heads/')));
});

test('base branch advancing preserves an accumulating PR and append-only commits', async () => {
  const api = new FakeGitHub();
  await run(api);
  const top = api.prs.get('top')[0];
  const oldHead = top.head.sha;
  const base = api.refs.get('top:master');
  const sha = api.id();
  const commit = structuredClone(api.commits.get(base));
  const treeSha = api.id();
  const tree = structuredClone(api.trees.get(commit.tree.sha));
  tree.find((entry) => entry.path === 'README.md').sha = 'new-base-readme';
  api.trees.set(treeSha, tree);
  api.commits.set(sha, { sha, tree: { sha: treeSha }, parents: [{ sha: base }] });
  api.refs.set('top:master', sha);
  api.merge('middle');
  await run(api);
  assert.equal(api.prs.get('top').length, 1);
  assert.equal(api.commits.get(top.head.sha).parents[0].sha, oldHead);
});

test('orphan branches are reported without being overwritten', async () => {
  const api = new FakeGitHub();
  await run(api);
  const middle = api.prs.get('middle')[0];
  api.prs.set('middle', []);
  const oldRef = api.refs.get(`middle:${middle.head.ref}`);
  await assert.rejects(run(api), AggregateError);
  assert.equal(api.refs.get(`middle:${middle.head.ref}`), oldRef);
  assert.equal(api.prs.get('middle').length, 0);
});

test('a closed rejected update is not reopened for the same base and target', async () => {
  const api = new FakeGitHub();
  await run(api);
  api.prs.get('middle')[0].state = 'closed';
  const count = api.createdCommits.length;
  await run(api);
  assert.equal(api.prs.get('middle').length, 1);
  assert.equal(api.prs.get('middle')[0].state, 'closed');
  assert.equal(api.createdCommits.length, count);
});

test('ordinary human PRs receive the gate without being rewritten or marked ready', async () => {
  const api = new FakeGitHub();
  const head = api.refs.get('leaf:master');
  api.prs.get('leaf').push({
    number: 1, node_id: 'leaf:1', state: 'open', draft: true, body: 'Human-owned body',
    head: { ref: 'feature', sha: head, repo: { full_name: 'HibiyaHaraki/leaf' } },
    base: { ref: 'master' },
  });
  await run(api);
  const pr = api.prs.get('leaf')[0];
  assert.equal(pr.body, 'Human-owned body');
  assert.equal(pr.draft, true);
  assert.equal(api.latestCheck('leaf', head).conclusion, 'success');
});

test('an ordinary PR sharing the automatic PR head cannot override its failed check', async () => {
  const api = new FakeGitHub();
  await run(api);
  const top = api.prs.get('top')[0];
  api.prs.get('top').push({
    ...structuredClone(top),
    number: 2, node_id: 'top:2', body: 'Human-owned body', draft: false,
    head: { ...structuredClone(top.head), ref: 'feature/same-commit' },
  });
  await run(api);
  assert.equal(api.latestCheck('top', top.head.sha).conclusion, 'failure');
  assert.equal(api.prs.get('top')[1].body, 'Human-owned body');
  assert.equal(api.prs.get('top')[1].draft, false);
});

test('truncated GitHub trees fail closed', async () => {
  const api = new FakeGitHub();
  await run(api);
  api.truncated = true;
  await assert.rejects(run(api), /truncated/);
  const pr = api.prs.get('middle')[0];
  assert.equal(api.latestCheck('middle', pr.head.sha).status, 'in_progress');
});

test('failed branch update remains failing instead of being re-evaluated as success', async () => {
  const api = new FakeGitHub();
  await run(api);
  api.merge('middle');
  const pr = api.prs.get('top')[0];
  const original = pr.head.sha;
  api.fail = (method, path) => method === 'PATCH' && path.includes('/git/refs/heads/');
  await assert.rejects(run(api), AggregateError);
  assert.equal(pr.head.sha, original);
  assert.equal(pr.draft, true);
  assert.equal(api.latestCheck('top', original).conclusion, 'failure');
});

test('read-only API permits anonymous public reads and forbids all mutation methods', async () => {
  const calls = [];
  const api = new GitHub(undefined, {
    readOnly: true,
    fetchImpl: async (url, options) => {
      calls.push(options);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
  });
  assert.deepEqual(await api.request('GET', '/repos/HibiyaHaraki/hasm'), { ok: true });
  assert.equal(calls[0].headers.Authorization, undefined);
  await assert.rejects(api.request('POST', '/git/refs', {}), /Read-only/);
  assert.throws(() => new GitHub(undefined), /GH_TOKEN/);
});

test('transport and GraphQL errors are explicit failures', async () => {
  const failing = new GitHub('test-token', {
    fetchImpl: async () => ({ ok: false, status: 403 }),
  });
  await assert.rejects(failing.request('GET', '/repos/example/repo'), /HTTP 403/);
  const graphql = new GitHub('test-token', {
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ errors: [{ message: 'Forbidden' }] }) }),
  });
  await assert.rejects(graphql.draft({ draft: true, node_id: 'id' }, false), /Forbidden/);
});

test('pull request retrieval paginates past 100 entries', async () => {
  const api = new GitHub('test-token');
  const requests = [];
  api.request = async (method, path) => {
    requests.push(path);
    return path.endsWith('&page=1') ? Array.from({ length: 100 }, (_, number) => ({ number })) : [{ number: 101 }];
  };
  assert.equal((await api.pulls('owner', 'repo')).length, 101);
  assert.equal(requests.length, 2);
});
