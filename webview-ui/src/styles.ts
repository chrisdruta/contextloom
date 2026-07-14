/**
 * Webview chrome CSS, injected via constructed stylesheets
 * (document.adoptedStyleSheets). A plain <style> element rendered from JS is
 * blocked by the panel CSP: style-src carries a nonce, and per CSP3 a nonce
 * makes browsers ignore 'unsafe-inline' — which silently killed all layout
 * CSS (the Cytoscape container collapsed to 0×0). Constructed stylesheets go
 * through CSSOM and are exempt from style-src.
 */
export const css = `
.shell { display:flex; flex-direction:column; height:100%; }
.toolbar {
  display:flex; flex-wrap:wrap; gap:8px; align-items:center;
  padding:8px 10px; border-bottom:1px solid var(--border);
  background: var(--bg);
}
.brand { font-weight:600; margin-right:8px; }
.search {
  flex:1; min-width:140px; max-width:280px;
  background: var(--input-bg); color: var(--input-fg);
  border:1px solid var(--border); border-radius:4px; padding:4px 8px;
}
.filters { display:flex; flex-wrap:wrap; gap:4px; border:none; margin:0; padding:0; min-inline-size:0; }
.chip {
  border:1px solid var(--border); background: transparent; color: var(--fg);
  border-radius:999px; padding:2px 8px; font-size:11px; cursor:pointer;
}
.chip.off { opacity:0.45; text-decoration: line-through; }
.layout-select {
  background: var(--input-bg); color: var(--input-fg);
  border:1px solid var(--border); border-radius:4px; padding:3px 6px;
  font: inherit; font-size:11px;
}
.actions { display:flex; gap:4px; }
.btn {
  background: var(--button-bg); color: var(--button-fg);
  border:none; border-radius:4px; padding:4px 10px; cursor:pointer;
}
.btn.small { padding:2px 6px; font-size:11px; margin-top:4px; }
.status { font-size:11px; color: var(--muted); margin-left:auto; }
.error-banner {
  background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  color: var(--fg); padding: 4px 10px; font-size: 12px;
  white-space: pre-wrap; word-break: break-all;
}
.main { display:flex; flex:1; min-height:0; }
.canvas-host { flex:1; min-width:0; position:relative; }
.inspector {
  width:300px; max-width:40%; border-left:1px solid var(--border);
  padding:12px; overflow:auto;
}
.inspector h2 { margin:0 0 8px; font-size:13px; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); }
.inspector h3 { margin:4px 0 8px; font-size:16px; }
.inspector h4 { margin:12px 0 4px; font-size:12px; color:var(--muted); }
.muted { color: var(--muted); }
.badge {
  display:inline-block; font-size:10px; text-transform:uppercase;
  padding:2px 6px; border-radius:4px; border:1px solid var(--border);
}
.linkish {
  background:none; border:none; color: var(--accent); cursor:pointer;
  padding:0; text-align:left; font: inherit; text-decoration: underline;
  word-break: break-all;
}
.linkish.small { font-size:11px; margin-left:6px; }
.meta, .rel { margin:0; padding-left:16px; font-size:12px; }
.rel li { margin:2px 0; word-break: break-all; }
.etype { color: var(--muted); margin-right:4px; }
.chip .dot {
  display:inline-block; width:8px; height:8px; border-radius:50%;
  margin-right:4px; vertical-align:baseline;
}
.tabs { display:flex; gap:2px; margin-bottom:8px; border-bottom:1px solid var(--border); }
.tab {
  background:none; border:none; color: var(--muted); cursor:pointer;
  padding:4px 8px; font: inherit; font-size:12px;
  border-bottom:2px solid transparent;
}
.tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.tab:focus-visible { outline:1px solid var(--accent); outline-offset:-1px; }
.subject { font-size:12px; word-break: break-all; }
.subject code { font-size:11px; }
.ctx-group { margin-bottom:12px; }
.ctx-table {
  width:100%; border-collapse:collapse; font-size:11px;
}
.ctx-table th {
  text-align:left; color: var(--muted); font-weight:normal;
  padding:2px 6px 2px 0; border-bottom:1px solid var(--border);
}
.ctx-table td {
  padding:4px 6px 4px 0; border-bottom:1px solid var(--border);
  vertical-align:top; word-break: break-word;
}
.badge.status-active { border-color: var(--vscode-charts-green, #89d185); }
.badge.status-shadowed { opacity:0.6; text-decoration: line-through; }
.badge.status-conditional { border-style: dashed; }
.small { font-size:11px; }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
`;

/** Apply the chrome stylesheet in a CSP-safe way. */
export function applyStylesheet(): void {
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  } catch {
    // Environments without constructed stylesheets (e.g. jsdom): best-effort
    // <style> element. Under a nonce'd CSP this may be blocked, but every
    // Chromium shipped in VS Code supports the primary path above.
    const el = document.createElement("style");
    el.textContent = css;
    document.head.appendChild(el);
  }
}
