# Startup Health Check & Auto-Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect whether Claude Code is installed and authenticated on every app startup, offer one-click installation if missing, and install recommended plugins — with the ability to snapshot currently installed plugins as "recommended."

**Architecture:** A startup health check runs in main.js after window creation. It calls existing `claudeDetector.detect()` and `claudeDetector.listPlugins()`, compares against a `system.recommendedPlugins` setting, and sends results to the renderer. If anything is missing, a setup modal appears. Two new IPC handlers (`run-health-check`, `snapshot-recommended-plugins`) coordinate between main and renderer. All heavy lifting reuses existing modules.

**Tech Stack:** Electron IPC, existing `claude-detector.js`, existing `claude-installer.js`, `settings-db.js` (SQLite)

---

## File Structure

| File | Role |
|------|------|
| `settings-db.js` | Add `system.recommendedPlugins` schema entry |
| `main.js` | Add `run-health-check` and `snapshot-recommended-plugins` IPC handlers, startup health check trigger after window creation |
| `preload.js` | Expose `runHealthCheck()`, `snapshotRecommendedPlugins()`, `onHealthCheck()` APIs |
| `index.html` | Setup modal HTML/CSS/JS, health check event listener, "Set as recommended" button in System settings |

---

### Task 1: Add `system.recommendedPlugins` Setting

**Files:**
- Modify: `settings-db.js` — lines 50-52 (between `system.preventSleep` and `system.autoUpdate`)

- [ ] **Step 1: Add the schema entry**

In `settings-db.js`, add a new entry in `SETTINGS_SCHEMA` between the `system.preventSleep` and `system.autoUpdate` entries:

```javascript
  'system.recommendedPlugins':                { category:'system',        type:'hidden', label:'Recommended Plugins',        default:'[]',          description:'JSON array of recommended plugins to install on setup. Set via "Save as Recommended" button.' },
```

Insert this line directly after line 51 (`system.preventSleep` entry) and before line 52 (`system.autoUpdate` entry).

- [ ] **Step 2: Add JSON parse for recommendedPlugins in buildConfigObject**

In `settings-db.js`, in the `buildConfigObject()` function, add a parse block after the `masterTelegram.chatIds` parse block (after line 302). This ensures the JSON string is parsed into an array:

```javascript
  // Ensure system.recommendedPlugins is an array
  if (config.system && typeof config.system.recommendedPlugins === 'string') {
    try { config.system.recommendedPlugins = JSON.parse(config.system.recommendedPlugins); } catch { config.system.recommendedPlugins = []; }
  }
```

- [ ] **Step 3: Verify the setting initializes correctly**

Run the app, open the developer console, and run:
```javascript
await api.getSetting('system.recommendedPlugins')
```
Expected: Returns `"[]"` (string) from the DB. The `buildConfigObject()` will parse it into an actual empty array `[]`.

- [ ] **Step 4: Commit**

```bash
git add settings-db.js
git commit -m "feat: add system.recommendedPlugins setting for startup health check"
```

---

### Task 2: Add IPC Handlers in main.js

**Files:**
- Modify: `main.js` — add two new IPC handlers near line 1227 (end of file, after the `check-claude-update` handler), and add health check trigger in `app.whenReady()` block

- [ ] **Step 1: Add the `run-health-check` IPC handler**

At the end of `main.js` (after line 1227, the `check-claude-update` handler), add:

```javascript
// ── Startup Health Check ─────────────────────────
ipcMain.handle('run-health-check', async () => {
  const detection = claudeDetector.detect();
  const pluginData = detection.installed ? claudeDetector.listPlugins() : { installed: [] };

  // Parse recommended plugins from settings
  let recommended = [];
  try {
    const raw = settingsDb.get('system.recommendedPlugins');
    recommended = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
  } catch { recommended = []; }

  const installedKeys = pluginData.installed.map(p => p.key);
  const missing = recommended.filter(r => !installedKeys.includes(r.key));

  const healthy = detection.installed
    && detection.authType !== null
    && (recommended.length === 0 || missing.length === 0);

  return {
    claudeCode: {
      installed: detection.installed,
      version: detection.version,
      authenticated: detection.authType !== null,
      authType: detection.authType,
      authDetail: detection.authDetail,
    },
    plugins: {
      recommended,
      installed: pluginData.installed,
      missing,
    },
    recommendedEmpty: recommended.length === 0,
    healthy,
  };
});

ipcMain.handle('snapshot-recommended-plugins', async () => {
  const pluginData = claudeDetector.listPlugins();
  const enabled = pluginData.installed.filter(p => p.enabled);
  const recommended = enabled.map(p => ({ key: p.key, repo: p.source }));
  const json = JSON.stringify(recommended);
  settingsDb.set('system.recommendedPlugins', json);
  return recommended;
});
```

