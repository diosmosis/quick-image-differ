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

## Verification notes

- `npm run build` succeeds for main, preload and renderer.
- `npm run dev` boots with no runtime/module/preload errors.
- Change 4's matching logic was unit-tested directly against the real `collectImages`/`alignArtifactKeys` code.
- The compact layout (1) and persistence restore (2) were verified structurally and via a clean boot; a full visual pass needs an interactive GUI session on your machine.
