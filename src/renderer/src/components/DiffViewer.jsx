import React, { useEffect, useMemo, useRef, useState } from 'react'

const ZOOM_MIN = 0.1
const ZOOM_MAX = 8
const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))

const STATUS_META = {
  different: { label: 'Different', cls: 'st-different' },
  identical: { label: 'Identical', cls: 'st-identical' },
  added: { label: 'New (no baseline)', cls: 'st-added' },
  missing: { label: 'Missing from build', cls: 'st-missing' },
  error: { label: 'Error', cls: 'st-error' }
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'different', label: 'Different' },
  { key: 'added', label: 'New' },
  { key: 'missing', label: 'Missing' },
  { key: 'identical', label: 'Identical' }
]

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || { label: status, cls: '' }
  return <span className={`badge ${meta.cls}`}>{meta.label}</span>
}

// One image pane (label + image or placeholder). The image is scaled by the
// shared `zoom` so all panes render at the same magnification; `registerBody`
// and `onScroll` keep the panes' scroll positions in sync while zoomed in.
function Pane({ title, src, missingText, zoom, registerBody, onScroll }) {
  return (
    <div className="pane">
      <div className="pane-title">{title}</div>
      <div
        className="pane-body"
        ref={(el) => registerBody(title, el)}
        onScroll={onScroll}
      >
        {src ? (
          <img
            src={src}
            alt={title}
            className="pane-img"
            style={{ width: `${zoom * 100}%` }}
            draggable={false}
          />
        ) : (
          <div className="pane-missing">{missingText || 'No image'}</div>
        )}
      </div>
    </div>
  )
}

