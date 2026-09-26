# Contributing

This repository is the **Enot Obsidian client only**. The voice pipeline lives on a private server and is not in this repo.

## Setup

```bash
npm install
npm run dev
```

Symlink or copy this folder to `{vault}/.obsidian/plugins/enot/` and enable the plugin.

## Pull requests

1. Open an issue first for behavior changes.
2. Keep UI copy in sentence case ([Obsidian guidelines](https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines)).
3. Do not add `atob` / `btoa`, hidden endpoints, or minification tricks. `npm run build` must match the GitHub Release asset.
4. Do not commit API keys or `data.json`.

## Release

1. Bump `version` in `package.json`, `manifest.json`, and `versions.json`.
2. `git tag -a 0.1.1 -m "0.1.1" && git push origin 0.1.1`
3. GitHub Actions builds `main.js`, attests artifacts, and opens a draft release.

See [Release your plugin with GitHub Actions](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions).
