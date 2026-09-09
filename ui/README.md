# Brand card UI (MCP Apps widget)

Source of the interactive brand card that MCP Apps hosts (claude.ai, Claude
Desktop, ...) render in place of `get_brand` results. Built with
[`@modelcontextprotocol/ext-apps`](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps)
and bundled by vite + `vite-plugin-singlefile` into one self-contained HTML
file the Python server serves as the `ui://brandfetch/brand-card.html`
resource.

## Build

```bash
npm ci
npm run typecheck
npm run build   # writes ../src/ui/brand-card.html
```

The build output `../src/ui/brand-card.html` is **committed** — the Dockerfile
and the public mirror only ship `src/`, so the artifact must be rebuilt and
committed whenever anything in this directory changes. Never edit the copy
under `src/ui/` by hand; `tests/test_app.py` guards against a missing or
non-self-contained artifact.

`npm run dev` serves the page standalone for quick iteration, but host APIs
(tool results, theme, downloadFile) only exist inside a real MCP Apps host.
