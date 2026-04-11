// lib/summarize.js — Shared tool call summarization (L2: deduplicated from proxy.js + auto-claude-hook.js)

function summarize(toolName, input) {
  if (!input) return '';
  try {
    const name = toolName || '';
    const n = name.toLowerCase();
    if (n === 'bash')      return input.command ? `$ ${(input.command || '').substring(0, 120)}` : '';
    if (n === 'read')      return input.file_path || input.path || '';
    if (n === 'write')     return input.file_path || input.path || '';
    if (n === 'edit')      return input.file_path || input.path || '';
    if (n === 'multiedit' || n === 'multi_edit') return input.file_path || input.path || '';
    if (n === 'grep')      return `"${(input.pattern || input.query || '').substring(0, 60)}"`;
    if (n === 'glob')      return input.pattern || '';
    if (n === 'task')      return (input.description || input.prompt || '').substring(0, 100);
    if (n === 'webfetch')  return input.url || '';
    // Fallback: return first non-empty string value
    const vals = Object.values(input);
    for (const v of vals) {
      if (typeof v === 'string' && v.length > 0) return v.substring(0, 100);
    }
  } catch (err) {
    // Non-critical: log but don't crash
    process.stderr.write(`[auto-claude] summarize error: ${err.message}\n`);
  }
  return '';
}

module.exports = summarize;
