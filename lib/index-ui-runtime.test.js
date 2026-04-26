const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const setupHealthCheck = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'setup-health-check.js'), 'utf8');

test('tools card is removed from main cards grid and no tools-card click handler is wired', () => {
  assert.ok(indexHtml.includes('grid-template-columns:repeat(6,minmax(0,1fr))'));
  assert.ok(!indexHtml.includes('data-el="cardTools"'));
  assert.ok(!indexHtml.includes('data-el="cTools"'));
  assert.ok(!indexHtml.includes('data-el="cToolsSub"'));
  assert.ok(!indexHtml.includes("const cardTools=el('cardTools');"));
});

test('context bar uses persisted turnInputTokens/contextWindow and falls back to input token totals after reload', () => {
  const statusRegex = /window\.api\.onStatus\(d=>\{[\s\S]*?if\(d\.turnInputTokens!=null\)ts\.turnInputTokens=d\.turnInputTokens;[\s\S]*?if\(d\.contextWindow!=null\)ts\.contextWindow=d\.contextWindow;[\s\S]*?if\(d\.turnInputTokens!=null\|\|d\.contextWindow!=null\)updateCtxBar\(tabId\);/;
  assert.ok(statusRegex.test(indexHtml));
  assert.ok(indexHtml.includes("const turnTok=ts.turnInputTokens||0;"));
  assert.ok(indexHtml.includes("const fallbackTok=ts.sessionTokensIn||0;"));
  assert.ok(indexHtml.includes("const inTok=turnTok>0?turnTok:fallbackTok;"));
});

test('context bar label preserves sub-1% precision instead of rounding down to 0%', () => {
  assert.ok(indexHtml.includes("const displayPct=pct>0&&pct<1?pct.toFixed(1):String(Math.round(pct));"));
  assert.ok(indexHtml.includes("label.textContent=displayPct+'% context'"));
});

test('proxy text truncation threshold is expanded for readability', () => {
  assert.ok(indexHtml.includes('if(raw.length>12000)'));
  assert.ok(indexHtml.includes('const keep=5990'));
});

test('selecting a project requests latest session state for context continuity', () => {
  const projectStateRegex = /populateSessionsForTab\(tabId,fullPath\);\s*window\.api\.getState\(tabId\);/;
  assert.ok(projectStateRegex.test(indexHtml));
});

test('session dropdown preview keeps more prompt text with explicit ellipsis truncation', () => {
  assert.ok(indexHtml.includes("const firstPromptRaw=(s.firstPrompt||'');"));
  assert.ok(indexHtml.includes("const prompt=firstPromptRaw.length>120?firstPromptRaw.substring(0,117)+'…':firstPromptRaw;"));
});

test('session selection hydrates and rehydrates token/context preview from stored session metadata', () => {
  assert.ok(indexHtml.includes("sessionPreviewById:{}"));
  const hydrateOnSelectRegex = /if\(sel\)sel\.onchange=\(\)=>\{ts\.sessionSelectionTouched=true;applySelectedSessionPreview\(tabId\)\};/;
  assert.ok(hydrateOnSelectRegex.test(indexHtml));
  const metadataCaptureRegex = /ts\.sessionPreviewById\[s\.sessionId\]=\{inputTokens:s\.inputTokens\|\|0,outputTokens:s\.outputTokens\|\|0\};/;
  assert.ok(metadataCaptureRegex.test(indexHtml));
  const storedSessionHydrateRegex = /if\(sel\)\{sel\.value=stored\.sessionId;applySelectedSessionPreview\(tabId\)\}/;
  assert.ok(storedSessionHydrateRegex.test(indexHtml));
  assert.ok(indexHtml.includes("if(!sel.value){if((ts.turnInputTokens||0)===0){ts.sessionTokensIn=0;ts.sessionTokensOut=0;updateCtxBar(tabId)}return}"));
  assert.ok(indexHtml.includes("ts.sessionTokensIn=p.inputTokens||0;ts.sessionTokensOut=p.outputTokens||0;updateCtxBar(tabId)"));
  assert.ok(!indexHtml.includes("(ts.sessionTokensIn||0)===0&&(ts.turnInputTokens||0)===0"));
});

test('populateSessionsForTab resolves tab state before assigning session previews', () => {
  const stateLookupRegex = /async function populateSessionsForTab\(tabId,dir\)\{\s*const ts=tabs\.get\(tabId\);if\(!ts\)return;[\s\S]*?ts\.sessionPreviewById=\{\};/;
  assert.ok(stateLookupRegex.test(indexHtml));
});

test('session state tracks explicit dropdown interaction for session selection', () => {
  assert.ok(indexHtml.includes("sessionSelectionTouched:false"));
  assert.ok(indexHtml.includes("if(sel)sel.onchange=()=>{ts.sessionSelectionTouched=true;applySelectedSessionPreview(tabId)};"));
  assert.ok(indexHtml.includes("if(freshBtn)freshBtn.onclick=async()=>{banner.classList.remove('vis');if(ts.projectDir)await window.api.clearStoredSession(ts.projectDir);const sel2=el('sessionSelect');if(sel2)sel2.value='';ts.sessionSelectionTouched=true;applySelectedSessionPreview(tabId)};"));
  assert.ok(indexHtml.includes("ts.sessionSelectionTouched=false;"));
});

test('log formatter improves readability with line-oriented normalization and preserves code blocks/inline code', () => {
  assert.ok(indexHtml.includes("const codeBlocks=[];const inlineCodes=[];"));
  assert.ok(indexHtml.includes("const token=`@@CODE_BLOCK_${codeBlocks.length}@@`;"));
  assert.ok(indexHtml.includes("const token=`@@INLINE_CODE_${inlineCodes.length}@@`;"));
  assert.ok(indexHtml.includes("s=s.replace(/@@INLINE_CODE_(\\d+)@@/g,(_,i)=>inlineCodes[Number(i)]||'');"));
  assert.ok(indexHtml.includes("s=s.replace(/@@CODE_BLOCK_(\\d+)@@/g,(_,i)=>codeBlocks[Number(i)]||'');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\n)(#{2,3}\\s)/g,'\\n$1');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\n[ \\t]*---[ \\t]*\\n/g,'\\n---\\n');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\n)(\\d+\\)\\s)/g,'\\n$1');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\n)(\\d+)\\.\\s/g,'\\n$1. ');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\n)-\\s(?=[A-Za-z0-9`*\\/])/g,'\\n- ');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\n)(\\/(?:clear|gsd-[a-z0-9-]+)\\b)/gi,'\\n$1');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\r\\n/g,'\\n');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\n{3,}/g,'\\n\\n');"));
});

test('setup health diagnostics include the active workspace path', () => {
  assert.ok(setupHealthCheck.includes("const d=await window.api.getDiagnostics({tabId:document.querySelector('.t.active')?.dataset?.tabId||null});"));
  assert.ok(setupHealthCheck.includes("`Workspace: ${d.workspacePath||'none'}`"));
});

test('index.html loads the shared operational status helper before renderer feature scripts', async () => {
  const html = await fs.promises.readFile(path.join(__dirname, '..', 'index.html'), 'utf8');
  const helperIndex = html.indexOf('renderer/operational-status.js');
  const ccmIndex = html.indexOf('renderer/claude-code-manager.js');
  const setupIndex = html.indexOf('renderer/setup-health-check.js');
  const settingsIndex = html.indexOf('renderer/settings-panel.js');

  assert.notEqual(helperIndex, -1);
  assert.ok(helperIndex < ccmIndex);
  assert.ok(helperIndex < setupIndex);
  assert.ok(helperIndex < settingsIndex);
});

test('renderer failure states use the shared operational status helper for actionable guidance', async () => {
  const ccm = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'claude-code-manager.js'), 'utf8');
  const settingsPanel = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'settings-panel.js'), 'utf8');
  const helperCall = "renderOperationalMessage({summary:'";

  assert.ok(ccm.includes(`${helperCall}Install failed`));
  assert.ok(ccm.includes(`${helperCall}Login failed`));
  assert.ok(settingsPanel.includes(`${helperCall}Save failed`));
  assert.ok(settingsPanel.includes(`${helperCall}No token saved`));
  assert.ok(settingsPanel.includes(`${helperCall}Telegram bot status`));
  assert.ok(ccm.includes("doPluginUpdateCheck(false,facade.pluginUpdates||[],facade.pluginUpdatesError||'');"));
  assert.ok(ccm.includes("if(prefetchedError){"));
  assert.ok(ccm.includes("summary:'Plugin check failed'"));
});

