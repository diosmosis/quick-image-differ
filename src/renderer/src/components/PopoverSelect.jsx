import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

// A compact selector: a single-line trigger button showing the current value,
// which opens a floating, scrollable (optionally searchable) list of choices.
// The popover is rendered in a portal with fixed positioning so it is never
// clipped by the sidebar and can extend over the main panel.
export default function PopoverSelect({
  label,
  value, // display string for the current selection, or null
  placeholder = 'Select…',
  items,
  loading,
  error,
  disabled = false,
  disabledHint,
  emptyText = 'Nothing to show.',
  selectedId,
  getId,
  getPrimary,
  getSecondary,
  getBadge,
  onSelect,
  onRefresh,
  searchable = false,
  searchPlaceholder = 'Filter…',
  renderFooter
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const popRef = useRef(null)

  const place = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const width = Math.min(Math.max(r.width, 340), window.innerWidth - 16)
    const left = Math.min(r.left, window.innerWidth - width - 8)
    const top = r.bottom + 4
    const maxHeight = Math.max(200, window.innerHeight - top - 12)
    setPos({ top, left, width, maxHeight })
  }

  const openPopover = () => {
    if (disabled) return
    setQuery('')
    place()
    setOpen(true)
  }

  useLayoutEffect(() => {
    if (open) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (popRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setOpen(false)
    const onScrollResize = () => place()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onScrollResize)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onScrollResize)
    }
  }, [open])

  const q = query.trim().toLowerCase()
  const filtered =
    searchable && q
      ? (items || []).filter((it) => String(getPrimary(it)).toLowerCase().includes(q))
      : items || []

  const choose = (item) => {
    onSelect(item)
    setOpen(false)
  }

  const footer = renderFooter ? renderFooter(query, () => setOpen(false)) : null

  return (
    <div className="selector">
      <div className="selector-label">{label}</div>
      <button
        type="button"
        ref={triggerRef}
        className={`selector-trigger ${open ? 'open' : ''}`}
        onClick={() => (open ? setOpen(false) : openPopover())}
        disabled={disabled}
        title={disabled ? disabledHint : value || placeholder}
      >
        <span className={`selector-value ${value ? '' : 'placeholder'}`}>
          {disabled ? disabledHint : value || placeholder}
        </span>
        <span className="selector-caret">▾</span>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="popover"
            style={{ top: pos.top, left: pos.left, width: pos.width, maxHeight: pos.maxHeight }}
          >
            {(searchable || onRefresh) && (
              <div className="popover-head">
                {searchable ? (
                  <input
                    autoFocus
                    type="text"
                    className="popover-search"
                    placeholder={searchPlaceholder}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                ) : (
                  <span className="popover-title">{label}</span>
                )}
                {onRefresh && (
                  <button className="link-btn" onClick={onRefresh} disabled={loading}>
                    {loading ? '…' : 'Refresh'}
                  </button>
                )}
              </div>
            )}

            {error ? (
              <div className="popover-hint error">{error}</div>
            ) : loading ? (
              <div className="popover-hint">Loading…</div>
            ) : filtered.length === 0 ? (
              <div className="popover-hint">{emptyText}</div>
            ) : (
              <ul className="popover-list">
                {filtered.map((item) => {
                  const id = getId(item)
                  const badge = getBadge ? getBadge(item) : null
                  return (
                    <li key={id}>
                      <button
                        className={`popover-item ${String(selectedId) === String(id) ? 'selected' : ''}`}
                        onClick={() => choose(item)}
                      >
                        <div className="popover-item-main">
                          <span className="popover-item-primary">{getPrimary(item)}</span>
                          {badge}
                        </div>
                        {getSecondary && (
                          <span className="popover-item-secondary">{getSecondary(item)}</span>
                        )}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}

            {footer && <div className="popover-footer">{footer}</div>}
          </div>,
          document.body
        )}
    </div>
  )
}
