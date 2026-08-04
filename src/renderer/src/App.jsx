import React, { useCallback, useEffect, useRef, useState } from 'react'
import Setup from './components/Setup'
import PopoverSelect from './components/PopoverSelect'
import DiffViewer from './components/DiffViewer'

const api = window.api

// Small badge helpers for the step lists.
function runBadge(run) {
  const c = run.conclusion || run.status
  const cls =
    c === 'success' ? 'st-identical' : c === 'failure' ? 'st-error' : 'st-added'
  return <span className={`badge ${cls}`}>{c}</span>
}

// Subtitle for a run: the triggering commit's message (first line), or "Manual"
// when the run was started by hand (workflow_dispatch).
function runSubtitle(run) {
  if (run.event === 'workflow_dispatch') return 'Manual'
  const msg = (run.headCommitMessage || run.displayTitle || '').split('\n')[0].trim()
  return msg || run.event || '—'
}

// Compact local date + time, e.g. "3 Aug, 14:05" — used for artifact upload times.
function formatDateTime(value) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// Human-readable message for the current diff progress phase.
function diffProgressMessage(p) {
  if (!p) return 'Preparing…'
  if (p.message) return p.message
  if (p.phase === 'compare') return 'Comparing images…'
  return 'Working…'
}

export default function App() {
  const [settings, setSettings] = useState({ hasToken: false })
  const [user, setUser] = useState(null)
  const [globalError, setGlobalError] = useState(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)

  // GitHub selection chain
  const [repos, setRepos] = useState([])
  const [reposState, setReposState] = useState({ loading: false, error: null })
  const [selectedRepo, setSelectedRepo] = useState(null)

  const [workflows, setWorkflows] = useState([])
  const [wfState, setWfState] = useState({ loading: false, error: null })
  const [selectedWorkflow, setSelectedWorkflow] = useState(null)
  // Workflow ids that appeared for the first time on the most recent refresh.
  const [newWorkflowIds, setNewWorkflowIds] = useState(() => new Set())

  const [runs, setRuns] = useState([])
  const [runsState, setRunsState] = useState({ loading: false, error: null })
  const [selectedRun, setSelectedRun] = useState(null)

  const [artifacts, setArtifacts] = useState([])
  const [artState, setArtState] = useState({ loading: false, error: null })
  const [selectedArtifact, setSelectedArtifact] = useState(null)

  // Diff
  const [diffResult, setDiffResult] = useState(null)
  const [diffState, setDiffState] = useState({ loading: false, error: null })
  const [diffProgress, setDiffProgress] = useState(null)
  // Id of the diff request whose progress/result we currently care about. A
  // request started while an older one is still running supersedes it, and the
  // older one's late progress events and result are ignored.
  const diffReqRef = useRef(0)

  // ---- initial load -----------------------------------------------------
  useEffect(() => {
    api.getSettings().then((s) => {
      setSettings(s)
      setSidebarCollapsed(Boolean(s.sidebarCollapsed))
      if (s.hasToken) {
        loadRepos()
        api.whoami().then((u) => u && setUser(u))
        restoreSelections(s)
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Progress updates streamed from the main process during a diff. Events from
  // a superseded diff are dropped, otherwise two interleaved progress streams
  // would make the loading screen jump back and forth.
  useEffect(() => {
    const off = api.onDiffProgress((p) => {
      if (p?.requestId !== diffReqRef.current) return
      setDiffProgress(p)
    })
    return off
  }, [])

  // Re-load the persisted repo → workflow → run → artifact chain so the same
  // selections are shown on the next launch. Each level is only restored if it
  // still exists on GitHub.
  const restoreSelections = async (s) => {
    if (!s.selectedRepo) return
    setSelectedRepo(s.selectedRepo)
    setWfState({ loading: true, error: null })
    let wf
    try {
      wf = await api.listWorkflows(s.selectedRepo)
      setWorkflows(wf)
      setWfState({ loading: false, error: null })
    } catch (e) {
      setWfState({ loading: false, error: e.message })
      return
    }

    if (!s.selectedWorkflow || !wf.some((w) => w.id === s.selectedWorkflow.id)) return
    setSelectedWorkflow(s.selectedWorkflow)
    setRunsState({ loading: true, error: null })
    let runsList
    try {
      runsList = await api.listRuns(s.selectedRepo, s.selectedWorkflow.id)
      setRuns(runsList)
      setRunsState({ loading: false, error: null })
    } catch (e) {
      setRunsState({ loading: false, error: e.message })
      return
    }

    if (!s.selectedRun || !runsList.some((r) => r.id === s.selectedRun.id)) return
    setSelectedRun(s.selectedRun)
    setArtState({ loading: true, error: null })
    let artsList
    try {
      artsList = await api.listArtifacts(s.selectedRepo, s.selectedRun.id)
      setArtifacts(artsList)
      setArtState({ loading: false, error: null })
    } catch (e) {
      setArtState({ loading: false, error: e.message })
      return
    }

    if (s.selectedArtifact && artsList.some((a) => a.id === s.selectedArtifact.id)) {
      setSelectedArtifact(s.selectedArtifact)
      // Auto-download and diff the restored artifact (served from the local
      // cache when available).
      runDiff({
        repo: s.selectedRepo,
        runId: s.selectedRun.id,
        artifact: s.selectedArtifact,
        baselineFolder: s.baselineFolder
      })
    }
  }

  // ---- token / folder ---------------------------------------------------
  const verifyToken = async (token) => {
    if (token === '__clear__') {
      await api.saveSettings({
        token: '',
        selectedRepo: null,
        selectedWorkflow: null,
        selectedRun: null,
        selectedArtifact: null
      })
      const s = await api.getSettings()
      setSettings(s)
      setUser(null)
      resetFrom('repo')
      setRepos([])
      return
    }
    const u = await api.verifyToken(token)
    setUser(u)
    const s = await api.getSettings()
    setSettings(s)
    loadRepos()
  }

  const selectFolder = async () => {
    const folder = await api.selectFolder()
    if (folder) setSettings((prev) => ({ ...prev, baselineFolder: folder }))
  }

  // ---- step loaders -----------------------------------------------------
  const loadRepos = async () => {
    setReposState({ loading: true, error: null })
    try {
      const r = await api.listRepos()
      setRepos(r)
      setReposState({ loading: false, error: null })
    } catch (e) {
      setReposState({ loading: false, error: e.message })
    }
  }

  const resetFrom = (level) => {
    // Clear selections downstream of the given level.
    const order = ['repo', 'workflow', 'run', 'artifact', 'diff']
    const idx = order.indexOf(level)
    if (idx <= order.indexOf('repo')) {
      setSelectedRepo(null)
      setWorkflows([])
    }
    if (idx <= order.indexOf('workflow')) {
      setSelectedWorkflow(null)
      setRuns([])
    }
    if (idx <= order.indexOf('run')) {
      setSelectedRun(null)
      setArtifacts([])
    }
    if (idx <= order.indexOf('artifact')) {
      setSelectedArtifact(null)
    }
    if (idx <= order.indexOf('diff')) {
      // Orphan any diff still in flight so it can't populate the view we are
      // clearing here.
      diffReqRef.current += 1
      setDiffResult(null)
      setDiffState({ loading: false, error: null })
      setDiffProgress(null)
    }
  }

  const pickRepo = async (repoFullName) => {
    resetFrom('workflow')
    setSelectedRepo(repoFullName)
    // Persist the selection (and clear any stale downstream selections).
    api.saveSettings({
      selectedRepo: repoFullName,
      selectedWorkflow: null,
      selectedRun: null,
      selectedArtifact: null
    })
    setNewWorkflowIds(new Set())
    setWfState({ loading: true, error: null })
    try {
      const wf = await api.listWorkflows(repoFullName)
      setWorkflows(wf)
      setWfState({ loading: false, error: null })
    } catch (e) {
      setWfState({ loading: false, error: e.message })
    }
  }

  // Refresh handlers reload a single selector's contents without disturbing the
  // current selection or the downstream selectors.
  const refreshWorkflows = async () => {
    if (!selectedRepo) return
    setWfState({ loading: true, error: null })
    try {
      const fresh = await api.listWorkflows(selectedRepo)
      const prevIds = new Set(workflows.map((w) => w.id))
      setNewWorkflowIds(new Set(fresh.filter((w) => !prevIds.has(w.id)).map((w) => w.id)))
      setWorkflows(fresh)
      setWfState({ loading: false, error: null })
    } catch (e) {
      setWfState({ loading: false, error: e.message })
    }
  }

  const refreshRuns = async () => {
    if (!selectedRepo || !selectedWorkflow) return
    setRunsState({ loading: true, error: null })
    try {
      const fresh = await api.listRuns(selectedRepo, selectedWorkflow.id)
      setRuns(fresh)
      setRunsState({ loading: false, error: null })
    } catch (e) {
      setRunsState({ loading: false, error: e.message })
    }
  }

  const refreshArtifacts = async () => {
    if (!selectedRepo || !selectedRun) return
    setArtState({ loading: true, error: null })
    try {
      const fresh = await api.listArtifacts(selectedRepo, selectedRun.id)
      setArtifacts(fresh)
      setArtState({ loading: false, error: null })
    } catch (e) {
      setArtState({ loading: false, error: e.message })
    }
  }

  const pickWorkflow = async (wf) => {
    resetFrom('run')
    setSelectedWorkflow(wf)
    api.saveSettings({ selectedWorkflow: wf, selectedRun: null, selectedArtifact: null })
    setRunsState({ loading: true, error: null })
    try {
      const r = await api.listRuns(selectedRepo, wf.id)
      setRuns(r)
      setRunsState({ loading: false, error: null })
    } catch (e) {
      setRunsState({ loading: false, error: e.message })
    }
  }

  const pickRun = async (run) => {
    resetFrom('artifact')
    setSelectedRun(run)
    api.saveSettings({ selectedRun: run, selectedArtifact: null })
    setArtState({ loading: true, error: null })
    try {
      const a = await api.listArtifacts(selectedRepo, run.id)
      setArtifacts(a)
      setArtState({ loading: false, error: null })
    } catch (e) {
      setArtState({ loading: false, error: e.message })
    }
  }

  // Download + diff a selected artifact. Repo/run are passed explicitly so this
  // works both from a click (using component state) and from startup restore
  // (where that state hasn't settled yet).
  const runDiff = async ({ repo, runId, artifact, baselineFolder }) => {
    // Claim this diff as the current one; anything still in flight for an older
    // request id is now stale (the main process cancels its work too).
    const requestId = diffReqRef.current + 1
    diffReqRef.current = requestId
    const isCurrent = () => diffReqRef.current === requestId

    setDiffResult(null)
    if (!baselineFolder) {
      setDiffState({ loading: false, error: 'Select a baseline folder first (step 1).' })
      return
    }
    if (artifact.expired) {
      setDiffState({ loading: false, error: 'This artifact has expired and cannot be downloaded.' })
      return
    }
    setDiffProgress({ phase: 'download', message: 'Preparing…', requestId })
    setDiffState({ loading: true, error: null })
    try {
      const res = await api.downloadAndDiff({
        repo,
        runId,
        artifactId: artifact.id,
        artifactName: artifact.name,
        createdAt: artifact.createdAt,
        requestId
      })
      // Another artifact was selected while this diff was running — its result
      // owns the screen now.
      if (!isCurrent() || res?.cancelled) return
      setDiffResult(res)
      setDiffState({ loading: false, error: null })
    } catch (e) {
      if (!isCurrent()) return
      setDiffState({ loading: false, error: e.message })
    } finally {
      if (isCurrent()) setDiffProgress(null)
    }
  }

  const pickArtifact = async (artifact) => {
    setSelectedArtifact(artifact)
    api.saveSettings({ selectedArtifact: artifact })
    await runDiff({
      repo: selectedRepo,
      runId: selectedRun.id,
      artifact,
      baselineFolder: settings.baselineFolder
    })
  }

  // Stable identity: the diff viewer re-loads the selected entry's images
  // whenever this prop changes, so an inline arrow here would reload (and
  // visibly flash) the panes on every re-render of this component.
  const getImages = useCallback((key) => api.getImages(key), [])

  const resolveDiff = async (key) => {
    const updated = await api.resolveDiff(key)
    setDiffResult((prev) => {
      if (!prev) return prev
      const items = prev.items.map((it) => (it.key === key ? { ...it, ...updated } : it))
      const counts = items.reduce((acc, it) => {
        acc[it.status] = (acc[it.status] || 0) + 1
        return acc
      }, {})
      return { ...prev, items, counts }
    })
  }

  const toggleSidebar = () => {
    setSidebarCollapsed((v) => {
      const next = !v
      api.saveSettings({ sidebarCollapsed: next })
      return next
    })
  }

  const ready = settings.hasToken || user

  return (
    <div className={`app ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">⧉</span>
          <span className="brand-text">Quick Image Differ</span>
          <button
            className="collapse-btn"
            onClick={toggleSidebar}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
          >
            ‹
          </button>
        </div>

        <Setup
          settings={settings}
          user={user}
          onVerifyToken={verifyToken}
          onSelectFolder={selectFolder}
          busy={false}
        />

        <div className="card selectors">
          <div className="card-title">2 · GitHub source</div>

          <PopoverSelect
            label="Repository"
            value={selectedRepo}
            placeholder="Select a repository"
            items={repos}
            loading={reposState.loading}
            error={reposState.error}
            selectedId={selectedRepo}
            getId={(r) => r.fullName}
            getPrimary={(r) => r.fullName}
            getSecondary={(r) =>
              `${r.private ? 'private' : 'public'} · pushed ${new Date(r.pushedAt).toLocaleDateString()}`
            }
            onSelect={(r) => pickRepo(r.fullName)}
            onRefresh={loadRepos}
            disabled={!ready}
            disabledHint="Add a GitHub token first"
            emptyText="No repositories match."
            searchable
            searchPlaceholder="Filter repositories, or type owner/repo…"
            renderFooter={(query, close) => {
              const val = query.trim()
              if (!/^[^/]+\/[^/]+$/.test(val)) return null
              if (repos.some((r) => r.fullName.toLowerCase() === val.toLowerCase())) return null
              return (
                <button
                  className="popover-action"
                  onClick={() => {
                    pickRepo(val)
                    close()
                  }}
                >
                  Use “{val}”
                </button>
              )
            }}
          />

          <PopoverSelect
            label="Workflow"
            value={selectedWorkflow?.name || null}
            placeholder="Select a workflow"
            items={workflows}
            loading={wfState.loading}
            error={wfState.error}
            selectedId={selectedWorkflow?.id}
            getId={(w) => w.id}
            getPrimary={(w) => w.name}
            getSecondary={(w) => w.path}
            getBadge={(w) =>
              newWorkflowIds.has(w.id) ? <span className="badge st-new">New</span> : null
            }
            onSelect={pickWorkflow}
            onRefresh={refreshWorkflows}
            disabled={!selectedRepo}
            disabledHint="Select a repository first"
            emptyText="No workflows found."
            searchable
            searchPlaceholder="Filter workflows…"
          />

          <PopoverSelect
            label="Workflow run"
            value={selectedRun ? `#${selectedRun.runNumber} · ${selectedRun.headBranch || ''}` : null}
            placeholder="Select a run"
            items={runs}
            loading={runsState.loading}
            error={runsState.error}
            selectedId={selectedRun?.id}
            getId={(r) => r.id}
            getPrimary={(r) => `#${r.runNumber} · ${r.headBranch || ''}`}
            getSecondary={runSubtitle}
            getBadge={runBadge}
            onSelect={pickRun}
            onRefresh={refreshRuns}
            disabled={!selectedWorkflow}
            disabledHint="Select a workflow first"
            emptyText="No runs found."
            searchable
            searchPlaceholder="Filter runs…"
          />

          <PopoverSelect
            label="Artifact"
            value={selectedArtifact?.name || null}
            placeholder="Select an artifact"
            items={artifacts}
            loading={artState.loading}
            error={artState.error}
            selectedId={selectedArtifact?.id}
            getId={(a) => a.id}
            getPrimary={(a) => a.name}
            getBadge={(a) => {
              const when = formatDateTime(a.createdAt)
              return when ? (
                <span className="item-meta" title={new Date(a.createdAt).toLocaleString()}>
                  {when}
                </span>
              ) : null
            }}
            getSecondary={(a) =>
              `${(a.sizeInBytes / 1024).toFixed(0)} KB${a.expired ? ' · expired' : ''}`
            }
            onSelect={pickArtifact}
            onRefresh={refreshArtifacts}
            disabled={!selectedRun}
            disabledHint="Select a run first"
            emptyText="No artifacts on this run."
          />
        </div>
      </aside>

      <main className="main">
        {sidebarCollapsed && (
          <button
            className="expand-btn"
            onClick={toggleSidebar}
            title="Show sidebar"
            aria-label="Show sidebar"
          >
            ›
          </button>
        )}
        {globalError && <div className="banner error">{globalError}</div>}
        {diffState.loading ? (
          <div className="placeholder">
            <div className="spinner" />
            <p>{diffProgressMessage(diffProgress)}</p>
            {diffProgress?.phase === 'compare' && diffProgress.total > 0 && (
              <div className="progress-wrap">
                <div className="progress-bar">
                  <div
                    className="progress-fill"
                    style={{
                      width: `${Math.round((diffProgress.done / diffProgress.total) * 100)}%`
                    }}
                  />
                </div>
                <div className="muted progress-count">
                  {diffProgress.done} / {diffProgress.total} images compared
                </div>
              </div>
            )}
          </div>
        ) : diffState.error ? (
          <div className="placeholder">
            <div className="banner error">{diffState.error}</div>
          </div>
        ) : diffResult ? (
          <DiffViewer
            result={diffResult}
            getImages={getImages}
            onResolve={resolveDiff}
            baselineFolder={settings.baselineFolder}
          />
        ) : (
          <div className="placeholder">
            <div className="placeholder-art">⧉</div>
            <h2>Quick Image Differ</h2>
            <p>
              Configure a GitHub token and a baseline folder, then pick a repository, workflow,
              run and artifact. Its images will be compared against your baseline folder here.
            </p>
            <ol className="placeholder-steps">
              <li className={settings.hasToken || user ? 'done' : ''}>Add a GitHub token</li>
              <li className={settings.baselineFolder ? 'done' : ''}>Choose a baseline folder</li>
              <li className={selectedRepo ? 'done' : ''}>Select a repository</li>
              <li className={selectedWorkflow ? 'done' : ''}>Pick a workflow &amp; run</li>
              <li className={selectedArtifact ? 'done' : ''}>Select an artifact to diff</li>
            </ol>
          </div>
        )}
      </main>
    </div>
  )
}
