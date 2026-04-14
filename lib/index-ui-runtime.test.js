const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');

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
  const hydrateOnSelectRegex = /if\(sel\)sel\.onchange=\(\)=>applySelectedSessionPreview\(tabId\);/;
  assert.ok(hydrateOnSelectRegex.test(indexHtml));
  const metadataCaptureRegex = /ts\.sessionPreviewById\[s\.sessionId\]=\{inputTokens:s\.inputTokens\|\|0,outputTokens:s\.outputTokens\|\|0\};/;
  assert.ok(metadataCaptureRegex.test(indexHtml));
  const storedSessionHydrateRegex = /if\(sel\)\{sel\.value=stored\.sessionId;applySelectedSessionPreview\(tabId\)\}/;
  assert.ok(storedSessionHydrateRegex.test(indexHtml));
  assert.ok(indexHtml.includes("if(!sel.value){if((ts.turnInputTokens||0)===0){ts.sessionTokensIn=0;ts.sessionTokensOut=0;updateCtxBar(tabId)}return}"));
  assert.ok(indexHtml.includes("ts.sessionTokensIn=p.inputTokens||0;ts.sessionTokensOut=p.outputTokens||0;updateCtxBar(tabId)"));
  assert.ok(!indexHtml.includes("(ts.sessionTokensIn||0)===0&&(ts.turnInputTokens||0)===0"));
});

test('log formatter improves readability for headings, Next Up blocks, numbered steps, bullets, separators, slash commands, spacing normalization, and preserves code blocks and inline code', () => {
  assert.ok(indexHtml.includes("const codeBlocks=[];const inlineCodes=[];"));
  assert.ok(indexHtml.includes("const token=`@@CODE_BLOCK_${codeBlocks.length}@@`;"));
  assert.ok(indexHtml.includes("const token=`@@INLINE_CODE_${inlineCodes.length}@@`;"));
  assert.ok(indexHtml.includes("s=s.replace(/@@INLINE_CODE_(\\d+)@@/g,(_,i)=>inlineCodes[Number(i)]||'');"));
  assert.ok(indexHtml.includes("s=s.replace(/@@CODE_BLOCK_(\\d+)@@/g,(_,i)=>codeBlocks[Number(i)]||'');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\s##\\s▶\\sNext\\sUp/gi,'\\n\\n## ▶ Next Up');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\s)(#{2,3}\\s)/g,'\\n$1');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\s{2,}---\\s{2,}/g,'\\n---\\n');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\s{2,}—\\s+/g,'\\n— ');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\s)(\\d+\\)\\s)/g,'\\n\\n$1');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\s)(\\d+)\\.\\s/g,'\\n\\n$1. ');"));
  assert.ok(indexHtml.includes("s=s.replace(/(?:^|\\s{2,})-\\s(?=[A-Za-z0-9`*\\/])/g,'\\n- ');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\s(\\/(?:clear|gsd-[a-z0-9-]+)\\b)/gi,'\\n$1');"));
  assert.ok(indexHtml.includes("s=s.replace(/\\n{3,}/g,'\\n\\n');"));
});