- [ ] **Step 2: Add health check trigger after window creation**

In the `app.whenReady()` block, after `createWindow();` (line 322) and before the auto-update section (line 324), add the health check send. The health check runs after a brief delay to let the renderer load:

```javascript
  // ── Startup Health Check ──────────────────────────
  setTimeout(async () => {
    try {
      const detection = claudeDetector.detect();
      const pluginData = detection.installed ? claudeDetector.listPlugins() : { installed: [] };
      let recommended = [];
      try {
        const raw = settingsDb.get('system.recommendedPlugins');
        recommended = typeof raw === 'string' ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []);
      } catch { recommended = []; }
      const installedKeys = pluginData.installed.map(p => p.key);
      const missing = recommended.filter(r => !installedKeys.includes(r.key));
      const healthy = detection.installed
        && detection.authType !== null
        && (recommended.length === 0 || missing.length === 0);
      const status = {
        claudeCode: {
          installed: detection.installed,
          version: detection.version,
          authenticated: detection.authType !== null,
          authType: detection.authType,
          authDetail: detection.authDetail,
        },
        plugins: { recommended, installed: pluginData.installed, missing },
        recommendedEmpty: recommended.length === 0,
        healthy,
      };
      if (!healthy) {
        send('health-check', status);
      }
    } catch (err) {
      logger.info('startup', `Health check failed: ${err.message}`);
    }
  }, 2000);
```

- [ ] **Step 3: Verify IPC handlers are registered**

Start the app. In developer console, run:
```javascript
const result = await api.runHealthCheck();
console.log(JSON.stringify(result, null, 2));
```
Expected: Returns a health status object with `claudeCode`, `plugins`, `recommendedEmpty`, and `healthy` fields.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat: add health check IPC handlers and startup trigger"
```

---

### Task 3: Expose APIs in preload.js

**Files:**
- Modify: `preload.js` — add 3 new entries to the `api` object

- [ ] **Step 1: Add the health check APIs**

In `preload.js`, add these entries inside the `contextBridge.exposeInMainWorld('api', { ... })` block. Add them in the "Claude Code Manager" section (after `onInstallProgress` on line 82, before `listSettingsTags` on line 83):

```javascript
  runHealthCheck:            () => ipcRenderer.invoke('run-health-check'),
  snapshotRecommendedPlugins:() => ipcRenderer.invoke('snapshot-recommended-plugins'),
  onHealthCheck:             cb => safeOn('health-check', cb),
```

- [ ] **Step 2: Verify the API is accessible**

Start the app. In developer console, run:
```javascript
typeof api.runHealthCheck    // 'function'
typeof api.snapshotRecommendedPlugins // 'function'
typeof api.onHealthCheck     // 'function'
```
Expected: All return `'function'`.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat: expose health check APIs in preload bridge"
```

---

### Task 4: Setup Modal — HTML and CSS

**Files:**
- Modify: `index.html` — add modal HTML after existing CCM modal, add CSS styles

- [ ] **Step 1: Add the setup modal overlay and HTML**

In `index.html`, find the CCM modal overlay (search for `id="ccmOverlay"`). After the closing `</div>` of the CCM modal (the `<div class="ccm-modal" id="ccmModal">...</div>` block), add the setup modal HTML:

```html
<!-- Setup Health Check Modal -->
<div class="setup-overlay" id="setupOverlay"></div>
<div class="setup-modal" id="setupModal">
  <div class="setup-header">
    <span>🔧 Auto Claude Setup</span>
    <button class="setup-close" id="setupClose">&times;</button>
  </div>
  <div class="setup-body" id="setupBody">
    <div class="setup-items" id="setupItems"></div>
    <div class="setup-recommended-prompt" id="setupRecommendedPrompt" style="display:none">
      <p>You have plugins installed. Save them as recommended for future setups?</p>
      <div class="setup-actions">
        <button class="setup-btn primary" id="setupSaveRecommended">Save as Recommended</button>
        <button class="setup-btn" id="setupSkipRecommended">Skip</button>
      </div>
    </div>
    <hr class="setup-divider">
    <div class="setup-actions" id="setupActions">
      <button class="setup-btn primary" id="setupInstallAll" style="display:none">Install All Missing</button>
      <button class="setup-btn" id="setupDismiss">Dismiss</button>
    </div>
    <div class="setup-progress" id="setupProgress" style="display:none">
      <div class="setup-progress-text" id="setupProgressText"></div>
      <div class="setup-progress-bar"><div class="setup-progress-fill" id="setupProgressFill"></div></div>
    </div>
    <div class="setup-success" id="setupSuccess" style="display:none">✅ All set!</div>
  </div>
</div>
```

