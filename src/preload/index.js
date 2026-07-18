import { contextBridge, ipcRenderer } from 'electron'

// The only surface the renderer can touch. Everything is promise-based IPC.
const api = {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  // filesystem / shell
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // github
  verifyToken: (token) => ipcRenderer.invoke('github:verifyToken', token),
  whoami: () => ipcRenderer.invoke('github:whoami'),
  listRepos: () => ipcRenderer.invoke('github:listRepos'),
  getRepo: (fullName) => ipcRenderer.invoke('github:getRepo', fullName),
  listWorkflows: (repo) => ipcRenderer.invoke('github:listWorkflows', repo),
  listRuns: (repo, workflowId) => ipcRenderer.invoke('github:listRuns', { repo, workflowId }),
  listArtifacts: (repo, runId) => ipcRenderer.invoke('github:listArtifacts', { repo, runId }),

  // diffing
  downloadAndDiff: (args) => ipcRenderer.invoke('diff:download', args),
  getImages: (key) => ipcRenderer.invoke('diff:getImages', key),
  resolveDiff: (key) => ipcRenderer.invoke('diff:resolve', key)
}

contextBridge.exposeInMainWorld('api', api)
