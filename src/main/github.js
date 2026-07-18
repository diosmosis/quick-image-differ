// Minimal GitHub REST API client built on Node's global fetch.
// Uses a personal access token (classic or fine-grained) for authentication.
// A fine-grained token needs read access to "Actions" and "Contents" for the
// repositories you want to diff; a classic token needs the `repo` scope
// (or `public_repo` for public repositories only).

const API_BASE = 'https://api.github.com'

export class GitHubClient {
  constructor(token) {
    this.token = token
  }

  get headers() {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${this.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'quick-image-differ'
    }
  }

  async request(path, options = {}) {
    const res = await fetch(path.startsWith('http') ? path : API_BASE + path, {
      ...options,
      headers: { ...this.headers, ...(options.headers || {}) }
    })
    if (!res.ok) {
      let detail = ''
      try {
        const body = await res.json()
        detail = body.message || JSON.stringify(body)
      } catch {
        detail = await res.text().catch(() => '')
      }
      throw new Error(`GitHub API ${res.status}: ${detail}`)
    }
    return res
  }

  async json(path, options) {
    return (await this.request(path, options)).json()
  }

  async getUser() {
    return this.json('/user')
  }

  // Repositories the authenticated user can access, most recently pushed first.
  async listRepos() {
    const repos = []
    for (let page = 1; page <= 5; page++) {
      const batch = await this.json(
        `/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=${page}`
      )
      repos.push(...batch)
      if (batch.length < 100) break
    }
    return repos.map((r) => ({
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      private: r.private,
      pushedAt: r.pushed_at
    }))
  }

  async getRepo(owner, name) {
    const r = await this.json(`/repos/${owner}/${name}`)
    return { fullName: r.full_name, owner: r.owner.login, name: r.name, private: r.private }
  }

  async listWorkflows(owner, repo) {
    const data = await this.json(`/repos/${owner}/${repo}/actions/workflows?per_page=100`)
    return (data.workflows || []).map((w) => ({
      id: w.id,
      name: w.name,
      path: w.path,
      state: w.state
    }))
  }

  async listRuns(owner, repo, workflowId) {
    const data = await this.json(
      `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs?per_page=30`
    )
    return (data.workflow_runs || []).map((run) => ({
      id: run.id,
      name: run.name,
      runNumber: run.run_number,
      status: run.status,
      conclusion: run.conclusion,
      headBranch: run.head_branch,
      event: run.event,
      createdAt: run.created_at,
      htmlUrl: run.html_url
    }))
  }

  async listArtifacts(owner, repo, runId) {
    const data = await this.json(
      `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`
    )
    return (data.artifacts || []).map((a) => ({
      id: a.id,
      name: a.name,
      sizeInBytes: a.size_in_bytes,
      expired: a.expired,
      createdAt: a.created_at
    }))
  }

  // Returns the artifact as a zip Buffer. fetch transparently follows the
  // redirect GitHub issues to blob storage.
  async downloadArtifactZip(owner, repo, artifactId) {
    const res = await this.request(
      `/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`
    )
    return Buffer.from(await res.arrayBuffer())
  }
}
