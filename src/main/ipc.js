// Registers all IPC handlers used by the renderer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'

import { GitHubClient } from './github'
import { ArtifactCache } from './cache'
import { DiffWorkerPool } from './worker-pool'
import {
  collectImages,
  alignArtifactKeys,
  fileToDataUrl,
  bufferToDataUrl
} from './imagediff'

// Holds the results of the most recent diff so the renderer can lazily fetch
// image data and resolve individual entries without recomputing everything.
// key -> { status, artifactPath, baselinePath, diffPng, ... }
let session = { baselineRoot: null, entries: new Map() }

// The diff currently being computed. Starting a new diff cancels the previous
// one: it stops emitting progress, releases its queued worker tasks and never
// publishes its results (or its `session`), so a superseded diff can't fight
// with the current one over the renderer's progress/result state.
let activeDiff = null

function parseRepo(fullName) {
  const [owner, name] = String(fullName).split('/')
  return { owner, name }
}

export function registerIpc(app, store) {
  const cache = new ArtifactCache(app)
  // Persistent pool of worker threads that do the CPU-bound image comparison,
  // so downloads/diffs never block the main process (or, in turn, the UI).
  const pool = new DiffWorkerPool()
  app.on('will-quit', () => pool.destroy())
  const client = () => {
    const token = store.get('token')
    if (!token) throw new Error('No GitHub token configured. Add one in Setup.')
    return new GitHubClient(token)
  }

  // ---- Settings ---------------------------------------------------------
  ipcMain.handle('settings:get', () => {
    const all = store.getAll()
    // Never ship the raw token to the renderer; report only whether it exists.
    const { token, ...rest } = all
    return { ...rest, hasToken: Boolean(token) }
  })

  ipcMain.handle('settings:set', (_e, patch) => {
    store.set(patch || {})
    const all = store.getAll()
    const { token, ...rest } = all
    return { ...rest, hasToken: Boolean(token) }
  })

  // ---- Folder picker ----------------------------------------------------
  ipcMain.handle('dialog:selectFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win, {
      title: 'Select baseline image folder',
      properties: ['openDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    store.set({ baselineFolder: folder })
    return folder
  })

  ipcMain.handle('shell:openExternal', (_e, url) => shell.openExternal(url))

  // ---- GitHub -----------------------------------------------------------
  ipcMain.handle('github:verifyToken', async (_e, token) => {
    const gh = new GitHubClient(token)
    const user = await gh.getUser()
    store.set({ token })
    return { login: user.login, name: user.name, avatarUrl: user.avatar_url }
  })

  ipcMain.handle('github:whoami', async () => {
    if (!store.get('token')) return null
    try {
      const user = await client().getUser()
      return { login: user.login, name: user.name, avatarUrl: user.avatar_url }
    } catch {
      return null
    }
  })

  ipcMain.handle('github:listRepos', async () => client().listRepos())

  ipcMain.handle('github:getRepo', async (_e, fullName) => {
    const { owner, name } = parseRepo(fullName)
    return client().getRepo(owner, name)
  })

  ipcMain.handle('github:listWorkflows', async (_e, fullName) => {
    const { owner, name } = parseRepo(fullName)
    return client().listWorkflows(owner, name)
  })

  ipcMain.handle('github:listRuns', async (_e, { repo, workflowId }) => {
    const { owner, name } = parseRepo(repo)
    return client().listRuns(owner, name, workflowId)
  })

  ipcMain.handle('github:listArtifacts', async (_e, { repo, runId }) => {
    const { owner, name } = parseRepo(repo)
    const artifacts = await client().listArtifacts(owner, name, runId)
    // Hide diff-output artifacts (named "diff-…") from the selector, and show
    // the newest uploads first. Artifacts without a creation time sort last.
    return artifacts
      .filter((a) => !a.name.startsWith('diff-'))
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
  })

  // ---- Download artifact + diff against baseline ------------------------
  ipcMain.handle('diff:download', async (
    _e,
    { repo, runId, artifactId, artifactName, createdAt, requestId = null }
  ) => {
    // Supersede any diff still running: it may have hundreds of image
    // comparisons queued, and both diffs would otherwise stream progress at the
    // renderer at once.
    if (activeDiff) activeDiff.cancelled = true
    const job = { requestId, cancelled: false }
    activeDiff = job
    const cancelled = () => job.cancelled

    // Report progress back to the renderer so the loading screen can show what
    // is happening (download → extract → compare N images). Progress carries the
    // request id so the renderer can tell whose progress it is receiving.
    const progress = (payload) => {
      if (job.cancelled) return
      try {
        _e.sender.send('diff:progress', { ...payload, requestId })
      } catch {
        /* window may have closed */
      }
    }

    const baselineRoot = store.get('baselineFolder')
    if (!baselineRoot) throw new Error('Select a baseline folder first.')
    if (!fs.existsSync(baselineRoot)) throw new Error(`Baseline folder not found: ${baselineRoot}`)

    const { owner, name } = parseRepo(repo)
    // Serve from the local cache when we already have this artifact (and it is
    // not newer upstream); otherwise download and cache it.
    let zipBuf = cache.get(artifactId, createdAt)
    const fromCache = zipBuf !== null
    if (!fromCache) {
      progress({ phase: 'download', message: 'Downloading artifact…' })
      zipBuf = await client().downloadArtifactZip(owner, name, artifactId)
      cache.put(artifactId, artifactName, createdAt, zipBuf)
    } else {
      progress({ phase: 'download', message: 'Loading artifact from cache…' })
    }

    if (cancelled()) return { cancelled: true, requestId }

    // Extract into a fresh temp dir.
    progress({ phase: 'extract', message: 'Extracting artifact…' })
    const destDir = path.join(os.tmpdir(), 'quick-image-differ', `${runId}-${artifactId}`)
    fs.rmSync(destDir, { recursive: true, force: true })
    fs.mkdirSync(destDir, { recursive: true })
    new AdmZip(zipBuf).extractAllTo(destDir, true)

    const baselineImages = collectImages(baselineRoot)
    // Align the artifact's directory tree to the baseline's (strips a common
    // leading wrapper directory so same-named folders are compared together).
    const { images: artifactImages, strippedPrefix } = alignArtifactKeys(
      collectImages(destDir),
      baselineImages
    )

    const keys = Array.from(new Set([...artifactImages.keys(), ...baselineImages.keys()])).sort()

    const entries = new Map()
    const pairTasks = []
    let taskId = 0

    // First pass (cheap, on the main thread): create every entry and resolve the
    // trivial statuses; queue the real image comparisons as worker tasks.
    for (const key of keys) {
      const artifactPath = artifactImages.get(key) || null
      const baselinePath = baselineImages.get(key) || null
      const entry = {
        key,
        name: key,
        artifactPath,
        // Target path in the baseline folder (used when resolving/added images).
        baselineTarget: path.join(baselineRoot, ...key.split('/')),
        baselinePath,
        status: 'unknown',
        diffPixels: 0,
        diffPercent: 0,
        sizeChanged: false,
        decodable: false,
        error: null,
        diffPng: null
      }
      entries.set(key, entry)

      if (artifactPath && !baselinePath) {
        entry.status = 'added' // only in artifact, no baseline yet
      } else if (!artifactPath && baselinePath) {
        entry.status = 'missing' // in baseline but not produced by the build
      } else {
        pairTasks.push({ id: taskId++, key, artifactPath, baselinePath })
      }
    }

    // Second pass: run the comparisons on the worker pool (in parallel, off the
    // main thread), updating progress as each result arrives.
    const total = keys.length
    let processed = total - pairTasks.length
    const step = Math.max(1, Math.floor(total / 100))
    progress({ phase: 'compare', message: 'Comparing images…', done: processed, total })

    await Promise.all(
      pairTasks.map((task) =>
        pool.run(task, cancelled).then((res) => {
          // Task was dropped because this diff was superseded, or the result
          // arrived after the fact — either way it is no longer wanted.
          if (res.cancelled || job.cancelled) return
          const entry = entries.get(res.key)
          entry.status = res.status
          entry.diffPixels = res.diffPixels
          entry.diffPercent = res.diffPercent
          entry.sizeChanged = res.sizeChanged
          entry.decodable = res.decodable
          entry.error = res.error
          entry.diffPng = res.diffPng
          processed++
          if (processed % step === 0 || processed === total) {
            progress({ phase: 'compare', done: processed, total })
          }
        })
      )
    )

    // A superseded diff must not publish its results or overwrite `session` —
    // the entries the renderer is showing belong to the newer diff.
    if (cancelled()) return { cancelled: true, requestId }

    // Build the summary in sorted key order (results arrive out of order).
    const summary = keys.map((key) => {
      const e = entries.get(key)
      return {
        key: e.key,
        name: e.name,
        status: e.status,
        diffPixels: e.diffPixels,
        diffPercent: e.diffPercent,
        sizeChanged: e.sizeChanged,
        decodable: e.decodable,
        hasArtifact: Boolean(e.artifactPath),
        hasBaseline: Boolean(e.baselinePath),
        error: e.error
      }
    })

    session = { baselineRoot, extractDir: destDir, artifactName, entries }
    if (activeDiff === job) activeDiff = null

    const counts = summary.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1
      return acc
    }, {})

    return {
      requestId,
      artifactName,
      strippedPrefix,
      fromCache,
      total: summary.length,
      counts,
      items: summary
    }
  })

  // ---- Lazily fetch the three images for one entry ----------------------
  ipcMain.handle('diff:getImages', (_e, key) => {
    const entry = session.entries.get(key)
    if (!entry) throw new Error('Unknown diff entry (results may be stale).')
    return {
      key,
      artifact: entry.artifactPath ? fileToDataUrl(entry.artifactPath) : null,
      baseline: entry.baselinePath ? fileToDataUrl(entry.baselinePath) : null,
      diff: entry.diffPng ? bufferToDataUrl(entry.diffPng, 'image/png') : null
    }
  })

  // ---- Resolve a diff: copy artifact image into the baseline folder -----
  ipcMain.handle('diff:resolve', (_e, key) => {
    const entry = session.entries.get(key)
    if (!entry) throw new Error('Unknown diff entry (results may be stale).')
    if (!entry.artifactPath) throw new Error('No artifact image to copy for this entry.')

    const target = entry.baselineTarget
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(entry.artifactPath, target)

    // Update the entry to reflect the new baseline.
    entry.baselinePath = target
    entry.status = 'identical'
    entry.diffPixels = 0
    entry.diffPercent = 0
    entry.sizeChanged = false
    entry.diffPng = null

    return {
      key,
      status: entry.status,
      diffPixels: 0,
      diffPercent: 0,
      sizeChanged: false,
      hasBaseline: true
    }
  })
}
