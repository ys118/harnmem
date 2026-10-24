/**
 * Panel styles, injected once per document.
 *
 * Uses the DSH theme aliases (`--dsw-alias-*`) so the panel follows the host
 * light/dark theme; falls back to sensible neutral values when an alias is
 * missing. The `data-plugin-css` marker keeps injection idempotent across
 * plugin reloads.
 */
const STYLE_ID = 'dsh-harnmem-panel'

const CSS = `
.dshh-panel {
  --dshh-fg: var(--dsw-alias-text-primary, #1f2328);
  --dshh-fg-secondary: var(--dsw-alias-text-secondary, #59636e);
  --dshh-fg-tertiary: var(--dsw-alias-text-tertiary, #6e7781);
  --dshh-border: var(--dsw-alias-border-default, rgba(31, 35, 40, 0.12));
  --dshh-border-strong: var(--dsw-alias-border-strong, rgba(31, 35, 40, 0.24));
  --dshh-surface: var(--dsw-alias-surface-primary, #ffffff);
  --dshh-surface-muted: var(--dsw-alias-surface-secondary, #f6f8fa);
  --dshh-accent: var(--dsw-alias-accent-fg, #0969da);
  --dshh-accent-soft: var(--dsw-alias-accent-bg, rgba(9, 105, 218, 0.1));
  --dshh-danger: var(--dsw-alias-danger-fg, #cf222e);
  --dshh-warn: #9a6700;
  --dshh-success: #1a7f37;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--dshh-fg);
  background: var(--dshh-surface);
  font: 13px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .dshh-panel {
    --dshh-fg: var(--dsw-alias-text-primary, #e6edf3);
    --dshh-fg-secondary: var(--dsw-alias-text-secondary, #9da7b3);
    --dshh-fg-tertiary: var(--dsw-alias-text-tertiary, #7d8590);
    --dshh-border: var(--dsw-alias-border-default, rgba(240, 246, 252, 0.14));
    --dshh-border-strong: var(--dsw-alias-border-strong, rgba(240, 246, 252, 0.28));
    --dshh-surface: var(--dsw-alias-surface-primary, #0d1117);
    --dshh-surface-muted: var(--dsw-alias-surface-secondary, #161b22);
    --dshh-accent: var(--dsw-alias-accent-fg, #4493f8);
    --dshh-accent-soft: var(--dsw-alias-accent-bg, rgba(68, 147, 248, 0.16));
    --dshh-danger: var(--dsw-alias-danger-fg, #f85149);
    --dshh-warn: #d29922;
    --dshh-success: #3fb950;
  }
}

/* ---------------------------------------------------------------- chrome */
.dshh-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 14px 18px 10px;
  border-bottom: 1px solid var(--dshh-border);
}
.dshh-header-main { min-width: 0; flex: 1 1 auto; }
.dshh-title { font-size: 15px; font-weight: 600; margin: 0; line-height: 1.3; }
.dshh-subtitle { color: var(--dshh-fg-secondary); font-size: 12px; }
.dshh-header-actions { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; }
.dshh-cwd {
  max-width: 40ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dshh-fg-tertiary);
}
.dshh-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 14px 18px 20px; }
.dshh-footer {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 18px;
  border-top: 1px solid var(--dshh-border);
}

/* ------------------------------------------------------------------ tabs */
.dshh-tabs {
  display: flex;
  gap: 2px;
  padding: 0 12px;
  border-bottom: 1px solid var(--dshh-border);
  overflow-x: auto;
}
.dshh-tab {
  appearance: none;
  font: inherit;
  color: var(--dshh-fg-secondary);
  background: transparent;
  border: 0;
  border-bottom: 2px solid transparent;
  padding: 8px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.dshh-tab:hover { color: var(--dshh-fg); }
.dshh-tab-active { color: var(--dshh-fg); border-bottom-color: var(--dshh-accent); font-weight: 600; }
.dshh-tab-badge {
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 9px;
  background: var(--dshh-surface-muted);
  border: 1px solid var(--dshh-border);
  font-size: 11px;
  font-weight: 500;
}

/* -------------------------------------------------------------- sections */
.dshh-section { margin-bottom: 18px; }
.dshh-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.dshh-section-title { margin: 0; font-size: 13px; font-weight: 600; }
.dshh-section-extra { flex: 0 0 auto; }

/* ----------------------------------------------------------------- stats */
.dshh-stat-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
  gap: 8px;
}
.dshh-stat {
  border: 1px solid var(--dshh-border);
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--dshh-surface-muted);
  min-width: 0;
}
.dshh-stat-clickable { font: inherit; color: inherit; text-align: left; cursor: pointer; }
.dshh-stat-clickable:hover { border-color: var(--dshh-accent); }
.dshh-stat-label { color: var(--dshh-fg-secondary); font-size: 12px; }
.dshh-stat-value { font-size: 17px; font-weight: 650; line-height: 1.25; overflow-wrap: anywhere; }
.dshh-stat-hint { color: var(--dshh-fg-tertiary); font-size: 11px; }
.dshh-stat-success .dshh-stat-value { color: var(--dshh-success); }
.dshh-stat-warn .dshh-stat-value { color: var(--dshh-warn); }
.dshh-stat-danger .dshh-stat-value { color: var(--dshh-danger); }
.dshh-stat-accent .dshh-stat-value { color: var(--dshh-accent); }

/* ----------------------------------------------------------------- meter */
.dshh-meter { margin-bottom: 12px; }
.dshh-meter-head { display: flex; justify-content: space-between; gap: 12px; font-size: 12px; margin-bottom: 4px; }
.dshh-meter-track { height: 6px; border-radius: 3px; background: var(--dshh-surface-muted); border: 1px solid var(--dshh-border); overflow: hidden; }
.dshh-meter-bar { height: 100%; background: var(--dshh-accent); }
.dshh-meter-bar-over { background: var(--dshh-warn); }

/* ----------------------------------------------------------------- badges */
.dshh-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid var(--dshh-border);
  background: var(--dshh-surface-muted);
  color: var(--dshh-fg-secondary);
  font-size: 11px;
  line-height: 18px;
  white-space: nowrap;
}
.dshh-badge-accent { color: var(--dshh-accent); border-color: var(--dshh-accent); background: var(--dshh-accent-soft); }
.dshh-badge-success { color: var(--dshh-success); border-color: var(--dshh-success); }
.dshh-badge-warn { color: var(--dshh-warn); border-color: var(--dshh-warn); }
.dshh-badge-danger { color: var(--dshh-danger); border-color: var(--dshh-danger); }

/* ----------------------------------------------------------------- cards */
.dshh-card {
  border: 1px solid var(--dshh-border);
  border-radius: 8px;
  padding: 10px 12px;
  background: var(--dshh-surface-muted);
}
.dshh-chip-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.dshh-chips { display: inline-flex; flex-wrap: wrap; gap: 6px; }
.dshh-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 1px 8px;
  border-radius: 6px;
  border: 1px solid var(--dshh-border);
  background: var(--dshh-surface-muted);
  font-size: 12px;
}
.dshh-chip-button { font: inherit; color: var(--dshh-accent); cursor: pointer; }
.dshh-chip-button:hover { border-color: var(--dshh-accent); }
.dshh-chip-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ------------------------------------------------------------ key/value */
.dshh-kv { margin: 0; display: grid; grid-template-columns: minmax(96px, 34%) 1fr; gap: 2px 14px; }
.dshh-kv-row { display: contents; }
.dshh-kv-key { color: var(--dshh-fg-secondary); font-size: 12px; padding: 2px 0; }
.dshh-kv-value { margin: 0; padding: 2px 0; overflow-wrap: anywhere; }

/* ---------------------------------------------------------------- tables */
.dshh-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dshh-table th {
  text-align: left;
  color: var(--dshh-fg-secondary);
  font-weight: 500;
  padding: 4px 8px;
  border-bottom: 1px solid var(--dshh-border);
  white-space: nowrap;
}
.dshh-table td { padding: 6px 8px; border-bottom: 1px solid var(--dshh-border); vertical-align: top; }
.dshh-table tr:last-child td { border-bottom: 0; }

/* ----------------------------------------------------------------- lists */
.dshh-rows { display: flex; flex-direction: column; gap: 6px; }
.dshh-row {
  font: inherit;
  color: inherit;
  text-align: left;
  width: 100%;
  display: block;
  border: 1px solid var(--dshh-border);
  border-radius: 8px;
  background: var(--dshh-surface);
  padding: 8px 10px;
  cursor: pointer;
}
.dshh-row:hover { border-color: var(--dshh-accent); }
.dshh-row-head { display: flex; gap: 8px; align-items: baseline; justify-content: space-between; }
.dshh-row-title { font-weight: 600; overflow-wrap: anywhere; }
.dshh-row-badges { display: inline-flex; flex-wrap: wrap; gap: 4px; flex: 0 0 auto; }
.dshh-row-desc { color: var(--dshh-fg-secondary); margin: 3px 0; overflow-wrap: anywhere; }
.dshh-row-meta { display: flex; flex-wrap: wrap; gap: 10px; font-size: 11px; }

/* --------------------------------------------------------------- toolbar */
.dshh-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 10px;
  margin-bottom: 10px;
}
.dshh-toolbar-meta { font-size: 12px; }
.dshh-filter { display: inline-flex; flex-direction: column; gap: 2px; font-size: 12px; }
.dshh-filter-label { color: var(--dshh-fg-secondary); }
.dshh-filter-grow { flex: 1 1 180px; min-width: 140px; }
.dshh-select, .dshh-input {
  font: inherit;
  color: var(--dshh-fg);
  background: var(--dshh-surface);
  border: 1px solid var(--dshh-border);
  border-radius: 6px;
  padding: 3px 8px;
  min-height: 26px;
}
.dshh-input { width: 100%; }
.dshh-select:focus, .dshh-input:focus { outline: 2px solid var(--dshh-accent-soft); border-color: var(--dshh-accent); }
.dshh-list-meta { margin-bottom: 8px; font-size: 12px; }

/* ---------------------------------------------------------------- states */
.dshh-state { padding: 18px 4px; }
.dshh-state-title { font-weight: 600; margin-bottom: 4px; }
.dshh-loading-state { display: flex; flex-direction: column; gap: 8px; }
.dshh-skeleton {
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--dshh-surface-muted), var(--dshh-border), var(--dshh-surface-muted));
  background-size: 200% 100%;
  animation: dshh-shimmer 1.4s ease-in-out infinite;
}
.dshh-skeleton-title { height: 18px; width: 42%; }
.dshh-skeleton-short { width: 66%; }
@keyframes dshh-shimmer {
  0% { background-position: 100% 0; }
  100% { background-position: -100% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .dshh-skeleton { animation: none; }
}

/* ----------------------------------------------------------------- misc */
.dshh-muted { color: var(--dshh-fg-secondary); }
.dshh-small { font-size: 12px; }
.dshh-mono { font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace; font-size: 12px; }
.dshh-error { color: var(--dshh-danger); white-space: pre-wrap; margin: 0 0 8px; }
.dshh-btn {
  font: inherit;
  color: var(--dshh-fg);
  background: var(--dshh-surface);
  border: 1px solid var(--dshh-border);
  border-radius: 6px;
  padding: 2px 10px;
  cursor: pointer;
}
.dshh-btn:hover:not(:disabled) { border-color: var(--dshh-accent); color: var(--dshh-accent); }
.dshh-btn:disabled { opacity: 0.5; cursor: default; }
.dshh-btn-small { padding: 1px 8px; font-size: 12px; }
.dshh-link-button {
  font: inherit;
  color: var(--dshh-accent);
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  text-align: left;
}
.dshh-link-button:hover { text-decoration: underline; }
.dshh-link { color: var(--dshh-accent); }
.dshh-details { margin-top: 6px; }
.dshh-details summary { cursor: pointer; color: var(--dshh-fg-secondary); font-size: 12px; }
.dshh-pre {
  margin: 8px 0 0;
  padding: 10px 12px;
  border: 1px solid var(--dshh-border);
  border-radius: 8px;
  background: var(--dshh-surface-muted);
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  overflow: auto;
  max-height: 52vh;
  white-space: pre;
}
.dshh-pre-wrap { white-space: pre-wrap; overflow-wrap: anywhere; }

/* ---------------------------------------------------------------- detail */
.dshh-detail-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 10px; }
.dshh-detail-title { margin: 0 0 6px; font-size: 16px; font-weight: 650; overflow-wrap: anywhere; }
.dshh-detail-body { border: 1px solid var(--dshh-border); border-radius: 8px; padding: 10px 12px; background: var(--dshh-surface-muted); }

/* --------------------------------------------------------------- projects */
.dshh-project-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 8px; }
.dshh-project-head { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
.dshh-project-name { font-weight: 600; }
.dshh-project-paths { display: flex; flex-direction: column; gap: 1px; margin: 4px 0; }
.dshh-project-meta { margin-top: 2px; }

/* ---------------------------------------------------------------- issues */
.dshh-issue-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.dshh-issue { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; }
.dshh-issue-code { color: var(--dshh-fg-secondary); }

/* -------------------------------------------------------------- markdown */
.dshh-md { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.dshh-md > :first-child { margin-top: 0; }
.dshh-md-heading { margin: 14px 0 6px; font-size: 14px; font-weight: 650; }
.dshh-md-p { margin: 6px 0; }
.dshh-md-list { margin: 6px 0; padding-left: 20px; }
.dshh-md-list li { margin: 2px 0; }
.dshh-md-code {
  font-family: ui-monospace, SFMono-Regular, "Cascadia Code", Consolas, monospace;
  font-size: 0.92em;
  background: var(--dshh-surface);
  border: 1px solid var(--dshh-border);
  border-radius: 4px;
  padding: 0 4px;
}
.dshh-md-pre {
  margin: 8px 0;
  padding: 10px 12px;
  border: 1px solid var(--dshh-border);
  border-radius: 8px;
  background: var(--dshh-surface);
  overflow: auto;
  font-size: 12px;
}
.dshh-md-quote {
  margin: 8px 0;
  padding: 2px 12px;
  border-left: 3px solid var(--dshh-border-strong);
  color: var(--dshh-fg-secondary);
}
.dshh-md-hr { border: 0; border-top: 1px solid var(--dshh-border); margin: 12px 0; }
.dshh-md-table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 8px 0; }
.dshh-md-table th, .dshh-md-table td { border: 1px solid var(--dshh-border); padding: 4px 6px; text-align: left; vertical-align: top; }
.dshh-md-table th { background: var(--dshh-surface); font-weight: 600; }
.dshh-md-wikilink {
  color: var(--dshh-accent);
  border-bottom: 1px dotted var(--dshh-accent);
  padding: 0 1px;
}
`

/** Injects the panel stylesheet once; safe to call on every plugin load. */
export function injectPanelStyles(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-harnmem'
  tag.dataset.pluginCss = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