- [ ] **Step 2: Add CSS styles for the setup modal**

In the `<style>` section of `index.html`, after the CCM modal styles (after the `.ccm-modal` rules around line 204), add:

```css
/* Setup Health Check Modal */
.setup-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:320}
.setup-overlay.show{display:block}
.setup-modal{display:none;position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:var(--bg);border:1px solid var(--bdr);border-radius:10px;z-index:321;width:520px;max-width:92vw;max-height:80vh;box-shadow:0 12px 40px rgba(0,0,0,.6);overflow:hidden;flex-direction:column}
.setup-modal.show{display:flex}
.setup-header{display:flex;align-items:center;justify-content:space-between;padding:14px 18px;border-bottom:1px solid var(--bdr);font-size:15px;font-weight:600;color:var(--tx)}
.setup-close{background:none;border:none;color:var(--tx2);font-size:20px;cursor:pointer;padding:0 4px}
.setup-close:hover{color:var(--tx)}
.setup-body{padding:18px;overflow-y:auto}
.setup-items{display:flex;flex-direction:column;gap:10px;margin-bottom:14px}
.setup-item{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:var(--bg2);font-size:13px;color:var(--tx)}
.setup-item .status-icon{font-size:16px;flex-shrink:0}
.setup-item .item-label{flex:1}
.setup-item .item-detail{color:var(--tx2);font-size:12px;margin-left:4px}
.setup-item .item-action{flex-shrink:0}
.setup-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--bdr);background:var(--bg2);color:var(--tx);font-size:12px;cursor:pointer;transition:background .15s}
.setup-btn:hover{background:var(--bg3,#1a2332)}
.setup-btn.primary{background:var(--ac,#58a6ff);color:#000;border-color:var(--ac,#58a6ff);font-weight:600}
.setup-btn.primary:hover{opacity:.85}
.setup-btn:disabled{opacity:.4;cursor:not-allowed}
.setup-divider{border:none;border-top:1px solid var(--bdr);margin:14px 0}
.setup-actions{display:flex;gap:8px;justify-content:flex-end}
.setup-progress{margin-top:12px}
.setup-progress-text{font-size:12px;color:var(--tx2);margin-bottom:6px}
.setup-progress-bar{height:6px;background:var(--bg2);border-radius:3px;overflow:hidden}
.setup-progress-fill{height:100%;background:var(--ac,#58a6ff);border-radius:3px;transition:width .3s;width:0%}
.setup-success{text-align:center;font-size:15px;padding:18px 0;color:var(--ac,#58a6ff);font-weight:600}
.setup-recommended-prompt{background:var(--bg2);border-radius:8px;padding:12px 14px;margin-bottom:14px}
.setup-recommended-prompt p{font-size:13px;color:var(--tx);margin:0 0 10px}
```

- [ ] **Step 3: Verify modal renders**

Start the app. In developer console, run:
```javascript
document.getElementById('setupOverlay').classList.add('show');
document.getElementById('setupModal').classList.add('show');
```
Expected: The setup modal appears centered on screen with the header "🔧 Auto Claude Setup", an empty items area, and a Dismiss button.

Close it:
```javascript
document.getElementById('setupOverlay').classList.remove('show');
document.getElementById('setupModal').classList.remove('show');
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add setup modal HTML and CSS for startup health check"
```

---

### Task 5: Setup Modal — JavaScript Logic

**Files:**
- Modify: `index.html` — add JavaScript in a `<script>` block or within the existing inline scripts

- [ ] **Step 1: Add the setup modal controller**

In `index.html`, find the existing CCM modal JavaScript block (starts around line 1516 with `const overlay=$('ccmOverlay')`). After the entire CCM modal IIFE/block, add the setup modal controller:

