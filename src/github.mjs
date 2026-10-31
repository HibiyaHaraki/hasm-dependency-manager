export class GitHub {
  constructor(token, { fetchImpl = fetch, apiUrl = 'https://api.github.com', readOnly = false } = {}) {
    if (!token && !readOnly) throw new Error('GH_TOKEN is required (GitHub App installation token).');
    this.token = token;
    this.fetch = fetchImpl;
    this.apiUrl = apiUrl;
    this.readOnly = readOnly;
  }

  async request(method, path, body) {
    if (this.readOnly && method !== 'GET') throw new Error('Read-only mode forbids GitHub mutations.');
    const response = await this.fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`${method} ${path}: HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  async pulls(owner, repo) {
    const result = [];
    for (let page = 1; ; page += 1) {
      const batch = await this.request(
        'GET', `/repos/${owner}/${repo}/pulls?state=all&per_page=100&page=${page}`,
      );
      result.push(...batch);
      if (batch.length < 100) return result;
    }
  }

  async draft(pr, draft) {
    if (pr.draft === draft) return;
    const mutation = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
    const result = await this.request('POST', '/graphql', {
      query: `mutation($id: ID!) { ${mutation}(input: {pullRequestId: $id}) {
        pullRequest { id }
      } }`,
      variables: { id: pr.node_id },
    });
    if (result.errors?.length) {
      throw new Error(`GraphQL ${mutation}: ${result.errors.map((e) => e.message).join('; ')}`);
    }
    if (!result.data?.[mutation]?.pullRequest) {
      throw new Error(`GraphQL ${mutation} did not return the pull request.`);
    }
    pr.draft = draft;
  }
}
