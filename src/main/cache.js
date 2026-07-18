// On-disk cache of downloaded artifact zips, capped at a fixed total size.
//
// Artifacts on GitHub are immutable (each build produces a new artifact id), so
// a cached zip for a given id never goes stale on its own. As a safeguard we
// still re-download if the requested artifact reports a newer `createdAt` than
// the cached copy. When the cache exceeds its size cap, the least-recently
// accessed artifacts are evicted.
import fs from 'node:fs'
import path from 'node:path'

const MAX_BYTES = 300 * 1024 * 1024 // 300 MB

export class ArtifactCache {
  constructor(app, maxBytes = MAX_BYTES) {
    this.dir = path.join(app.getPath('userData'), 'artifact-cache')
    this.indexFile = path.join(this.dir, 'index.json')
    this.maxBytes = maxBytes
    fs.mkdirSync(this.dir, { recursive: true })
    this.index = this._readIndex()
  }

  _readIndex() {
    try {
      return JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
    } catch {
      return {}
    }
  }

  _writeIndex() {
    try {
      fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2))
    } catch {
      /* best-effort */
    }
  }

  _zipPath(id) {
    return path.join(this.dir, `${id}.zip`)
  }

  // Return the cached zip Buffer for this artifact, or null on a miss / when a
  // newer copy is available upstream.
  get(artifactId, createdAt) {
    const meta = this.index[artifactId]
    if (!meta) return null

    // Requested artifact is newer than what we stored -> treat as a miss.
    if (createdAt && meta.createdAt && new Date(createdAt) > new Date(meta.createdAt)) {
      return null
    }

    const zp = this._zipPath(artifactId)
    if (!fs.existsSync(zp)) {
      delete this.index[artifactId]
      this._writeIndex()
      return null
    }

    meta.lastAccess = Date.now()
    this._writeIndex()
    return fs.readFileSync(zp)
  }

  // Store a freshly-downloaded zip, then evict LRU entries to stay under the cap.
  put(artifactId, name, createdAt, buffer) {
    try {
      fs.writeFileSync(this._zipPath(artifactId), buffer)
    } catch {
      return // if we can't write the cache, just skip caching
    }
    this.index[artifactId] = {
      id: String(artifactId),
      name,
      createdAt: createdAt || null,
      bytes: buffer.length,
      cachedAt: new Date().toISOString(),
      lastAccess: Date.now()
    }
    this._evict(String(artifactId))
    this._writeIndex()
  }

  totalBytes() {
    return Object.values(this.index).reduce((sum, m) => sum + (m.bytes || 0), 0)
  }

  // Remove least-recently-accessed entries until under the cap, never evicting
  // the entry just added (keepId).
  _evict(keepId) {
    let total = this.totalBytes()
    if (total <= this.maxBytes) return
    const candidates = Object.values(this.index)
      .filter((m) => String(m.id) !== String(keepId))
      .sort((a, b) => (a.lastAccess || 0) - (b.lastAccess || 0))
    for (const m of candidates) {
      if (total <= this.maxBytes) break
      try {
        fs.rmSync(this._zipPath(m.id), { force: true })
      } catch {
        /* ignore */
      }
      total -= m.bytes || 0
      delete this.index[m.id]
    }
  }
}
