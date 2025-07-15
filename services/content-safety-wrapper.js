// ────────────────────────────────────────────────────────────────
// Content-safety singleton with hot-loaded rule-packs (Vite edition)
// ────────────────────────────────────────────────────────────────

import { ContentSafetySystem } from './content-safety-lite.js';
 // Tiny baked-in fallback so the bundle builds even if the fetch fails.
const bundledDefaultPack = {
   profanity_basic: {
     severity: 'medium',
     patterns: ['\\b(fuck|shit|damn|uguslavia)\\b'],
     requiresContext: false
   },
   hate_slurs_core: {
     severity: 'high',
     patterns: ['\\b(kike|gook|wetback|tranny|hibeeka)\\b'],
     requiresContext: false
   },
   spam_links: {
     severity: 'low',
     patterns: [
       'https?:\\/\\/(?:[^\\s]+\\.)?(?:free-gift|win-big|click-here)[^\\s]*'
     ],
     requiresContext: false
   }
 };
const DEFAULT_RULE_PATH = '/rulepacks/default.json'; // looks in /public
let   instance   = null;   // the singleton
let   activePath = null;   // where the current rules came from

// -- 1. Load JSON  ------------------------------------------
async function loadJson(path) {
  // Browser / Vite dev server / production
  if (typeof fetch === 'function') {
    // Add ?t=TIMESTAMP so CTRL+S triggers a fresh request even with the same path
    const url = `${path}${path.includes('?') ? '&' : '?'}t=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' }).catch(() => null);
    if (res && res.ok) return res.json();
    console.warn(`[ContentSafety] Fetch failed for ${path}, falling back to bundle`);
    return null;
  }


}

// -- 2. Build (or return) the singleton --------------------------------------
export async function getContentSafety(opts = {}) {
  if (instance) return instance;

  const path =
    opts.rulePackPath ||
    (typeof localStorage !== 'undefined' && localStorage.getItem('rulePackPath')) ||
    DEFAULT_RULE_PATH;

  const json = await loadJson(path);
  const customPatterns = json ?? bundledDefaultPack;

  instance   = new ContentSafetySystem({ customPatterns });
  activePath = json ? path : '(embedded default)';

  console.info(`[ContentSafety] Initialised with rules from ${activePath}`);
  return instance;
}

// -- 3. Helpers for pointing to a different local pack -----------------------
export async function setRulePackPath(path) {
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('rulePackPath', path);
  }
  await reloadRulePack(path);
}

export function getCurrentRulePackPath() {
  return activePath;
}

/** Re-reads the file from disk/server and swaps the patterns in-place. */
export async function reloadRulePack(path = activePath || DEFAULT_RULE_PATH) {
  if (!instance) throw new Error('ContentSafetySystem not initialised yet');

  const json = await loadJson(path);
  if (!json) throw new Error(`Could not load rule pack at ${path}`);

  instance.importConfig({
    version: '2.0.0',
    config : { customPatterns: json }
  });

  activePath = path;
  console.info(`[ContentSafety] Rule pack reloaded from ${path}`);
}