```javascript
// ── Setup Health Check Modal ─────────────────────
(function(){
  const overlay=$('setupOverlay'), modal=$('setupModal');
  const items=$('setupItems'), actions=$('setupActions');
  const installAllBtn=$('setupInstallAll'), dismissBtn=$('setupDismiss');
  const progress=$('setupProgress'), progressText=$('setupProgressText'), progressFill=$('setupProgressFill');
  const success=$('setupSuccess'), recPrompt=$('setupRecommendedPrompt');
  const saveRecBtn=$('setupSaveRecommended'), skipRecBtn=$('setupSkipRecommended');
  let currentStatus=null;

  function openSetup(status){
    currentStatus=status;
    renderItems(status);
    overlay.classList.add('show');modal.classList.add('show');
    progress.style.display='none';success.style.display='none';
  }
  function closeSetup(){overlay.classList.remove('show');modal.classList.remove('show')}

  $('setupClose').onclick=closeSetup;
  overlay.onclick=closeSetup;
  dismissBtn.onclick=closeSetup;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&modal.classList.contains('show'))closeSetup()});

  function renderItems(s){
    items.innerHTML='';
    // Claude Code row
    if(!s.claudeCode.installed){
      items.innerHTML+=setupItem('❌','Claude Code','Not installed',`<button class="setup-btn" onclick="setupInstallClaude()">Install</button>`);
    } else if(!s.claudeCode.authenticated){
      items.innerHTML+=setupItem('⚠️',`Claude Code v${s.claudeCode.version}`,'Not authenticated',`<button class="setup-btn" onclick="setupAuthClaude()">Authenticate</button>`);
    } else {
      items.innerHTML+=setupItem('✅',`Claude Code v${s.claudeCode.version}`,`${s.claudeCode.authType}${s.claudeCode.authDetail?' — '+s.claudeCode.authDetail:''}`,'');
    }

    // Plugin rows
    for(const p of s.plugins.recommended){
      const inst=s.plugins.installed.find(i=>i.key===p.key);
      if(inst&&inst.enabled){
        items.innerHTML+=setupItem('✅',p.key.split('@')[0],'Installed','');
      } else {
        items.innerHTML+=setupItem('❌',p.key.split('@')[0],'Missing',`<button class="setup-btn" onclick="setupInstallPlugin('${escHtml(p.key)}','${escHtml(p.repo)}')">Install</button>`);
      }
    }

    // Show "Install All" if there are missing items
    const hasMissing=!s.claudeCode.installed||!s.claudeCode.authenticated||s.plugins.missing.length>0;
    installAllBtn.style.display=hasMissing?'inline-block':'none';

    // Show recommended prompt if recommended is empty and plugins exist
    if(s.recommendedEmpty&&s.plugins.installed.length>0){
      recPrompt.style.display='block';
    } else {
      recPrompt.style.display='none';
    }
  }

  function setupItem(icon,label,detail,action){
    return `<div class="setup-item"><span class="status-icon">${icon}</span><span class="item-label">${escHtml(label)}<span class="item-detail">${escHtml(detail)}</span></span><span class="item-action">${action}</span></div>`;
  }

  // Individual install actions (global scope)
  window.setupInstallClaude=async function(){
    const method=navigator.platform.startsWith('Win')?'powershell':'curl';
    showProgress('Installing Claude Code...');
    try{
      const result=await api.installClaudeCode({method});
      if(result.ok){await refreshStatus();}
      else{showProgress('Install failed: '+(result.error||'Unknown error'));}
    }catch(e){showProgress('Install error: '+e.message);}
  };
  window.setupAuthClaude=async function(){
    showProgress('Authenticating Claude Code...');
    try{
      const result=await api.authenticateClaudeCode({method:'oauth'});
      if(result.ok){await refreshStatus();}
      else{showProgress('Auth failed: '+(result.error||'Unknown error'));}
    }catch(e){showProgress('Auth error: '+e.message);}
  };
  window.setupInstallPlugin=async function(key,repo){
    const name=key.split('@')[0];
    const source=key.split('@')[1]||repo;
    showProgress(`Installing ${name}...`);
    try{
      const result=await api.installClaudePlugin({source,repo});
      if(result.ok){await refreshStatus();}
      else{showProgress('Plugin install failed: '+(result.error||'Unknown error'));}
    }catch(e){showProgress('Plugin install error: '+e.message);}
  };

  // Install All Missing — sequential
  installAllBtn.onclick=async function(){
    installAllBtn.disabled=true;
    const s=currentStatus;
    let step=0;
    const total=(!s.claudeCode.installed?1:0)+(!s.claudeCode.authenticated?1:0)+s.plugins.missing.length;
    if(total===0){installAllBtn.disabled=false;return;}

    if(!s.claudeCode.installed){
      step++;updateProgress(step,total,'Installing Claude Code...');
      try{
        const r=await api.installClaudeCode({method:navigator.platform.startsWith('Win')?'powershell':'curl'});
        if(!r.ok){showProgress('Install failed: '+(r.error||''));installAllBtn.disabled=false;return;}
      }catch(e){showProgress('Install error: '+e.message);installAllBtn.disabled=false;return;}
    }
    // Refresh detection after install
    const freshDetect=await api.detectClaudeCode();
    if(!freshDetect.installed){showProgress('Claude Code install did not succeed.');installAllBtn.disabled=false;return;}

    if(!freshDetect.authType){
      step++;updateProgress(step,total,'Authenticating...');
      try{
        const r=await api.authenticateClaudeCode({method:'oauth'});
        if(!r.ok){showProgress('Auth failed: '+(r.error||''));installAllBtn.disabled=false;return;}
      }catch(e){showProgress('Auth error: '+e.message);installAllBtn.disabled=false;return;}
    }

    for(const p of s.plugins.missing){
      step++;updateProgress(step,total,`Installing ${p.key.split('@')[0]}...`);
      try{
        const source=p.key.split('@')[1]||p.repo;
        await api.installClaudePlugin({source,repo:p.repo});
      }catch(e){showProgress(`Plugin error: ${e.message}`);installAllBtn.disabled=false;return;}
    }

    installAllBtn.disabled=false;
    await refreshStatus();
  };

  // Save as recommended
  saveRecBtn.onclick=async function(){
    try{
      const result=await api.snapshotRecommendedPlugins();
      recPrompt.style.display='none';
      showProgress(`Saved ${result.length} plugin(s) as recommended.`);
      setTimeout(()=>{progress.style.display='none';},2000);
    }catch(e){showProgress('Error: '+e.message);}
  };
  skipRecBtn.onclick=()=>{recPrompt.style.display='none';};

  // Progress helpers
  function showProgress(text){progress.style.display='block';progressText.textContent=text;progressFill.style.width='0%';}
  function updateProgress(step,total,text){
    progress.style.display='block';
    progressText.textContent=text;
    progressFill.style.width=Math.round((step/total)*100)+'%';
  }

  // Refresh health status and re-render
  async function refreshStatus(){
    const s=await api.runHealthCheck();
    currentStatus=s;
    renderItems(s);
    progress.style.display='none';
    if(s.healthy){
      success.style.display='block';
      items.style.display='none';
      actions.style.display='none';
      recPrompt.style.display='none';
      setTimeout(closeSetup,2000);
    }
  }

  // Listen for health check from main process (startup)
  api.onHealthCheck(status=>{
    if(!status.healthy){openSetup(status);}
  });

  // Install progress listener for streaming output
  api.onInstallProgress(data=>{
    if(data.output)progressText.textContent=data.output.trim().split('\n').pop()||'';
    if(data.done&&!data.error)progressText.textContent='Installation complete.';
    if(data.error)progressText.textContent='Error: '+data.error;
  });
})();
```

