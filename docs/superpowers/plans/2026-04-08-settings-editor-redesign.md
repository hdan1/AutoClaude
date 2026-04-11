# Settings Editor Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw textarea settings editor with a structured section-based editor, dual-mode editing (Structured/Raw JSON), and tagged config history with left sidebar.

**Architecture:** Backend adds 4 tag-management methods to `claude-detector.js` with corresponding IPC handlers and preload APIs. The frontend replaces `renderSettingsEditor()` in `index.html` with a two-panel layout (sidebar + editor) supporting accordion structured mode and raw JSON mode. Tags are stored as individual JSON files in `~/.claude/settings-tags/`.

**Tech Stack:** Electron IPC (ipcMain.handle), Node.js fs, vanilla JS/HTML/CSS (matching existing index.html patterns)

**Design Spec:** `docs/superpowers/specs/2026-04-08-settings-editor-redesign.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `lib/claude-detector.js` | Modify | Add `listSettingsTags`, `loadSettingsTag`, `saveSettingsTag`, `deleteSettingsTag` methods |
| `main.js` | Modify | Register 4 new IPC handlers for tag operations |
| `preload.js` | Modify | Expose 4 new tag API methods |
| `index.html` | Modify | Replace settings editor CSS + JS, add sidebar layout, structured mode, raw mode |

---

### Task 1: Tag Management Backend Methods

**Files:**
- Modify: `lib/claude-detector.js`

- [ ] **Step 1: Add tag management methods to `lib/claude-detector.js`**

Add these 4 functions before the `module.exports` line (currently line ~212):

```js
function getTagsDir() {
  const dir = path.join(getClaudeHome(), 'settings-tags');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function validateTagName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name.length > 50) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

function listSettingsTags() {
  const dir = getTagsDir();
  const tags = [];
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const name = f.replace(/\.json$/, '');
      tags.push({ name, path: path.join(dir, f) });
    }
  } catch { /* empty */ }
  tags.sort((a, b) => a.name.localeCompare(b.name));
  return { tags };
}

function loadSettingsTag(name) {
  if (!validateTagName(name)) return { content: '{\n}', path: '', error: 'Invalid tag name' };
  const filePath = path.join(getTagsDir(), name + '.json');
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { content, path: filePath };
  } catch {
    return { content: '{\n}', path: filePath, error: 'Tag not found' };
  }
}

function saveSettingsTag(name, content) {
  if (!validateTagName(name)) throw new Error('Invalid tag name: alphanumeric, hyphens, underscores only, max 50 chars');
  JSON.parse(content); // throws if invalid JSON
  const filePath = path.join(getTagsDir(), name + '.json');
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
}

function deleteSettingsTag(name) {
  if (!validateTagName(name)) throw new Error('Invalid tag name');
  const filePath = path.join(getTagsDir(), name + '.json');
  if (!fs.existsSync(filePath)) throw new Error('Tag not found');
  fs.unlinkSync(filePath);
  return { ok: true };
}
```

- [ ] **Step 2: Update `module.exports` to include new functions**

Change the existing `module.exports` from:

```js
module.exports = {
  detect, readSettingsJson, writeSettingsJson,
  listPlugins, togglePlugin, installPlugin, testCustomProvider,
  getClaudeHome, maskToken,
};
```

to:

```js
module.exports = {
  detect, readSettingsJson, writeSettingsJson,
  listPlugins, togglePlugin, installPlugin, testCustomProvider,
  listSettingsTags, loadSettingsTag, saveSettingsTag, deleteSettingsTag,
  getClaudeHome, maskToken,
};
```

- [ ] **Step 3: Verify syntax**

```bash
node -c lib/claude-detector.js
```

- [ ] **Step 4: Commit**

```bash
git add lib/claude-detector.js
git commit -m "feat: add settings tag management methods to claude-detector"
```

---

### Task 2: IPC Handlers and Preload API for Tags

**Files:**
- Modify: `main.js`
- Modify: `preload.js`

- [ ] **Step 1: Add IPC handlers in `main.js`**

Add these handlers at the end of the Claude Code Manager IPC section (after the `save-custom-provider` handler, around line ~1205):

```js
ipcMain.handle('list-settings-tags', () => claudeDetector.listSettingsTags());

ipcMain.handle('load-settings-tag', (_, { name }) => claudeDetector.loadSettingsTag(name));

