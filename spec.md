
please create the following app:

## short description

An small image diff GUI that directly compares images in an github artifact with a folder of baseline images.

## required frameworks and tools

- use electron as the development framework
- use react in the frontend
- the github API via an API token or via OAuth

## features

the following are a list of features that should be created for this app:

### diff folder 

the application will diff with baseline images in a specific folder. there needs to be an easy way to select this folder.

### github project selection

it should be possible to select a github project to focus on.

### build artifacts selection

once a github project is selected, it should be possible to select a build from the project's github actions workflows, and after that a specific workflow run.

once a workflow run is selected, the user should select a build artifact.

### image diff

this is the main interface for the application. once a build artifact is selected, it should be downloaded, and its contents diffed with the diff folder the user configured (only diffing images).

the image diff display should have two modes: side by side and the diff. it should be able to toggle between the two modes, or have both modes active at the same time (so artifact image, baseline image and diff image displayed together).

### resolving diffs

for images that are not identical, there should be an option to copy the artifact image to the baseline folder (overwriting the image there).