export default function DiffViewer({ result, getImages, onResolve, baselineFolder }) {
  const [filter, setFilter] = useState('different')
  const [selectedKey, setSelectedKey] = useState(null)
  const [images, setImages] = useState(null)
  const [imgLoading, setImgLoading] = useState(false)
  const [showSide, setShowSide] = useState(true)
  const [showDiff, setShowDiff] = useState(true)
  const [resolving, setResolving] = useState(false)
  const [notice, setNotice] = useState(null)
  const [zoom, setZoom] = useState(1)

  // Live pane-body elements, so scrolling one scrolls the others identically.
  const bodies = useRef({})
  const syncing = useRef(false)
  const registerBody = (title, el) => {
    if (el) bodies.current[title] = el
    else delete bodies.current[title]
  }
  const onPaneScroll = (e) => {
    if (syncing.current) return
    syncing.current = true
    const src = e.currentTarget
    for (const el of Object.values(bodies.current)) {
      if (el && el !== src) {
        el.scrollLeft = src.scrollLeft
        el.scrollTop = src.scrollTop
      }
    }
    window.requestAnimationFrame(() => {
      syncing.current = false
    })
  }
  const zoomBy = (factor) => setZoom((z) => clampZoom(Math.round(z * factor * 100) / 100))

  const items = result?.items || []

  const filtered = useMemo(() => {
    if (filter === 'all') return items
    return items.filter((i) => i.status === filter)
  }, [items, filter])

  // Keep a valid selection as filters/results change.
  useEffect(() => {
    if (filtered.length === 0) {
      setSelectedKey(null)
      return
    }
    if (!filtered.some((i) => i.key === selectedKey)) {
      setSelectedKey(filtered[0].key)
    }
  }, [filtered, selectedKey])

  // Load the three images for the selected entry.
  useEffect(() => {
    let cancelled = false
    if (!selectedKey) {
      setImages(null)
      return
    }
    setImgLoading(true)
    setNotice(null)
    getImages(selectedKey)
      .then((data) => {
        if (!cancelled) setImages(data)
      })
      .catch((e) => {
        if (!cancelled) setNotice(e.message)
      })
      .finally(() => {
        if (!cancelled) setImgLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [selectedKey, getImages])

  const selected = items.find((i) => i.key === selectedKey) || null

  const resolve = async () => {
    if (!selected) return
    setResolving(true)
    setNotice(null)
    try {
      await onResolve(selected.key)
      // Refresh the displayed images (baseline now matches artifact).
      const data = await getImages(selected.key)
      setImages(data)
      setNotice('Baseline updated from artifact image.')
    } catch (e) {
      setNotice(e.message)
    } finally {
      setResolving(false)
    }
  }

  const counts = result?.counts || {}
  const canResolve =
    selected && (selected.status === 'different' || selected.status === 'added')

  return (
    <div className="diffviewer">
      <div className="diff-toolbar">
        <div className="diff-summary">
          <strong>{result.artifactName}</strong>
          <span className="muted"> · {result.total} images</span>
          {result.strippedPrefix && (
            <span className="muted" title="Common leading folder stripped from the artifact so its folders line up with the baseline">
              {' '}· aligned from <code>{result.strippedPrefix}/</code>
            </span>
          )}
          <span className="chips">
            <span className="chip st-different">{counts.different || 0} different</span>
            <span className="chip st-added">{counts.added || 0} new</span>
            <span className="chip st-missing">{counts.missing || 0} missing</span>
            <span className="chip st-identical">{counts.identical || 0} identical</span>
          </span>
        </div>
        <div className="toolbar-actions">
          <div className="zoom-controls" title="Zoom (applies to all images)">
            <button className="zoom-btn" onClick={() => zoomBy(1 / 1.25)} aria-label="Zoom out">
              −
            </button>
            <button
              className="zoom-readout"
              onClick={() => setZoom(1)}
              title="Reset to 100%"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button className="zoom-btn" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
              +
            </button>
          </div>
          <div className="view-toggles">
            <label className={showSide ? 'on' : ''}>
              <input type="checkbox" checked={showSide} onChange={(e) => setShowSide(e.target.checked)} />
              Side&nbsp;by&nbsp;side
            </label>
            <label className={showDiff ? 'on' : ''}>
              <input type="checkbox" checked={showDiff} onChange={(e) => setShowDiff(e.target.checked)} />
              Diff
            </label>
          </div>
        </div>
      </div>

      <div className="diff-body">
        <div className="diff-list">
          <div className="filter-tabs">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                className={`filter-tab ${filter === f.key ? 'active' : ''}`}
                onClick={() => setFilter(f.key)}
              >
                {f.label}
                <span className="filter-count">
                  {f.key === 'all' ? items.length : counts[f.key] || 0}
                </span>
              </button>
            ))}
          </div>
          <ul className="entry-list">
            {filtered.length === 0 && <li className="entry-empty">No images in this category.</li>}
            {filtered.map((item) => (
              <li key={item.key}>
                <button
                  className={`entry ${item.key === selectedKey ? 'selected' : ''}`}
                  onClick={() => setSelectedKey(item.key)}
                >
                  <span className="entry-name" title={item.name}>
                    {item.name}
                  </span>
                  <span className="entry-meta">
                    <StatusBadge status={item.status} />
                    {item.status === 'different' && (
                      <span className="entry-pct">{item.diffPercent.toFixed(1)}%</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="diff-detail">
          {!selected ? (
            <div className="detail-empty">Select an image to compare.</div>
          ) : (
            <>
              <div className="detail-head">
                <div>
                  <div className="detail-name">{selected.name}</div>
                  <div className="detail-sub">
                    <StatusBadge status={selected.status} />
                    {selected.status === 'different' && (
                      <span className="muted">
                        {selected.diffPixels.toLocaleString()} px ·{' '}
                        {selected.diffPercent.toFixed(2)}%
                        {selected.sizeChanged && ' · dimensions changed'}
                      </span>
                    )}
                    {selected.status === 'different' && !selected.decodable && (
                      <span className="muted">binary difference (no pixel diff for this format)</span>
                    )}
                  </div>
                </div>
                {canResolve && (
                  <button className="btn resolve-btn" onClick={resolve} disabled={resolving}>
                    {resolving
                      ? 'Copying…'
                      : selected.status === 'added'
                        ? 'Add to baseline'
                        : 'Copy artifact → baseline'}
                  </button>
                )}
              </div>

              {notice && <div className="detail-notice">{notice}</div>}

              {imgLoading ? (
                <div className="detail-empty">Loading images…</div>
              ) : (
                <div className={`panes cols-${(showSide ? 2 : 0) + (showDiff ? 1 : 0) || 1}`}>
                  {showSide && (
                    <>
                      <Pane
                        title="Artifact"
                        src={images?.artifact}
                        missingText="Not in artifact"
                        zoom={zoom}
                        registerBody={registerBody}
                        onScroll={onPaneScroll}
                      />
                      <Pane
                        title="Baseline"
                        src={images?.baseline}
                        missingText="No baseline image"
                        zoom={zoom}
                        registerBody={registerBody}
                        onScroll={onPaneScroll}
                      />
                    </>
                  )}
                  {showDiff && (
                    <Pane
                      title="Diff"
                      src={images?.diff}
                      missingText={
                        selected.decodable ? 'Identical — no diff' : 'Diff unavailable for this format'
                      }
                      zoom={zoom}
                      registerBody={registerBody}
                      onScroll={onPaneScroll}
                    />
                  )}
                  {!showSide && !showDiff && (
                    <div className="detail-empty">Enable a view mode above.</div>
                  )}
                </div>
              )}

              {selected.status === 'missing' && (
                <p className="hint">
                  This image exists in the baseline folder but was not produced by the build.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
