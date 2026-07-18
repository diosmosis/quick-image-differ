// Registers all IPC handlers used by the renderer.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import AdmZip from 'adm-zip'

import { GitHubClient } from './github'
import {
  collectImages,
  alignArtifactKeys,
  decode,
  diffDecoded,
  fileToDataUrl,
  bufferToDataUrl
} from './imagediff'

// Holds the results of the most recent diff so the renderer can lazily fetch
// image data and resolve individual entries without recomputing everything.
// key -> { status, artifactPath, baselinePath, diffPng, ... }
let session = { baselineRoot: null, entries: new Map() }

function parseRepo(fullName) {
  const [owner, name] = String(fullName).split('/')
  return { owner, name }
}

export function registerIpc(app, store) {
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
    return client().listArtifacts(owner, name, runId)
  })

  // ---- Download artifact + diff against baseline ------------------------
  ipcMain.handle('diff:download', async (_e, { repo, runId, artifactId, artifactName }) => {
    const baselineRoot = store.get('baselineFolder')
    if (!baselineRoot) throw new Error('Select a baseline folder first.')
    if (!fs.existsSync(baselineRoot)) throw new Error(`Baseline folder not found: ${baselineRoot}`)

    const { owner, name } = parseRepo(repo)
    const zipBuf = await client().downloadArtifactZip(owner, name, artifactId)

    // Extract into a fresh temp dir.
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
    const summary = []

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

      try {
        if (artifactPath && !baselinePath) {
          entry.status = 'added' // only in artifact, no baseline yet
        } else if (!artifactPath && baselinePath) {
          entry.status = 'missing' // in baseline but not produced by the build
        } else {
          const a = decode(artifactPath)
          const b = decode(baselinePath)
          if (a && b) {
            entry.decodable = true
            const { mismatch, total, diffPng, sizeChanged } = diffDecoded(a, b)
            entry.diffPng = diffPng
            entry.diffPixels = mismatch
            entry.diffPercent = total ? (mismatch / total) * 100 : 0
            entry.sizeChanged = sizeChanged
            entry.status = mismatch === 0 && !sizeChanged ? 'identical' : 'different'
          } else {
            // Undecodable format (gif/bmp/webp): fall back to byte comparison.
            const same =
              fs.statSync(artifactPath).size === fs.statSync(baselinePath).size &&
              fs.readFileSync(artifactPath).equals(fs.readFileSync(baselinePath))
            entry.status = same ? 'identical' : 'different'
          }
        }
      } catch (err) {
        entry.status = 'error'
        entry.error = err.message
      }

      entries.set(key, entry)
      summary.push({
        key: entry.key,
        name: entry.name,
        status: entry.status,
        diffPixels: entry.diffPixels,
        diffPercent: entry.diffPercent,
        sizeChanged: entry.sizeChanged,
        decodable: entry.decodable,
        hasArtifact: Boolean(artifactPath),
        hasBaseline: Boolean(baselinePath),
        error: entry.error
      })
    }

    session = { baselineRoot, extractDir: destDir, artifactName, entries }

    const counts = summary.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1
      return acc
    }, {})

    return { artifactName, strippedPrefix, total: summary.length, counts, items: summary }
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
