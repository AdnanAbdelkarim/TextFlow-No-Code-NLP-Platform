/**
 * Centralized state management.
 *
 * Replaces:
 *   - 4 separate sessionStorage restore blocks (Chunks 5, 8, 9 inline)
 *   - The Object.defineProperty trace setter (Chunk 8 — production bug)
 *   - Scattered sessionStorage.removeItem calls (6+ in fileHandler)
 *
 * Exposes on window:
 *   restoreSessionData()
 *   clearLabeledSessionData()
 *   getRowsForCharts()
 *   checkIfDataHasLabels()
 *   getActiveClassFromTab(tabSelector)
 *   setLastCSVData(data, persist)
 */
(function () {
    'use strict';
  
    // ============================================================
    // SESSION DATA RESTORATION
    // ============================================================
  
    /**
     * Restore window.lastCSVData from sessionStorage if not already loaded.
     * Idempotent — safe to call multiple times.
     * Returns true if data is now available, false otherwise.
     *
     * Replaces 4 separate restore blocks in:
     *   - script.js visualizations DOMContentLoaded (Chunk 5)
     *   - script.js advanced DOMContentLoaded (Chunk 5)
     *   - visualizations.html inline (Chunk 8)
     *   - visualizations.html initializeCSVData (Chunk 8)
     *
     * @returns {boolean} true if window.lastCSVData is now populated
     */
    function restoreSessionData() {
      if (Array.isArray(window.lastCSVData) && window.lastCSVData.length > 0) {
        return true;
      }
  
      const stored = sessionStorage.getItem('lastCSVData');
      if (!stored) return false;
  
      try {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          window.lastCSVData = parsed;
          return true;
        }
      } catch (e) {
        console.error('restoreSessionData: failed to parse lastCSVData', e);
      }
      return false;
    }
  
    window.restoreSessionData = restoreSessionData;
  
    // ============================================================
    // SESSION CLEANUP
    // ============================================================
  
    // Keys related to a labeled CSV upload that should be cleared
    // when starting fresh (new upload, mode change, etc.)
    const LABELED_SESSION_KEYS = [
      'uploadedCSV',
      'labeledData',
      'isLabeled',
      'textData',
      'preprocessingComplete',
      'labelColumns',
      'labelColumnCount',
      'lastCSVData',
      'lastCSVTextRows',
      'uniqueLabels',
      'detectedTextCol',
      'detectedLabelCol',
      'preprocessingSettings',
      'preprocessingApplied',
      'preprocessingInfo',
      'preprocessedData'
    ];
  
    /**
     * Clear all session storage related to labeled data uploads.
     * Replaces 12+ removeItem calls scattered across the file upload handler.
     */
    function clearLabeledSessionData() {
      for (let i = 0; i < LABELED_SESSION_KEYS.length; i++) {
        sessionStorage.removeItem(LABELED_SESSION_KEYS[i]);
      }
      // Also reset the in-memory copy (no Object.defineProperty hack)
      window.lastCSVData = null;
    }
  
    window.clearLabeledSessionData = clearLabeledSessionData;
  
    // ============================================================
    // PERSISTENT WRITE
    // ============================================================
  
    /**
     * Set window.lastCSVData and optionally persist to sessionStorage.
     * Centralizes the dual-write pattern (memory + sessionStorage)
     * that was scattered across upload handlers.
     *
     * @param {Array} data
     * @param {boolean} [persist=true]
     */
    function setLastCSVData(data, persist) {
      window.lastCSVData = data;
      if (persist !== false && Array.isArray(data)) {
        try {
          sessionStorage.setItem('lastCSVData', JSON.stringify(data));
        } catch (e) {
          console.warn('setLastCSVData: failed to persist to sessionStorage', e);
        }
      }
    }
  
    window.setLastCSVData = setLastCSVData;
  
    // ============================================================
    // ROWS FOR CHARTS (moved from inline HTML)
    // ============================================================
  
    /**
     * Get the appropriate rows array for chart generation.
     * Source priority:
     *   1. window.lastCSVData (labeled CSV path)
     *   2. sessionStorage textData (unlabeled path)
     *   3. empty array
     *
     * Moved from visualizations.html inline (Chunk 8) to fix the
     * load-order coupling that made it inaccessible from script.js.
     *
     * Uses extractText() from utils.js for consistent text extraction.
     *
     * @returns {string[]}
     */
    function getRowsForCharts() {
      if (Array.isArray(window.lastCSVData) && window.lastCSVData.length > 0) {
        const out = [];
        for (let i = 0; i < window.lastCSVData.length; i++) {
          const text = window.extractText
            ? window.extractText(window.lastCSVData[i])
            : (window.lastCSVData[i].text || '');
          if (text && text.trim()) out.push(text);
        }
        return out;
      }
  
      try {
        const raw = JSON.parse(sessionStorage.getItem('textData') || '{}');
        const big = (raw && raw.text) ? String(raw.text) : '';
        if (!big) return [];
  
        // Split on blank lines OR sentence boundaries
        return big
          .split(/\n{2,}|[.!?]\s+/)
          .map(function (s) { return s.trim(); })
          .filter(Boolean);
      } catch (_) {
        return [];
      }
    }
  
    window.getRowsForCharts = getRowsForCharts;
  
    // ============================================================
    // LABEL DETECTION
    // ============================================================
  
    /**
     * Determine whether the current dataset has class labels.
     * Replaces the broken Chunk 8 version that referenced
     * window.uploadedText (never defined on window) and window.words
     * (never defined anywhere).
     *
     * @returns {boolean}
     */
    function checkIfDataHasLabels() {
      const data = window.lastCSVData;
      if (!Array.isArray(data) || data.length === 0) return false;
  
      // At least one row must have a label or class field
      const firstRow = data[0];
      const hasLabelField = ('label' in firstRow) || ('class' in firstRow) ||
                           (Array.isArray(firstRow.labelNames) && firstRow.labelNames.length > 0);
      if (!hasLabelField) return false;
  
      // Use getUniqueLabels for consistent extraction
      const labels = window.getUniqueLabels
        ? window.getUniqueLabels(data)
        : Array.from(new Set(data.map(function (r) {
            return String(r.label !== undefined ? r.label : r.class);
          }).filter(function (l) { return l && l !== 'Unlabeled' && l !== '-1'; })));
  
      // Real labels: at least 2 distinct, non-trivial values
      return labels.length >= 2;
    }
  
    window.checkIfDataHasLabels = checkIfDataHasLabels;
  
    // ============================================================
    // ACTIVE CLASS RESOLUTION
    // ============================================================
  
    /**
     * Get the currently active class from a tab container's selector.
     * Falls back to 'all' if no active tab found.
     *
     * @param {string} tabContainerSelector  e.g. '#wordCloud .class-tab.active'
     * @returns {string}
     */
    function getActiveClassFromTab(tabContainerSelector) {
      const activeTab = document.querySelector(tabContainerSelector);
      return (activeTab && activeTab.dataset && activeTab.dataset.class) || 'all';
    }
  
    window.getActiveClassFromTab = getActiveClassFromTab;
  })();