test('plugins installed view reloads full plugin state after successful single-plugin update', async () => {
  const ccm = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'claude-code-manager.js'), 'utf8');

  assert.ok(ccm.includes("if(r.ok){btn.textContent='✓ Updated';btn.style.color='var(--grn)';btn.style.background='transparent';_pluginUpdates=null;renderPlugins()}"));
});

test('renderer update-status handler renders hook cleanup failures without updater retry UI', async () => {
  const ccm = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'claude-code-manager.js'), 'utf8');

  assert.match(ccm, /payload\.scope==='hooks'/);
  assert.match(ccm, /statusEl\.textContent=renderOperationalMessage\(payload,payload\.summary\|\|'Hook cleanup incomplete'\)/);
  assert.match(ccm, /actionEl\.innerHTML='';\s*return;/);
});

test('preload fans out shared update-status listeners without clearing the whole channel', async () => {
  const preload = await fs.promises.readFile(path.join(__dirname, '..', 'preload.js'), 'utf8');

  assert.match(preload, /const channelListeners = new Map\(\);/);
  assert.match(preload, /const subscribers = new Set\(\);/);
  assert.match(preload, /ipcRenderer\.removeListener\(channel, current\.handler\);/);
  assert.match(preload, /onUpdateStatus:\s*cb => safeOn\('update-status', cb\)/);
  assert.doesNotMatch(preload, /removeAllListeners\(channel\)/);
  assert.doesNotMatch(preload, /onUpdateStatus:\s*cb => ipcRenderer\.on\('update-status'/);
});

test('setup health failure states use the shared operational status helper for actionable guidance', () => {
  assert.ok(setupHealthCheck.includes("showProgress(renderOperationalMessage({summary:'Save recommended failed',details:e.message,nextSteps:['retry save recommended']},'Save recommended failed'));"));
  assert.ok(setupHealthCheck.includes("showProgress(renderOperationalMessage({summary:'Open logs failed',details:(result?.error||'Unknown error'),nextSteps:['retry opening logs']},'Open logs failed'));"));
  assert.ok(setupHealthCheck.includes("showProgress(renderOperationalMessage({summary:'Health check failed',details:e.message,nextSteps:['retry health check']},'Health check failed'));"));
  assert.ok(setupHealthCheck.includes("if(data.error)showOperationalFailure('Install failed',data.error,'retry install');"));
});

test('help flow includes an If something fails recovery entry point', async () => {
  const helpJs = await fs.promises.readFile(path.join(__dirname, '..', 'renderer', 'help-wizard.js'), 'utf8');
  const html = await fs.promises.readFile(path.join(__dirname, '..', 'index.html'), 'utf8');

  assert.match(helpJs, /title:'If something fails'/);
  assert.match(helpJs, /dynamicSteps\.appendChild\(step\)/);
  assert.match(html, /<div id="helpDynamicSteps"><\/div>/);
});
