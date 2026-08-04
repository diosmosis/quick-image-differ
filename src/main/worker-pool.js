// A small pool of worker threads that compare image pairs in parallel. Tasks
// are queued and dispatched to the first idle worker; results come back via the
// promise returned by run(). A crashed worker is replaced and its in-flight
// task is resolved as an error so a diff never hangs.
//
// A task may carry an `isCancelled` predicate: queued tasks belonging to a
// superseded diff are dropped at dispatch time (resolved as `{ cancelled: true }`)
// so a newly requested diff isn't stuck behind hundreds of obsolete comparisons.
import { Worker } from 'node:worker_threads'
import os from 'node:os'
import path from 'node:path'

function defaultSize() {
  const cores = os.cpus()?.length || 2
  return Math.max(1, Math.min(cores - 1, 8))
}

export class DiffWorkerPool {
  constructor(size) {
    this.workerPath = path.join(__dirname, 'diff-worker.js')
    this.size = size || defaultSize()
    this.queue = []
    this.records = []
    this.destroyed = false
    for (let i = 0; i < this.size; i++) this.records.push(this._make())
  }

  _make() {
    const rec = { worker: null, job: null }
    const worker = new Worker(this.workerPath)
    rec.worker = worker

    worker.on('message', (result) => {
      const job = rec.job
      rec.job = null
      if (job) {
        // Buffers arrive as Uint8Array through structured clone; restore Buffer
        // so downstream `.toString('base64')` works.
        if (result.diffPng) result.diffPng = Buffer.from(result.diffPng)
        job.resolve(result)
      }
      this._drain()
    })

    worker.on('error', (err) => {
      const job = rec.job
      rec.job = null
      // Replace the crashed worker.
      const idx = this.records.indexOf(rec)
      if (idx >= 0) this.records.splice(idx, 1)
      if (!this.destroyed) this.records.push(this._make())
      if (job) {
        job.resolve({
          id: job.payload.id,
          key: job.payload.key,
          status: 'error',
          diffPixels: 0,
          diffPercent: 0,
          sizeChanged: false,
          decodable: false,
          error: `worker failed: ${err.message}`,
          diffPng: null
        })
      }
      this._drain()
    })

    return rec
  }

  _drain() {
    // Drop queued tasks whose diff has been superseded before dispatching any
    // work, so the pool is immediately free for the current diff.
    if (this.queue.length) {
      const alive = []
      for (const job of this.queue) {
        if (job.isCancelled?.()) {
          job.resolve({ id: job.payload.id, key: job.payload.key, cancelled: true })
        } else {
          alive.push(job)
        }
      }
      this.queue = alive
    }

    for (const rec of this.records) {
      if (rec.job || this.queue.length === 0) continue
      const job = this.queue.shift()
      rec.job = job
      rec.worker.postMessage(job.payload)
    }
  }

  // payload: { id, key, artifactPath, baselinePath }
  // isCancelled: optional predicate; when it returns true while the task is
  // still queued, the task is discarded and resolves as { cancelled: true }.
  run(payload, isCancelled) {
    return new Promise((resolve) => {
      this.queue.push({ payload, resolve, isCancelled })
      this._drain()
    })
  }

  async destroy() {
    this.destroyed = true
    const recs = this.records
    this.records = []
    await Promise.all(recs.map((r) => r.worker.terminate().catch(() => {})))
  }
}
