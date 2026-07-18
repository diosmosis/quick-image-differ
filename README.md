# Quick Image Differ

A small Electron + React desktop app that compares the images inside a **GitHub
Actions build artifact** against a folder of **baseline images** on your disk.

Pick a repository → workflow → run → artifact, and its images are downloaded,
extracted and diffed against your baseline folder. Different images can be
reviewed side‑by‑side, as a pixel diff, or both at once, and you can update a
baseline with a single click.

## Features

- **Baseline folder** — choose any local folder of reference images.
- **GitHub selection** — browse your repositories (or type `owner/repo`), then
  drill down through workflows → runs → artifacts.
- **Automatic diff** — the selected artifact is downloaded, unzipped and every
  image is matched against the baseline folder by relative path.
- **Three view modes** — _Side by side_, _Diff_, or both together (artifact,
  baseline and generated diff shown at once). Toggle each independently.
- **Status categories** — Different, New (only in artifact), Missing (only in
  baseline) and Identical, each filterable.
- **Resolve diffs** — copy an artifact image into the baseline folder,
  overwriting (or adding) the baseline image.

## Requirements

- Node.js 18+ (uses the built‑in `fetch`; developed on Node 20).
- A GitHub **personal access token**:
  - _Fine‑grained_: read access to **Actions** and **Contents** on the target
    repositories.
  - _Classic_: the `repo` scope (or `public_repo` for public repos only).

## Getting started

```bash
npm install
npm run dev      # launch in development (hot reload)
```

To build and preview the production bundle:

```bash
npm run build
npm start
```

## How to use

1. **Setup** (sidebar, step 1): paste your GitHub token and click _Save_, then
   choose your baseline image folder.
2. **Repository** (step 2): pick one of your repositories, or type `owner/repo`.
3. **Workflow → Run → Artifact** (steps 3–5): drill down to the artifact you
   want to check.
4. The main panel downloads the artifact and shows the diff. Use the **Side by
   side / Diff** toggles at the top‑right and the status filters on the left.
5. For a _Different_ or _New_ image, click **Copy artifact → baseline** (or
   **Add to baseline**) to update your baseline folder.

## Image formats

PNG and JPEG are decoded and pixel‑diffed (mismatched dimensions are padded to
the larger size). GIF, BMP and WebP are still listed and compared byte‑for‑byte,
but no pixel‑diff image is produced for them.

## Architecture

```
src/
  main/            Electron main process
    index.js       app/window lifecycle
    ipc.js         all IPC handlers (GitHub, download, diff, resolve)
    github.js      GitHub REST client (fetch + token)
    imagediff.js   image discovery, decode, pixel diff (pixelmatch/pngjs/jpeg-js)
    store.js       JSON settings store in userData
  preload/
    index.js       contextBridge API surface
  renderer/        React UI (Vite)
    src/App.jsx        selection flow + state
    src/components/    Setup, StepList, DiffViewer
```

The renderer never touches Node or the token directly — everything goes through
the small `window.api` bridge defined in `src/preload/index.js`.

## Security note

The GitHub token is stored in plain text in the app's `userData/settings.json`.
This is a local developer tool; for stronger protection swap `src/main/store.js`
for Electron's `safeStorage` or an OS keychain, and prefer a fine‑grained,
read‑only token scoped to just the repositories you need.