- [ ] **Step 2: Verify the full flow**

Start the app. In developer console, simulate a health check event:
```javascript
const s = await api.runHealthCheck();
console.log('Healthy:', s.healthy);
// If not healthy, modal should have appeared on startup
// If healthy, force-open it to test:
// api.onHealthCheck is wired, but we can manually trigger for testing
```

Or test the full flow by temporarily removing Claude Code's credentials directory, restarting the app, and verifying the setup modal appears.

- [ ] **Step 3: Commit**

```bash
git add index.html
git commit -m "feat: add setup modal JavaScript logic with install-all and plugin snapshot"
```

---

### Task 6: "Set as Recommended" Button in System Settings

**Files:**
- Modify: `index.html` — add button in the System settings category rendering

- [ ] **Step 1: Add the button in the settings rendering**

In `index.html`, find the settings rendering function. Look for where the System category settings are rendered. After the settings fields for the `system` category are rendered, we need to inject a custom button. Find the function that renders category settings (around the `renderSettings` or `renderCategory` block). 

The cleanest approach: after the settings content is rendered for a category, check if the category is `system` and append a custom block. Find the place where category fields are appended to the settings content area. After the loop that creates fields for a category, add:

```javascript
    // Add "Set as recommended" button for System category
    if(cat==='system'){
      const recDiv=document.createElement('div');
      recDiv.style.cssText='margin-top:18px;padding-top:14px;border-top:1px solid var(--bdr)';
      recDiv.innerHTML=`<label class="settings-label">Recommended Plugins</label>
        <p style="font-size:12px;color:var(--tx2);margin:4px 0 10px">Snapshot your currently installed Claude Code plugins as the recommended set. The setup modal will prompt to install these on fresh setups.</p>
        <button class="setup-btn primary" id="settingsSnapshotPlugins">Set current plugins as recommended</button>
        <span id="settingsSnapshotResult" style="margin-left:8px;font-size:12px;color:var(--ac,#58a6ff);display:none"></span>`;
      container.appendChild(recDiv);
      setTimeout(()=>{
        const btn=$('settingsSnapshotPlugins');
        const resultSpan=$('settingsSnapshotResult');
        if(btn)btn.onclick=async()=>{
          btn.disabled=true;btn.textContent='Saving...';
          try{
            const result=await api.snapshotRecommendedPlugins();
            resultSpan.textContent=`Saved ${result.length} plugin(s) ✓`;
            resultSpan.style.display='inline';
            setTimeout(()=>{resultSpan.style.display='none';},3000);
          }catch(e){resultSpan.textContent='Error: '+e.message;resultSpan.style.display='inline';}
          btn.disabled=false;btn.textContent='Set current plugins as recommended';
        };
      },0);
    }
```

