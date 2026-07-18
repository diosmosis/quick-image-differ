// Worker thread: compares one artifact/baseline image pair per message so the
// main process stays free while pixelmatch (synchronous, CPU-bound) runs.
import { parentPort } from 'node:worker_threads'
import { compareImagePair } from './imagediff'

parentPort.on('message', (task) => {
  const result = compareImagePair(task.artifactPath, task.baselinePath)
  // Echo id/key so the pool can match the result to its task.
  parentPort.postMessage({ id: task.id, key: task.key, ...result })
})
