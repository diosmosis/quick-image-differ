# App UX Review

This is a document of iterations that need to be made or have already been made to the quick-image-differ app.

## Changes

1. the left pane is too large, the UX should be more compact, ideally so scrolling is not needed (except within individual selectors).

   **Status: ✅ Done (revised).** First attempt made the four selectors share the sidebar height, which left each list too short to use. Replaced with a popover design: each of repository / workflow / run / artifact is now a single-line trigger button showing the current selection; clicking opens a floating, searchable, scrollable list (portaled to `<body>` with fixed positioning, so it isn't clipped by the sidebar and can extend over the main panel). The manual `owner/repo` entry is now a "Use …" action inside the repository popover's filter box. The sidebar is compact (setup card + one "GitHub source" card) and no longer needs its own scrollbar. (`src/renderer/src/components/PopoverSelect.jsx` (new), `src/renderer/src/App.jsx`, `src/renderer/src/styles.css`; replaced the old `StepList` component)

2. the repository, workflow, workflow run, artifact fields should be persisted so the same values are displayed on the subsequent run

   **Status: ✅ Done.** Each selection is written to the settings store as it is made, and on launch the saved repository → workflow → run → artifact chain is re-loaded and re-highlighted (each level only if it still exists on GitHub). The artifact is not auto-downloaded/diffed on restore — click it to run the diff again. Selections are cleared when the token is changed. (`src/renderer/src/App.jsx`, persisted via the existing `settings:set` IPC)

3. the app should start maximized

   **Status: ✅ Done.** The window is created hidden and maximized on `ready-to-show` (avoids a flash at the default size before expanding). (`src/main/index.js`)

4. the diff should be directory aware. so if a build archive has a folder, it should look for a folder with the same name in the baseline directory, and compare those two directories together

   **Status: ✅ Done.** Image matching already compared by full relative path, but GitHub artifacts commonly extract with an extra leading wrapper directory (e.g. `my-artifact/screenshots/home.png`), which made every image show up as "added"/"missing" against a baseline of `screenshots/home.png`. Added `alignArtifactKeys()` which detects a common leading directory shared by all artifact images and strips it so the artifact's folders line up with the same-named baseline folders. The stripped prefix is shown in the diff toolbar. Verified against four scenarios (identical structure, wrapper dir, wrapper + genuinely-new image, and no overlap). (`src/main/imagediff.js`, `src/main/ipc.js`, `src/renderer/src/components/DiffViewer.jsx`)

5. the left pane should be collapsible

   **Status: ✅ Done.** Added a collapse button (`‹`) in the sidebar header that slides the sidebar closed (grid column animates to 0). When collapsed, a handle (`›`) attached to the left edge of the main panel reopens it. The collapsed/expanded state is persisted, so it is restored on the next launch. (`src/renderer/src/App.jsx`, `src/renderer/src/styles.css`)

6. new feature within the image differ: there should be the ability to zoom in and out of the images displayed. the zoom control should affect all three images identically, so it is easier for a user to see what changed.

   **Status: ✅ Done.** Added a zoom control (`−` / percentage / `+`) to the diff toolbar. A single shared zoom level scales all three panes (artifact, baseline, diff) identically; clicking the percentage resets to 100% (fit-to-width). The panes' scroll positions are also kept in sync, so when zoomed in, all three show the same region — making it easy to line up and spot what changed. (`src/renderer/src/components/DiffViewer.jsx`, `src/renderer/src/styles.css`)

7. a new issue with the image diffing portion: the baseline correctly displays the image with no diff overlay. the diff image correctly displays the image diff, but the artifact displays the image and highlights the parts of the image that are different (duplicating what the diff is meant to display). this is unneeded and in fact makes it harder for the user to use their eyes to compare between the artifact and the baseline image. for the artifact image, please only display the unmodified artifact image (as is done with the baseline image).

   **Status: ❌ Invalid — no change made.** The archive selected by mistake already contained diff images (highlights baked into the artifact files themselves). The app was serving the unmodified artifact correctly: verified that the "Artifact" pane is served the raw artifact file (byte-identical to disk) and that pixelmatch only writes highlights into the separate diff image, never onto the artifact. Nothing to fix.

8. when the app starts, and an artifact that was selected in a previous run is selected in the current run. but the selected artifact is not downloaded/diffed. it should be.

   **Status: ✅ Done.** Extracted the download-and-diff step into a shared `runDiff()` and call it from the startup restore path, so the restored artifact is now automatically downloaded and diffed on launch (served from the local cache when available — see #9). Repo/run/baseline are passed explicitly to `runDiff` because the corresponding React state hasn't settled yet during restore. (`src/renderer/src/App.jsx`)

9. artifacts should be cached locally (at most 300mb). if a specific artifact is newer than what is stored locally, it should be redownloaded.

   **Status: ✅ Done.** Added `ArtifactCache` (`src/main/cache.js`): downloaded artifact zips are stored under `userData/artifact-cache/` with a JSON index. On a diff request the cache is checked first — a hit is served without any network call; a miss (or an artifact whose `createdAt` is newer than the cached copy) triggers a download that is then cached. Total cache size is capped at 300 MB with least-recently-accessed eviction (never evicting the just-downloaded artifact). Cache hits are shown as "· cached" in the diff toolbar. Unit-tested hit/miss, newer-upstream invalidation, LRU eviction under the cap, and persistence. (`src/main/cache.js` (new), `src/main/ipc.js`, `src/renderer/src/App.jsx`, `src/renderer/src/components/DiffViewer.jsx`)

10. each github source selector needs a refresh button that refreshes the selector's contents.

    **Status: ✅ Done.** All four selectors now expose a Refresh action in their popover header. Repository already had one; added `refreshWorkflows` / `refreshRuns` / `refreshArtifacts`, which re-fetch just that selector's contents without disturbing the current selection or the downstream selectors. (`src/renderer/src/App.jsx`)

11. in the workflow selector, after refreshing, when a workflow appears that hasn't appeared before (ie, is new), it should be marked visually as being new.

    **Status: ✅ Done.** `refreshWorkflows` diffs the freshly-fetched workflow ids against the previously-displayed set; any id not seen before is tracked in `newWorkflowIds` and shown with a blue "New" badge in the workflow list. The markers are recomputed on each refresh and cleared when a different repository is selected. (`src/renderer/src/App.jsx`, `src/renderer/src/styles.css`)

12. in the workflow selector, display the message of the commit that triggered the workflow in small text under each workflow. (if triggered manually, just say manual).

    **Status: ✅ Done.** Implemented on the **Workflow run** selector — a workflow *definition* has no triggering commit; only runs do, and "manual" (`workflow_dispatch`) is a run-level event. `listRuns` returns `headCommitMessage` (from the run's `head_commit.message`), and each run's small subtitle shows the first line of that commit message, or "Manual" when started by hand. Follow-up: the runs list sometimes omits `head_commit`, which showed the bare event name ("push") instead of the commit message; `listRuns` now fetches the commit message directly by `head_sha` for any run missing it (deduped by sha, fetched in parallel), with `display_title` as a further fallback, so push-triggered runs display the message of the pushed commit. (`src/main/github.js`, `src/renderer/src/App.jsx`)

13. in the artifact selector, do not display artifact files that start with "diff-"

    **Status: ✅ Done.** The `github:listArtifacts` IPC handler now filters out any artifact whose name starts with `diff-` before returning the list. Filtering at this single point keeps them out of the selector, its refresh, and the startup-restore path uniformly. (`src/main/ipc.js`)

14. in the diff viewer, the file selector on the left hand side should be navigable by keyboard (ie, up arrow moves the current selection up, the down arrow moves the current selection down).

    **Status: ✅ Done.** Added a window `keydown` handler in the diff viewer: ArrowUp/ArrowDown move the selection up/down within the currently filtered list (clamped at the ends). It is ignored while focus is in a text input (so the popover filter boxes still work), and the selected row is scrolled into view as the selection moves. (`src/renderer/src/components/DiffViewer.jsx`)

15. when the copy artifact -> baseline button is pressed, and the artifact is copied over, and the diff on the left hand is removed from the view (because the images match and it no longer matches the selected "Different" filter), the selected file moves to the first in the list. this should not happen, instead it should remain at the same position as it was before. so, if the 2nd image in the list is selected, and the user copies that file over to the baseline folder, when the list refreshes, the second item in the list should still be selected. this allows the user to quickly view differences without having to re-select a file, when the user is not able to copy over one or more files (because the difference is may not be valid).

    **Status: ✅ Done.** The "keep selection valid" effect now tracks the selection's position (`lastIndexRef`) and, when the selected item drops out of the filtered list, selects the item that now occupies the same index (clamped to the list length) instead of jumping to the top. So resolving the 2nd item leaves the selection on what is now the 2nd item, letting the user step straight through the diffs. Also reworked the post-resolve image refresh to reload via a token (`imgRefresh`) rather than re-fetching the old key, avoiding a stale-image race now that the selection can move. (`src/renderer/src/components/DiffViewer.jsx`)

16. the "Downloading & comparing images" loading status seems to take a long time even with a file cache. please provide more context about progress within this process so the user can see progress being made.

    **Status: ✅ Done.** The slow part even on a cache hit is decoding + pixel-diffing every image, which ran as one opaque blocking step. The `diff:download` handler now streams `diff:progress` events through the phases — download / extract / compare — and during the compare phase reports `done`/`total` and yields to the event loop (`setImmediate`) so the updates actually flush (pixelmatch is synchronous and would otherwise block until the whole loop finished). The renderer subscribes via a new `onDiffProgress` preload bridge and the loading screen now shows the current phase message plus a progress bar and an "N / M images compared" counter. (`src/main/ipc.js`, `src/preload/index.js`, `src/renderer/src/App.jsx`, `src/renderer/src/styles.css`)

17. run the image comparison in the background so it never blocks the main process / UI.

    **Status: ✅ Done.** Moved the CPU-bound decode + pixelmatch work off the main thread onto a pool of worker threads. Extracted the per-pair comparison into `compareImagePair()` (`imagediff.js`); a worker script (`diff-worker.js`) runs it per message, and `DiffWorkerPool` (`worker-pool.js`) spawns one worker per core (capped at 8), queues tasks, dispatches to idle workers, and replaces any crashed worker (resolving its in-flight task as an error so a diff never hangs). `diff:download` now does download/extract on the main thread, resolves trivial added/missing entries inline, and runs the actual image comparisons in parallel on the pool — so the main process (dialogs, GitHub calls, progress events, window) stays responsive, and diffs also complete faster. The pool is created once and torn down on `will-quit`. Built the worker as a sibling of `index.js` via an added electron-vite input; verified end-to-end (spawned the built worker, confirmed correct statuses and usable diff-PNG buffers) and via a clean app boot. (`src/main/worker-pool.js` (new), `src/main/diff-worker.js` (new), `src/main/imagediff.js`, `src/main/ipc.js`, `electron.vite.config.mjs`)

18. in the artifacts dropdown, each artifact should have the datetime it was uploaded next to it. the items should also be sorted by creation time, in a descending order (so newest first).

    **Status: ✅ Done.** The `github:listArtifacts` IPC handler now sorts artifacts by `createdAt` descending (newest first; artifacts with no creation time sort last) right after the existing `diff-` filter — so the selector, its Refresh action and the startup-restore path all get the same order. Each row in the artifact popover shows the upload time right-aligned next to the artifact name, formatted compactly in local time (`3 Aug, 14:05`; the year is included only when it isn't the current year), with the full locale datetime as the row's tooltip. (`src/main/ipc.js`, `src/renderer/src/App.jsx`, `src/renderer/src/styles.css`)

19. bug: if a different artifact is selected while diffing is ongoing (eg, with a large diff of 250 images), the diff viewer screen will eventually flicker continuously for some time, possibly because the previous diff was never cancelled.

    **Status: ✅ Done.** Confirmed: nothing cancelled the in-flight diff, so two `diff:download` handlers ran at once, both streaming `diff:progress` into the same renderer state and both racing to publish a result and to overwrite the main process's single `session`. The visible flicker came from the older diff finishing first (mounting the viewer with *its* results) while the newer diff's progress events kept re-rendering `App` — and the viewer's image-loading effect depends on its `getImages` prop, which was an inline arrow re-created on every render, so every progress tick re-fetched and re-flashed the three image panes. Fixed in three places: (a) the main process now tracks the active diff and cancels the previous one when a new `diff:download` arrives — it stops emitting progress, doesn't publish results and doesn't touch `session`, returning `{ cancelled: true }` instead; (b) queued worker tasks belonging to a superseded diff are dropped at dispatch time (`pool.run(task, isCancelled)`) so the new diff isn't stuck behind hundreds of obsolete comparisons — only the handful already in flight finish, and their results are discarded; (c) the renderer stamps each diff with a `requestId`, ignoring progress events and results that don't match the current one (also bumped when the repo/workflow/run selection resets), and `getImages` is now a stable `useCallback`, so parent re-renders no longer reload the image panes. Tested the pool directly: with a superseded 40-task job, 39 tasks were dropped and only the one already dispatched ran, letting the new job's comparisons finish immediately instead of queueing behind it; uncancelled runs still return normal statuses and diff PNGs. (`src/main/ipc.js`, `src/main/worker-pool.js`, `src/renderer/src/App.jsx`)

## Verification notes

- `npm run build` succeeds for main, preload and renderer.
- `npm run dev` boots with no runtime/module/preload errors.
- Change 4's matching logic was unit-tested directly against the real `collectImages`/`alignArtifactKeys` code.
- The compact layout (1) and persistence restore (2) were verified structurally and via a clean boot; a full visual pass needs an interactive GUI session on your machine.
