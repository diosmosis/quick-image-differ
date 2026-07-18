// Image discovery, comparison and diff-image generation.
import fs from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import jpeg from 'jpeg-js'
import pixelmatch from 'pixelmatch'

// Extensions we treat as images. Only PNG and JPEG can be pixel-diffed; the
// others can still be listed and compared byte-for-byte.
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp'])
export const DECODABLE = new Set(['.png', '.jpg', '.jpeg'])

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp'
}

export function isImage(file) {
  return IMAGE_EXTS.has(path.extname(file).toLowerCase())
}

// Recursively collect image files under `root`, keyed by their POSIX relative path.
export function collectImages(root) {
  const out = new Map()
  if (!root || !fs.existsSync(root)) return out
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile() && isImage(entry.name)) {
        const rel = path.relative(root, full).split(path.sep).join('/')
        out.set(rel, full)
      }
    }
  }
  walk(root)
  return out
}

// Align an artifact's image tree to the baseline's directory structure.
//
// GitHub artifacts frequently extract with an extra leading directory (e.g.
// `my-artifact/screenshots/home.png`) that the baseline folder does not have
// (`screenshots/home.png`). Without alignment every image would show up as
// "added"/"missing". This detects a common leading directory prefix on the
// artifact images and strips it so that folders line up with the same-named
// folders in the baseline — i.e. it compares matching directories together.
//
// Returns { images: Map<normalizedRelPath, absPath>, strippedPrefix }.
export function alignArtifactKeys(artifactMap, baselineMap) {
  const artifactKeys = [...artifactMap.keys()]
  if (artifactKeys.length === 0) return { images: new Map(), strippedPrefix: '' }

  // Longest leading directory path shared by every artifact image.
  let commonSegments = artifactKeys[0].split('/').slice(0, -1)
  for (const key of artifactKeys.slice(1)) {
    const segs = key.split('/').slice(0, -1)
    let i = 0
    while (i < commonSegments.length && i < segs.length && commonSegments[i] === segs[i]) i++
    commonSegments = commonSegments.slice(0, i)
  }

  // Try stripping 0..commonSegments.length leading segments; keep whichever
  // prefix makes the most artifact paths line up with a baseline path. Ties
  // prefer the shortest prefix (strip as little as possible).
  let best = { count: -1, depth: 0 }
  for (let depth = 0; depth <= commonSegments.length; depth++) {
    const prefix = commonSegments.slice(0, depth).join('/')
    let count = 0
    for (const key of artifactKeys) {
      const stripped = prefix ? key.slice(prefix.length + 1) : key
      if (baselineMap.has(stripped)) count++
    }
    if (count > best.count) best = { count, depth }
  }

  const prefix = commonSegments.slice(0, best.depth).join('/')
  const images = new Map()
  for (const [key, abs] of artifactMap) {
    const normalized = prefix ? key.slice(prefix.length + 1) : key
    images.set(normalized, abs)
  }
  return { images, strippedPrefix: prefix }
}

export function decode(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const buf = fs.readFileSync(filePath)
  if (ext === '.png') {
    const png = PNG.sync.read(buf)
    return { width: png.width, height: png.height, data: png.data }
  }
  if (ext === '.jpg' || ext === '.jpeg') {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 })
    return { width: img.width, height: img.height, data: img.data }
  }
  return null
}

// Copy an RGBA image into a new buffer of size w x h (padding with transparency).
function placeInto(img, w, h) {
  const out = Buffer.alloc(w * h * 4)
  const rows = Math.min(img.height, h)
  const cols = Math.min(img.width, w)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const si = (y * img.width + x) * 4
      const di = (y * w + x) * 4
      out[di] = img.data[si]
      out[di + 1] = img.data[si + 1]
      out[di + 2] = img.data[si + 2]
      out[di + 3] = img.data[si + 3]
    }
  }
  return out
}

// Compare two decoded images. Returns { mismatch, total, diffPng, sizeChanged }.
export function diffDecoded(a, b) {
  const w = Math.max(a.width, b.width)
  const h = Math.max(a.height, b.height)
  const ad = placeInto(a, w, h)
  const bd = placeInto(b, w, h)
  const diff = new PNG({ width: w, height: h })
  const mismatch = pixelmatch(ad, bd, diff.data, w, h, {
    threshold: 0.1,
    alpha: 0.2,
    includeAA: false
  })
  return {
    mismatch,
    total: w * h,
    diffPng: PNG.sync.write(diff),
    sizeChanged: a.width !== b.width || a.height !== b.height
  }
}

// Compare a single artifact/baseline image pair. Pure and self-contained so it
// can run on a worker thread. Returns the per-image diff outcome.
export function compareImagePair(artifactPath, baselinePath) {
  const result = {
    status: 'unknown',
    diffPixels: 0,
    diffPercent: 0,
    sizeChanged: false,
    decodable: false,
    error: null,
    diffPng: null
  }
  try {
    const a = decode(artifactPath)
    const b = decode(baselinePath)
    if (a && b) {
      result.decodable = true
      const { mismatch, total, diffPng, sizeChanged } = diffDecoded(a, b)
      result.diffPng = diffPng
      result.diffPixels = mismatch
      result.diffPercent = total ? (mismatch / total) * 100 : 0
      result.sizeChanged = sizeChanged
      result.status = mismatch === 0 && !sizeChanged ? 'identical' : 'different'
    } else {
      // Undecodable format (gif/bmp/webp): fall back to byte comparison.
      const same =
        fs.statSync(artifactPath).size === fs.statSync(baselinePath).size &&
        fs.readFileSync(artifactPath).equals(fs.readFileSync(baselinePath))
      result.status = same ? 'identical' : 'different'
    }
  } catch (err) {
    result.status = 'error'
    result.error = err.message
  }
  return result
}

export function fileToDataUrl(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mime = MIME[ext] || 'application/octet-stream'
  const buf = fs.readFileSync(filePath)
  return `data:${mime};base64,${buf.toString('base64')}`
}

export function bufferToDataUrl(buf, mime) {
  return `data:${mime};base64,${buf.toString('base64')}`
}