ipcMain.handle('save-settings-tag', (_, { name, content }) => {
  try { return claudeDetector.saveSettingsTag(name, content); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('delete-settings-tag', (_, { name }) => {
  try { return claudeDetector.deleteSettingsTag(name); }
  catch (e) { return { ok: false, error: e.message }; }
});
```

- [ ] **Step 2: Add preload API methods in `preload.js`**

Add these 4 lines after the existing `onInstallProgress` line (line ~82), before the closing `});`:

```js
  listSettingsTags:      () => ipcRenderer.invoke('list-settings-tags'),
  loadSettingsTag:       opts => ipcRenderer.invoke('load-settings-tag', opts),
  saveSettingsTag:       opts => ipcRenderer.invoke('save-settings-tag', opts),
  deleteSettingsTag:     opts => ipcRenderer.invoke('delete-settings-tag', opts),
```

- [ ] **Step 3: Verify syntax**

```bash
node -c main.js && node -c preload.js
```

- [ ] **Step 4: Commit**

```bash
git add main.js preload.js
git commit -m "feat: add settings tag IPC handlers and preload API"
```

---

### Task 3: Replace Settings Editor CSS

**Files:**
- Modify: `index.html` (CSS section)

- [ ] **Step 1: Replace scope toggle CSS with new editor CSS**

In `index.html`, replace the CSS block from `.ccm-editor-toolbar` through `.ccm-editor-status` (lines 251–260) with this new CSS:

Replace these lines:
```css
.ccm-editor-toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 0;margin-bottom:8px}
.ccm-scope-toggle{display:flex;gap:2px;background:var(--bg2);border-radius:5px;padding:2px;border:1px solid var(--bdr)}
.ccm-scope-btn{font-size:10px;padding:3px 10px;border-radius:3px;cursor:pointer;background:none;border:none;color:var(--tx2)}
.ccm-scope-btn.active{background:#238636;color:#fff;font-weight:500}
.ccm-editor-path{font-size:10px;color:var(--tx3);font-family:monospace;margin-left:8px}
.ccm-json-status{font-size:10px;margin-right:8px}
.ccm-json-status.valid{color:var(--grn)}
.ccm-json-status.invalid{color:var(--red)}
.ccm-editor-area{width:100%;min-height:300px;background:var(--bg);border:1px solid var(--bdr);border-radius:6px;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:12px;line-height:20px;color:var(--tx);padding:12px;resize:vertical;tab-size:2}
.ccm-editor-status{display:flex;justify-content:space-between;font-size:9px;color:var(--tx3);padding:4px 0}
```

With this new CSS:
```css
/* Settings Editor Layout */
.ccm-settings-layout{display:flex;height:100%;gap:0}
.ccm-sidebar{width:140px;border-right:1px solid var(--bdr);padding:10px;flex-shrink:0;overflow-y:auto}
.ccm-sidebar-header{font-size:9px;color:var(--acc);font-weight:600;text-transform:uppercase;margin-bottom:8px;letter-spacing:.5px}
.ccm-tag{padding:5px 8px;font-size:11px;border-radius:4px;cursor:pointer;color:var(--tx2);margin-bottom:2px;display:flex;align-items:center;justify-content:space-between}
.ccm-tag:hover{background:var(--bg2)}
.ccm-tag.active{background:var(--grn);color:#fff;font-weight:500}
.ccm-tag.active .ccm-tag-del{color:rgba(255,255,255,.6)}
.ccm-tag-del{color:var(--tx3);font-size:10px;cursor:pointer;background:none;border:none;padding:0 2px;display:none}
.ccm-tag:hover .ccm-tag-del{display:block}
.ccm-tag.active:hover .ccm-tag-del{display:block}
.ccm-tag-new{padding:5px 8px;font-size:10px;color:var(--acc);cursor:pointer;border:none;background:none;margin-top:6px;border-top:1px solid var(--bdr);padding-top:10px;width:100%;text-align:left}
.ccm-tag-new:hover{text-decoration:underline}
/* Editor Area */
.ccm-editor-main{flex:1;display:flex;flex-direction:column;overflow:hidden}
.ccm-editor-toolbar{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid var(--bdr);flex-shrink:0}
.ccm-mode-toggle{display:flex;gap:2px;background:var(--bg2);border-radius:5px;padding:2px;border:1px solid var(--bdr)}
.ccm-mode-btn{font-size:10px;padding:3px 10px;border-radius:3px;cursor:pointer;background:none;border:none;color:var(--tx2)}
.ccm-mode-btn.active{background:var(--grn);color:#fff;font-weight:500}
.ccm-editor-scroll{flex:1;overflow-y:auto;padding:12px}
.ccm-json-status{font-size:10px;margin-right:8px}
.ccm-json-status.valid{color:var(--grn)}
.ccm-json-status.invalid{color:var(--red)}
/* Raw editor */
.ccm-editor-area{width:100%;min-height:300px;background:var(--bg);border:1px solid var(--bdr);border-radius:6px;font-family:'Cascadia Code','Fira Code','JetBrains Mono',monospace;font-size:12px;line-height:20px;color:var(--tx);padding:12px;resize:vertical;tab-size:2;box-sizing:border-box}
/* Accordion sections */
.ccm-section{border:1px solid var(--bdr);border-radius:6px;margin-bottom:8px;overflow:hidden}
.ccm-section-header{display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:var(--bg2);cursor:pointer;user-select:none}
.ccm-section-header:hover{background:var(--bg3)}
.ccm-section-title{font-size:12px;font-weight:600;color:var(--tx)}
.ccm-section-count{font-size:9px;color:var(--tx2)}
.ccm-section-body{padding:10px 12px;display:none}
.ccm-section.open .ccm-section-body{display:block}
/* Form fields */
.ccm-field{margin-bottom:10px}
.ccm-field-label{font-size:9px;color:var(--tx2);text-transform:uppercase;margin-bottom:3px;letter-spacing:.3px}
.ccm-field-input{width:100%;background:var(--bg);border:1px solid var(--bdr);border-radius:4px;padding:5px 8px;font-size:11px;color:var(--tx);font-family:inherit;box-sizing:border-box}
.ccm-field-input:focus{border-color:var(--acc);outline:none}
.ccm-field-row{display:flex;gap:6px;align-items:center}
.ccm-field-select{background:var(--bg);border:1px solid var(--bdr);border-radius:4px;padding:5px 8px;font-size:11px;color:var(--tx);cursor:pointer}
.ccm-field-toggle{width:32px;height:18px;border-radius:9px;position:relative;cursor:pointer;border:none;transition:background .2s;flex-shrink:0}
.ccm-field-toggle.on{background:var(--grn)}
.ccm-field-toggle.off{background:var(--bg3)}
.ccm-field-toggle::after{content:'';width:14px;height:14px;border-radius:50%;background:#fff;position:absolute;top:2px;transition:left .2s}
.ccm-field-toggle.on::after{left:16px}
.ccm-field-toggle.off::after{left:2px}
/* Hook cards */
.ccm-hook-group{border:1px solid var(--bdr);border-radius:4px;margin-bottom:6px;overflow:hidden}
.ccm-hook-group-header{display:flex;align-items:center;justify-content:space-between;padding:6px 10px;background:var(--bg2);cursor:pointer;font-size:11px;color:var(--tx)}
.ccm-hook-card{padding:8px 10px;border-top:1px solid var(--bdr)}
.ccm-hook-card .ccm-field{margin-bottom:6px}
.ccm-add-btn{font-size:10px;color:var(--acc);cursor:pointer;background:none;border:1px dashed var(--bdr);border-radius:4px;padding:5px 10px;width:100%;text-align:center;margin-top:6px}
.ccm-add-btn:hover{border-color:var(--acc)}
.ccm-del-btn{font-size:9px;color:var(--red);cursor:pointer;background:none;border:none;padding:2px 6px;opacity:.6}
.ccm-del-btn:hover{opacity:1}
/* Save As dialog */
.ccm-saveas-dialog{background:var(--bg2);border:1px solid var(--bdr);border-radius:6px;padding:10px 12px;margin-top:8px;display:none}
.ccm-saveas-dialog.show{display:block}
.ccm-bottom-bar{display:flex;justify-content:flex-end;gap:6px;padding:8px 12px;border-top:1px solid var(--bdr);flex-shrink:0}
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat: replace settings editor CSS with sidebar layout and structured mode styles"
```

---

### Task 4: Replace Settings Editor JavaScript

**Files:**
- Modify: `index.html` (script section)

- [ ] **Step 1: Replace `renderSettingsEditor()` function**

In `index.html`, replace the entire block from `// ── Settings Editor Tab ───────────────────────` through the line before `// ── Plugins Tab ───────────────────────────────` (lines 1737–1805) with this new implementation:

```js
  // ── Settings Editor Tab ───────────────────────
  let editorMode='structured', selectedTag='__current__';
  let workingSettings=null; // parsed JSON object being edited

  async function renderSettingsEditor(){
    // Load tags
    const tagData=await window.api.listSettingsTags();
    const tagList=tagData.tags||[];

    body.innerHTML=`
      <div class="ccm-settings-layout">
        <div class="ccm-sidebar">
          <div class="ccm-sidebar-header">Configs</div>
          <div id="ccmTagList"></div>
          <button class="ccm-tag-new" id="ccmNewTag">+ New Tag</button>
        </div>
        <div class="ccm-editor-main">
          <div class="ccm-editor-toolbar">
            <div class="ccm-mode-toggle" id="ccmModeToggle">
              <button class="ccm-mode-btn active" data-mode="structured">Structured</button>
              <button class="ccm-mode-btn" data-mode="raw">Raw JSON</button>
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <span class="ccm-json-status" id="ccmJsonStatus" style="display:none"></span>
              <button class="ccm-btn ccm-btn-secondary" style="padding:4px 10px;font-size:10px" id="ccmSaveAs">Save As...</button>
              <button class="ccm-btn ccm-btn-primary" style="padding:4px 12px;font-size:10px" id="ccmSave">Save</button>
            </div>
          </div>
          <div class="ccm-editor-scroll" id="ccmEditorScroll"></div>
          <div class="ccm-saveas-dialog" id="ccmSaveAsDialog">
            <div style="display:flex;gap:6px;align-items:center">
              <input class="ccm-field-input" style="flex:1" id="ccmSaveAsName" placeholder="tag-name (alphanumeric, hyphens, underscores)">
              <button class="ccm-btn ccm-btn-primary" style="padding:4px 10px;font-size:10px" id="ccmSaveAsConfirm">Save</button>
              <button class="ccm-btn ccm-btn-secondary" style="padding:4px 8px;font-size:10px" id="ccmSaveAsCancel">Cancel</button>
            </div>
            <div id="ccmSaveAsError" style="font-size:10px;color:var(--red);margin-top:4px"></div>
          </div>
        </div>
      </div>
    `;

    const tagListEl=body.querySelector('#ccmTagList');
    const editorScroll=body.querySelector('#ccmEditorScroll');
    const statusEl=body.querySelector('#ccmJsonStatus');

    // Render tag sidebar
    function renderTags(){
      let html='<div class="ccm-tag'+(selectedTag==='__current__'?' active':'')+'" data-tag="__current__"><span>● Current</span></div>';
      for(const t of tagList){
        const act=selectedTag===t.name?' active':'';
        html+='<div class="ccm-tag'+act+'" data-tag="'+esc(t.name)+'"><span>'+esc(t.name)+'</span><button class="ccm-tag-del" data-del="'+esc(t.name)+'" title="Delete">✕</button></div>';
      }
      tagListEl.innerHTML=html;
      // Click handlers
      tagListEl.querySelectorAll('.ccm-tag').forEach(el=>{
        el.onclick=async(e)=>{
          if(e.target.closest('.ccm-tag-del'))return;
          selectedTag=el.dataset.tag;
          await loadTag(selectedTag);
          renderTags();
          renderEditor();
        };
      });
      tagListEl.querySelectorAll('.ccm-tag-del').forEach(btn=>{
        btn.onclick=async(e)=>{
          e.stopPropagation();
          const name=btn.dataset.del;
          if(!confirm('Delete tag "'+name+'"?'))return;
          await window.api.deleteSettingsTag({name});
          const idx=tagList.findIndex(t=>t.name===name);
          if(idx>=0)tagList.splice(idx,1);
          if(selectedTag===name){selectedTag='__current__';await loadTag('__current__')}
          renderTags();renderEditor();
        };
      });
    }

    // Load a tag's content
    async function loadTag(tag){
      if(tag==='__current__'){
        const r=await window.api.readClaudeSettings({scope:'global'});
        workingSettings=JSON.parse(r.content);
      } else {
        const r=await window.api.loadSettingsTag({name:tag});
        workingSettings=r.error?{}:JSON.parse(r.content);
      }
    }

    // Mode toggle
    body.querySelector('#ccmModeToggle').addEventListener('click',e=>{
      const btn=e.target.closest('.ccm-mode-btn');if(!btn)return;
      // Before switching, sync working state
      if(editorMode==='raw') syncFromRaw();
      editorMode=btn.dataset.mode;
      body.querySelectorAll('.ccm-mode-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      statusEl.style.display=editorMode==='raw'?'inline':'none';
      renderEditor();
    });

    // Render editor content based on mode
    function renderEditor(){
      if(editorMode==='structured') renderStructured();
      else renderRaw();
    }

    // ── Structured Mode ──
    function renderStructured(){
      const s=workingSettings||{};
      const env=s.env||{};
      const hooks=s.hooks||{};
      const envKeys=Object.keys(env);
      const hookTypes=Object.keys(hooks);
      const knownKeys=['env','model','hooks','statusLine','effortLevel','enabledPlugins','extraKnownMarketplaces','skipDangerousModePermissionPrompt'];
      const otherKeys=Object.keys(s).filter(k=>!knownKeys.includes(k));

      let html='';

      // Section 1: Environment
      html+='<div class="ccm-section open" data-section="env"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▼ Environment</span><span class="ccm-section-count">'+envKeys.length+' vars</span></div><div class="ccm-section-body" id="ccmEnvBody">';
      for(const k of envKeys){
        const isToken=/token|key|secret/i.test(k);
        html+='<div class="ccm-field"><div class="ccm-field-row"><div style="flex:1"><div class="ccm-field-label">'+esc(k)+'</div><input class="ccm-field-input" type="'+(isToken?'password':'text')+'" data-env="'+esc(k)+'" value="'+esc(env[k]||'')+'"></div>'+(isToken?'<button class="ccm-btn ccm-btn-secondary" style="padding:3px 6px;font-size:9px" onclick="const i=this.previousElementSibling.querySelector(\'input\');i.type=i.type===\'password\'?\'text\':\'password\'">👁</button>':'')+'<button class="ccm-del-btn" data-env-del="'+esc(k)+'">✕</button></div></div>';
      }
      html+='<button class="ccm-add-btn" id="ccmAddEnv">+ Add Variable</button></div></div>';

      // Section 2: Model & Effort
      const models=['claude-opus-4-6','claude-sonnet-4-20250514','claude-haiku-4-20250414'];
      const curModel=s.model||'';
      if(curModel&&!models.includes(curModel))models.unshift(curModel);
      const efforts=['low','medium','high'];
      html+='<div class="ccm-section open" data-section="model"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▼ Model & Effort</span></div><div class="ccm-section-body"><div style="display:flex;gap:12px"><div class="ccm-field" style="flex:1"><div class="ccm-field-label">Model</div><select class="ccm-field-select" style="width:100%" id="ccmModel">'+models.map(m=>'<option value="'+m+'"'+(m===curModel?' selected':'')+'>'+m+'</option>').join('')+'</select></div><div class="ccm-field" style="width:100px"><div class="ccm-field-label">Effort</div><select class="ccm-field-select" style="width:100%" id="ccmEffort">'+efforts.map(e=>'<option value="'+e+'"'+(e===(s.effortLevel||'high')?' selected':'')+'>'+e+'</option>').join('')+'</select></div></div></div></div>';

      // Section 3: Hooks
      html+='<div class="ccm-section" data-section="hooks"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Hooks</span><span class="ccm-section-count">'+hookTypes.reduce((n,t)=>{const arr=hooks[t];return n+(Array.isArray(arr)?arr.length:0)},0)+' hooks</span></div><div class="ccm-section-body" id="ccmHooksBody">';
      for(const htype of hookTypes){
        const entries=hooks[htype]||[];
        html+='<div class="ccm-hook-group"><div class="ccm-hook-group-header" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\'none\'?\'block\':\'none\'"><span>▶ '+esc(htype)+' ('+entries.length+')</span></div><div style="display:none">';
        for(let hi=0;hi<entries.length;hi++){
          const entry=entries[hi];
          const hks=entry.hooks||[];
          html+='<div class="ccm-hook-card"><div class="ccm-field"><div class="ccm-field-label">Matcher</div><input class="ccm-field-input" data-hook-matcher="'+esc(htype)+'.'+hi+'" value="'+esc(entry.matcher||'')+'"></div>';
          for(let hhi=0;hhi<hks.length;hhi++){
            const h=hks[hhi];
            html+='<div class="ccm-field"><div class="ccm-field-row"><div style="flex:1"><div class="ccm-field-label">Command</div><input class="ccm-field-input" data-hook-cmd="'+esc(htype)+'.'+hi+'.'+hhi+'" value="'+esc(h.command||'')+'"></div><div style="width:50px"><div class="ccm-field-label">Timeout</div><input class="ccm-field-input" type="number" data-hook-timeout="'+esc(htype)+'.'+hi+'.'+hhi+'" value="'+(h.timeout||'')+'"></div><button class="ccm-del-btn" data-hook-del="'+esc(htype)+'.'+hi+'.'+hhi+'">✕</button></div></div>';
          }
          html+='</div>';
        }
        html+='<div style="padding:6px 10px"><button class="ccm-add-btn" data-add-hook="'+esc(htype)+'">+ Add Hook to '+esc(htype)+'</button></div></div></div>';
      }
      html+='<button class="ccm-add-btn" id="ccmAddHookType" style="margin-top:4px">+ Add Event Type</button></div></div>';

      // Section 4: Status Line
      const sl=s.statusLine||{};
      html+='<div class="ccm-section" data-section="status"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Status Line</span></div><div class="ccm-section-body"><div class="ccm-field"><div class="ccm-field-label">Type</div><input class="ccm-field-input" id="ccmStatusType" value="'+esc(sl.type||'command')+'"></div><div class="ccm-field"><div class="ccm-field-label">Command</div><input class="ccm-field-input" id="ccmStatusCmd" value="'+esc(sl.command||'')+'"></div></div></div>';

      // Section 5: Flags & Other
      html+='<div class="ccm-section" data-section="flags"><div class="ccm-section-header" onclick="this.parentElement.classList.toggle(\'open\')"><span class="ccm-section-title">▶ Flags & Other</span><span class="ccm-section-count">'+(1+otherKeys.length)+' items</span></div><div class="ccm-section-body">';
      html+='<div class="ccm-field"><div class="ccm-field-row"><span style="font-size:11px;color:var(--tx)">Skip Dangerous Mode Prompt</span><button class="ccm-field-toggle '+(s.skipDangerousModePermissionPrompt?'on':'off')+'" id="ccmSkipDanger"></button></div></div>';
      for(const k of otherKeys){
        html+='<div class="ccm-field"><div class="ccm-field-label">'+esc(k)+'</div><div style="font-size:11px;color:var(--tx2);font-family:monospace">'+esc(JSON.stringify(s[k]))+'</div></div>';
      }
      html+='<div style="font-size:9px;color:var(--tx3);margin-top:6px">Unknown keys are read-only. Use Raw JSON mode to edit.</div></div></div>';

      editorScroll.innerHTML=html;

      // Wire up accordion arrow indicators
      editorScroll.querySelectorAll('.ccm-section-header').forEach(h=>{
        h.addEventListener('click',()=>{
          const title=h.querySelector('.ccm-section-title');
          const open=h.parentElement.classList.contains('open');
          title.textContent=(open?'▼':'▶')+title.textContent.substring(1);
        });
      });

      // Wire env delete buttons
      editorScroll.querySelectorAll('[data-env-del]').forEach(btn=>{
        btn.onclick=()=>{const k=btn.dataset.envDel;delete workingSettings.env[k];renderStructured()};
      });

      // Add env variable
      const addEnvBtn=editorScroll.querySelector('#ccmAddEnv');
      if(addEnvBtn)addEnvBtn.onclick=()=>{
        const name=prompt('Variable name (e.g., MY_VAR):');
        if(!name)return;
        if(!workingSettings.env)workingSettings.env={};
        workingSettings.env[name]='';
        renderStructured();
      };

      // Toggle skip dangerous
      const skipBtn=editorScroll.querySelector('#ccmSkipDanger');
      if(skipBtn)skipBtn.onclick=()=>{
        skipBtn.classList.toggle('on');skipBtn.classList.toggle('off');
        workingSettings.skipDangerousModePermissionPrompt=skipBtn.classList.contains('on');
      };

      // Add hook to type
      editorScroll.querySelectorAll('[data-add-hook]').forEach(btn=>{
        btn.onclick=()=>{
          const htype=btn.dataset.addHook;
          if(!workingSettings.hooks)workingSettings.hooks={};
          if(!workingSettings.hooks[htype])workingSettings.hooks[htype]=[];
          workingSettings.hooks[htype].push({matcher:'',hooks:[{type:'command',command:'',timeout:5}]});
          renderStructured();
        };
      });

      // Add new event type
      const addTypeBtn=editorScroll.querySelector('#ccmAddHookType');
      if(addTypeBtn)addTypeBtn.onclick=()=>{
        const name=prompt('Event type (e.g., PreToolUse, PostToolUse, SessionStart):');
        if(!name)return;
        if(!workingSettings.hooks)workingSettings.hooks={};
        if(!workingSettings.hooks[name])workingSettings.hooks[name]=[];
        renderStructured();
      };

      // Delete hook
      editorScroll.querySelectorAll('[data-hook-del]').forEach(btn=>{
        btn.onclick=()=>{
          const parts=btn.dataset.hookDel.split('.');
          const arr=workingSettings.hooks[parts[0]];
          if(arr&&arr[+parts[1]]){
            arr[+parts[1]].hooks.splice(+parts[2],1);
            if(!arr[+parts[1]].hooks.length)arr.splice(+parts[1],1);
          }
          renderStructured();
        };
      });
    }

    // Sync structured fields to workingSettings
    function syncFromStructured(){
      if(!workingSettings)workingSettings={};
      // Env
      const envInputs=editorScroll.querySelectorAll('[data-env]');
      if(envInputs.length){
        workingSettings.env={};
        envInputs.forEach(inp=>{workingSettings.env[inp.dataset.env]=inp.value});
      }
      // Model
      const modelEl=editorScroll.querySelector('#ccmModel');
      if(modelEl)workingSettings.model=modelEl.value;
      // Effort
      const effortEl=editorScroll.querySelector('#ccmEffort');
      if(effortEl)workingSettings.effortLevel=effortEl.value;
      // Hooks - matchers and commands
      editorScroll.querySelectorAll('[data-hook-matcher]').forEach(inp=>{
        const parts=inp.dataset.hookMatcher.split('.');
        if(workingSettings.hooks&&workingSettings.hooks[parts[0]]&&workingSettings.hooks[parts[0]][+parts[1]]){
          workingSettings.hooks[parts[0]][+parts[1]].matcher=inp.value;
        }
      });
      editorScroll.querySelectorAll('[data-hook-cmd]').forEach(inp=>{
        const parts=inp.dataset.hookCmd.split('.');
        if(workingSettings.hooks&&workingSettings.hooks[parts[0]]&&workingSettings.hooks[parts[0]][+parts[1]]&&workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]]){
          workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]].command=inp.value;
        }
      });
      editorScroll.querySelectorAll('[data-hook-timeout]').forEach(inp=>{
        const parts=inp.dataset.hookTimeout.split('.');
        if(workingSettings.hooks&&workingSettings.hooks[parts[0]]&&workingSettings.hooks[parts[0]][+parts[1]]&&workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]]){
          const v=parseInt(inp.value,10);
          if(!isNaN(v))workingSettings.hooks[parts[0]][+parts[1]].hooks[+parts[2]].timeout=v;
        }
      });
      // Status line
      const stType=editorScroll.querySelector('#ccmStatusType');
      const stCmd=editorScroll.querySelector('#ccmStatusCmd');
      if(stType&&stCmd){
        workingSettings.statusLine={type:stType.value,command:stCmd.value};
      }
    }

    // ── Raw JSON Mode ──
    function renderRaw(){
      if(editorMode==='structured')syncFromStructured();
      const json=JSON.stringify(workingSettings||{},null,2);
      editorScroll.innerHTML='<textarea class="ccm-editor-area" id="ccmRawEditor" spellcheck="false" style="height:calc(100% - 4px);min-height:350px">'+esc(json)+'</textarea>';
      const editor=editorScroll.querySelector('#ccmRawEditor');
      statusEl.style.display='inline';
      validateRawJson();

      editor.addEventListener('input',validateRawJson);
      editor.addEventListener('keydown',e=>{
        if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();body.querySelector('#ccmSave').click()}
        if(e.key==='Tab'){e.preventDefault();const s=editor.selectionStart,end=editor.selectionEnd;editor.value=editor.value.substring(0,s)+'  '+editor.value.substring(end);editor.selectionStart=editor.selectionEnd=s+2;validateRawJson()}
      });

      function validateRawJson(){
        try{JSON.parse(editor.value);statusEl.textContent='● Valid JSON';statusEl.className='ccm-json-status valid';body.querySelector('#ccmSave').disabled=false}
        catch(e){statusEl.textContent='● Invalid JSON';statusEl.className='ccm-json-status invalid';body.querySelector('#ccmSave').disabled=true}
      }
    }

    function syncFromRaw(){
      const editor=editorScroll.querySelector('#ccmRawEditor');
      if(editor){try{workingSettings=JSON.parse(editor.value)}catch{/* keep old */}}
    }

    // ── Save ──
    body.querySelector('#ccmSave').onclick=async()=>{
      if(editorMode==='structured')syncFromStructured();
      else syncFromRaw();
      const content=JSON.stringify(workingSettings,null,2);
      let r;
      if(selectedTag==='__current__'){
        r=await window.api.writeClaudeSettings({scope:'global',content});
      } else {
        r=await window.api.saveSettingsTag({name:selectedTag,content});
      }
      if(r.ok){statusEl.style.display='inline';statusEl.textContent='● Saved ✓';statusEl.className='ccm-json-status valid';setTimeout(()=>{if(editorMode==='structured')statusEl.style.display='none'},1500)}
      else{statusEl.style.display='inline';statusEl.textContent='● Error: '+(r.error||'');statusEl.className='ccm-json-status invalid'}
    };

    // ── Save As ──
    const saveAsDialog=body.querySelector('#ccmSaveAsDialog');
    body.querySelector('#ccmSaveAs').onclick=()=>{saveAsDialog.classList.toggle('show')};
    body.querySelector('#ccmSaveAsCancel').onclick=()=>{saveAsDialog.classList.remove('show')};
    body.querySelector('#ccmSaveAsConfirm').onclick=async()=>{
      const name=body.querySelector('#ccmSaveAsName').value.trim();
      const errEl=body.querySelector('#ccmSaveAsError');
      if(!name||!/^[a-zA-Z0-9_-]+$/.test(name)||name.length>50){errEl.textContent='Invalid name: alphanumeric, hyphens, underscores, max 50 chars';return}
      if(editorMode==='structured')syncFromStructured();
      else syncFromRaw();
      const content=JSON.stringify(workingSettings,null,2);
      const r=await window.api.saveSettingsTag({name,content});
      if(r.ok){
        saveAsDialog.classList.remove('show');
        if(!tagList.find(t=>t.name===name))tagList.push({name,path:r.path});
        tagList.sort((a,b)=>a.name.localeCompare(b.name));
        selectedTag=name;
        renderTags();
        statusEl.style.display='inline';statusEl.textContent='● Saved as "'+name+'" ✓';statusEl.className='ccm-json-status valid';
        setTimeout(()=>{if(editorMode==='structured')statusEl.style.display='none'},1500);
      } else {errEl.textContent=r.error||'Failed to save'}
    };

    // ── New Tag (sidebar) ──
    body.querySelector('#ccmNewTag').onclick=()=>{saveAsDialog.classList.add('show');body.querySelector('#ccmSaveAsName').focus()};

    // Keyboard shortcut
    body.addEventListener('keydown',e=>{
      if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();body.querySelector('#ccmSave').click()}
    });

    // Initial load
    await loadTag(selectedTag);
    renderTags();
    renderEditor();
  }
```

- [ ] **Step 2: Verify the file loads without errors**

```bash
node -e "const fs=require('fs');const html=fs.readFileSync('index.html','utf8');console.log('renderSettingsEditor found:',html.includes('renderSettingsEditor'));console.log('ccm-settings-layout found:',html.includes('ccm-settings-layout'));console.log('ccm-sidebar found:',html.includes('ccm-sidebar'));console.log('listSettingsTags found:',html.includes('listSettingsTags'))"
```

Expected: all 4 checks print `true`

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: replace settings editor with structured panels, raw mode, and tag history"
```

---

### Task 5: Smoke Test

**Files:** None (testing only)

- [ ] **Step 1: Start the app**

```bash
npm start
```

- [ ] **Step 2: Click the Claude Code badge → Settings.json tab**

Expected: Left sidebar shows "● Current", right side shows accordion sections (Environment expanded with your ANTHROPIC_BASE_URL and masked token, Model & Effort with dropdowns).

- [ ] **Step 3: Toggle between Structured and Raw JSON modes**

Expected: Switching to Raw shows formatted JSON. Switching back to Structured re-populates the form fields. Edits persist across switches.

- [ ] **Step 4: Test Save**

Expected: Click Save with Current selected → writes to `~/.claude/settings.json`. Status shows "Saved ✓".

- [ ] **Step 5: Test Save As**

Expected: Click Save As → enter "test-config" → creates `~/.claude/settings-tags/test-config.json`. New tag appears in sidebar.

- [ ] **Step 6: Test tag switching**

Expected: Click "test-config" in sidebar → loads its content. Click "Current" → loads live settings.

- [ ] **Step 7: Test tag deletion**

Expected: Hover over "test-config" → X appears → click → confirm → tag removed from sidebar and file deleted.

- [ ] **Step 8: Test hook editing**

Expected: Expand Hooks section → expand PostToolUse → see matcher and command fields → edit a value → Save → verify in `~/.claude/settings.json`.
