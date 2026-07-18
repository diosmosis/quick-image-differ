import React, { useState } from 'react'

// Token + baseline-folder configuration. Sits at the top of the sidebar.
export default function Setup({ settings, user, onVerifyToken, onSelectFolder, busy }) {
  const [token, setToken] = useState('')
  const [error, setError] = useState(null)
  const [verifying, setVerifying] = useState(false)

  const verify = async () => {
    setError(null)
    setVerifying(true)
    try {
      await onVerifyToken(token.trim())
      setToken('')
    } catch (e) {
      setError(e.message)
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="setup card">
      <div className="card-title">1 · GitHub &amp; baseline</div>

      <div className="field">
        <label>GitHub token</label>
        {user ? (
          <div className="token-ok">
            {user.avatarUrl && <img src={user.avatarUrl} alt="" className="avatar" />}
            <span>
              Signed in as <strong>{user.login}</strong>
            </span>
            <button className="link-btn" onClick={() => onVerifyToken('__clear__')} disabled={busy}>
              Change
            </button>
          </div>
        ) : (
          <>
            <div className="token-row">
              <input
                type="password"
                placeholder="ghp_… or github_pat_…"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && token.trim() && verify()}
              />
              <button className="btn" onClick={verify} disabled={!token.trim() || verifying}>
                {verifying ? 'Checking…' : 'Save'}
              </button>
            </div>
            <p className="hint">
              A fine-grained token needs read access to <em>Actions</em> and{' '}
              <em>Contents</em>; a classic token needs the <code>repo</code> scope.
            </p>
            {error && <div className="field-error">{error}</div>}
          </>
        )}
      </div>

      <div className="field">
        <label>Baseline image folder</label>
        <div className="folder-row">
          <input
            type="text"
            readOnly
            value={settings.baselineFolder || ''}
            placeholder="No folder selected"
          />
          <button className="btn" onClick={onSelectFolder} disabled={busy}>
            Choose…
          </button>
        </div>
        <p className="hint">Images from the selected artifact are compared against this folder.</p>
      </div>
    </div>
  )
}