Note: `container` refers to the DOM element where category fields are appended. Check the actual variable name used in the settings rendering code — it might be `content`, `panel`, `catDiv`, or similar. The implementer should look at the existing settings rendering loop to find the correct container variable name. In the codebase, settings fields are appended to `settingsContent` (id `settingsContent`). Find the block that handles rendering fields for a selected category and add this after all fields are added.

- [ ] **Step 2: Verify the button appears**

Start the app, open Settings, click the "System" category tab. Expected: At the bottom of the System settings, there should be a "Recommended Plugins" section with a "Set current plugins as recommended" button.

- [ ] **Step 3: Test snapshot functionality**

Click the "Set current plugins as recommended" button. Expected: Button briefly shows "Saving...", then a confirmation "Saved N plugin(s) ✓" appears for 3 seconds.

Verify the saved data:
```javascript
await api.getSetting('system.recommendedPlugins')
```
Expected: Returns a JSON string array of plugin objects like `[{"key":"superpowers@superpowers","repo":"superpowers"}]`.

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add 'Set as recommended' button in System settings"
```

---

### Task 7: End-to-End Test

**Files:**
- No new files — manual verification

- [ ] **Step 1: Test healthy startup (no modal)**

Prerequisites: Claude Code installed, authenticated, no recommended plugins set (empty list).

1. Start the app
2. Expected: No setup modal appears (healthy = true because recommended list is empty)

- [ ] **Step 2: Test with recommended plugins set but all installed**

1. Open Settings → System → click "Set current plugins as recommended"
2. Restart the app
3. Expected: No setup modal (all recommended plugins are already installed)

- [ ] **Step 3: Test with missing plugin**

1. Manually edit the recommended plugins in dev console to include a non-installed plugin:
   ```javascript
   await api.setSetting('system.recommendedPlugins', JSON.stringify([{key:'fake-plugin@fake',repo:'fake/repo'}]))
   ```
2. Restart the app
3. Expected: Setup modal appears showing the missing plugin with an Install button

- [ ] **Step 4: Test "Install All Missing" button**

With the setup modal showing missing items, click "Install All Missing". Verify:
- Progress bar appears
- Steps execute sequentially
- On completion, modal shows "All set!" and auto-closes after 2 seconds

- [ ] **Step 5: Test recommended plugins empty state**

1. Clear recommended plugins: `await api.setSetting('system.recommendedPlugins', '[]')`
2. Ensure Claude Code is installed with plugins
3. Run `const s = await api.runHealthCheck(); api.onHealthCheck(s);` or trigger manually
4. Force the modal open and verify the "Save as Recommended" prompt appears

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: startup health check and auto-setup complete"
```
