// ==UserScript==
// @name         WGVIP
// @namespace    https://github.com/Danz-Pro/WGVIP
// @version      1.0
// @description  Wayground Request Interceptor — Jawaban selalu benar ke server
// @author       Danz-Pro
// @match        https://wayground.com/*
// @match        https://quizizz.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
  // Load the bundle — intercepts fetch and modifies proceed requests
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/gh/Danz-Pro/WGVIP@main/dist/bundle.js';
  script.onload = () => console.log('[WGVIP] v1.0 Script loaded');
  script.onerror = () => console.error('[WGVIP] Failed to load script');
  document.head.appendChild(script);
})();
