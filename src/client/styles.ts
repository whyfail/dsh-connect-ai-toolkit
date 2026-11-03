/** Scoped, theme-aware presentation; the native select remains the only control. */
export const toolkitStyles = `
.ait-card{
  --ait-text:var(--dsw-alias-label-primary,#243039);
  --ait-muted:var(--dsw-alias-label-secondary,#5a6874);
  --ait-surface:var(--dsw-alias-bg-layer-3,#ffffff);
  --ait-picker-surface:var(--dsw-alias-bg-layer-2,#f8fafb);
  --ait-border:var(--dsw-alias-border-l3,#e0e6eb);
  --ait-divider:var(--dsw-alias-border-l2,#e8edf0);
  --ait-accent:var(--dsw-alias-state-business-primary,#386bd6);
  --ait-brand-bg:#edf3f5;
  --ait-brand-text:#33515e;
  --ait-brand-border:#dfe8ec;
  --ait-success-bg:#edf7f1;
  --ait-success-text:#216d4e;
  --ait-waiting-bg:#f0f3f6;
  --ait-waiting-text:#536273;
  --ait-warning-bg:#fbf2e2;
  --ait-warning-text:#8a561c;
  --ait-shadow:0 2px 4px rgb(28 48 62 / 3%),0 12px 30px -22px rgb(28 48 62 / 20%);
  box-sizing:border-box;
  width:100%;
  max-width:620px;
  min-width:0;
  padding:24px;
  border:1px solid var(--ait-border);
  border-radius:16px;
  background:var(--ait-surface);
  box-shadow:var(--ait-shadow);
  color:var(--ait-text);
  font:400 13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased;
}
.ait-card *{box-sizing:border-box}
.ait-header{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.ait-brand{display:flex;align-items:center;gap:12px;min-width:0}
.ait-brand-mark{display:grid;place-items:center;flex:0 0 42px;width:42px;height:42px}
.ait-brand-mark img{display:block;width:100%;height:100%;object-fit:contain}
.ait-brand-copy{min-width:0}
.ait-title{margin:0;color:var(--ait-text);font-size:18px;font-weight:650;line-height:1.35;letter-spacing:-.45px}
.ait-subtitle{margin:3px 0 0;color:var(--ait-muted);font-size:11px;line-height:1.5;letter-spacing:.1px}
.ait-status{display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;min-height:26px;padding:3px 9px;border:1px solid transparent;border-radius:99px;background:var(--ait-waiting-bg);color:var(--ait-waiting-text);font-size:11px;font-weight:550;line-height:18px;white-space:nowrap}
.ait-status-dot{display:block;flex:none;width:5px;height:5px;border-radius:50%;background:currentColor}
.ait-card[data-tone=success] .ait-status{background:var(--ait-success-bg);color:var(--ait-success-text)}
.ait-card[data-tone=warning] .ait-status{background:var(--ait-warning-bg);color:var(--ait-warning-text)}
.ait-divider{height:1px;margin:22px 0 20px;background:var(--ait-divider)}
.ait-field{display:flex;flex-direction:column;gap:10px;min-width:0}
.ait-field-heading{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}
.ait-label{color:var(--ait-text);font-size:13px;font-weight:550;line-height:20px}
.ait-model-count{flex:none;color:var(--ait-muted);font-size:11px;font-variant-numeric:tabular-nums;line-height:18px}
.ait-picker{position:relative;isolation:isolate;display:grid;grid-template-columns:40px minmax(0,1fr) 18px;align-items:center;gap:13px;min-width:0;width:100%;min-height:82px;padding:16px;border:1px solid var(--ait-border);border-radius:11px;background:var(--ait-picker-surface);cursor:pointer;transition:border-color .16s ease,box-shadow .16s ease,background-color .16s ease}
.ait-picker[data-available=true]:hover{border-color:color-mix(in srgb,var(--ait-accent) 42%,var(--ait-border));background:color-mix(in srgb,var(--ait-accent) 2%,var(--ait-picker-surface))}
.ait-picker:focus-within{border-color:var(--ait-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ait-accent) 13%,transparent)}
.ait-model-mark{display:grid;place-items:center;flex:none;width:40px;height:40px;border:1px solid color-mix(in srgb,currentColor 12%,transparent);border-radius:11px;background:var(--ait-waiting-bg);color:var(--ait-waiting-text);user-select:none}
.ait-model-mark svg{display:block;width:21px;height:21px}
.ait-model-mark img{display:block;width:32px;height:32px;object-fit:contain;border-radius:8px}
.ait-model-mark[data-has-logo=true]{border:0;background:transparent}
.ait-model-display{display:flex;flex-direction:column;gap:4px;min-width:0}
.ait-model-mark,.ait-model-display,.ait-picker-chevron{pointer-events:none}
.ait-model-title{display:block;overflow:hidden;min-width:0;max-width:100%;color:var(--ait-text);font-size:14px;font-weight:550;line-height:21px;text-overflow:ellipsis;white-space:nowrap}
.ait-model-id{display:block;overflow:hidden;min-width:0;max-width:100%;color:var(--ait-muted);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;font-weight:400;line-height:17px;letter-spacing:-.1px;text-overflow:ellipsis;white-space:nowrap}
.ait-picker-chevron{display:block;width:16px;height:16px;color:var(--ait-muted);justify-self:end;transition:transform .16s ease}
.ait-picker[data-available=true]:hover .ait-picker-chevron{transform:translateY(1px)}
.ait-select{position:absolute;z-index:2;inset:0;width:100%;height:100%;margin:0;border:0;border-radius:inherit;outline:none;background:var(--ait-surface);color:var(--ait-text);font:inherit;opacity:0;cursor:inherit}
.ait-select option{background:var(--ait-surface);color:var(--ait-text);font:inherit}
.ait-card[data-busy=true] .ait-picker,.ait-select[aria-busy=true]{cursor:progress}
.ait-card[data-busy=true] .ait-status-dot{animation:ait-status-pulse 1.35s ease-in-out infinite}
.ait-helper{display:flex;align-items:flex-start;gap:7px;margin:14px 0 0;color:var(--ait-muted);font-size:11px;font-weight:400;line-height:1.8}
.ait-helper-icon{display:block;flex:0 0 13px;width:13px;height:13px;margin-top:3px;color:var(--ait-muted)}
.ait-helper-icon svg{display:block;width:13px;height:13px}
.ait-helper-copy{display:block;min-width:0;overflow-wrap:anywhere}
.ait-helper[data-tone=error]{color:var(--ait-warning-text)}
.ait-helper[data-tone=error] .ait-helper-icon{color:var(--ait-warning-text)}
.ait-card a{color:var(--ait-accent);font-weight:500;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px}
.ait-card a:hover{text-decoration-thickness:2px}
.ait-card a:focus-visible{border-radius:2px;outline:2px solid var(--ait-accent);outline-offset:3px}
:is([data-theme=dark],.dark,[data-ds-dark-theme]) .ait-card,.ait-card[data-theme=dark]{
  color-scheme:dark;
  --ait-text:var(--dsw-alias-label-primary,#e4e9ed);
  --ait-muted:var(--dsw-alias-label-secondary,#a6b2bd);
  --ait-surface:var(--dsw-alias-bg-layer-3,#20272e);
  --ait-picker-surface:var(--dsw-alias-bg-layer-2,#252e36);
  --ait-border:var(--dsw-alias-border-l3,#394650);
  --ait-divider:var(--dsw-alias-border-l2,#35404a);
  --ait-accent:var(--dsw-alias-state-business-primary,#94b3ff);
  --ait-brand-bg:#2b3b44;
  --ait-brand-text:#c5dce6;
  --ait-brand-border:#3d515d;
  --ait-success-bg:#263d34;
  --ait-success-text:#a4d5bb;
  --ait-waiting-bg:#303b46;
  --ait-waiting-text:#b5c1cd;
  --ait-warning-bg:#443929;
  --ait-warning-text:#e4c38f;
  --ait-shadow:0 2px 5px rgb(0 0 0 / 10%),0 15px 28px -22px rgb(0 0 0 / 35%);
}
@keyframes ait-status-pulse{0%,100%{opacity:1}50%{opacity:.4}}
@media(max-width:420px){
  .ait-card{padding:20px;border-radius:16px}
  .ait-header{gap:10px}
  .ait-brand{gap:10px}
  .ait-brand-mark{flex-basis:38px;width:38px;height:38px;border-radius:11px}
  .ait-title{font-size:17px}
  .ait-status{padding:3px 8px;font-size:10px;gap:5px}
  .ait-divider{margin:20px 0 18px}
  .ait-picker{grid-template-columns:36px minmax(0,1fr) 15px;gap:11px;min-height:78px;padding:13px}
  .ait-model-mark{width:36px;height:36px;border-radius:10px;font-size:12px}
  .ait-model-title{font-size:13px}
  .ait-model-id{font-size:10px}
  .ait-helper{font-size:11px}
}
@media(prefers-reduced-motion:reduce){.ait-picker,.ait-picker-chevron{transition:none}.ait-card[data-busy=true] .ait-status-dot{animation:none}}
@media(forced-colors:active){.ait-card,.ait-picker{border-color:ButtonText;box-shadow:none}.ait-select{opacity:1;background:Canvas;color:CanvasText}.ait-select:focus-visible{outline:2px solid Highlight;outline-offset:2px}}
`
