/**
 * Overview page initializer.
 * Computes basic stats (total words, unique words, vocab diversity)
 * from the labeled or unlabeled text data and displays them.
 */
(function () {
    'use strict';
  
    function initializeOverviewPage() {
      const saved = sessionStorage.getItem('textData');
      if (!saved) return;
  
      let parsed;
      try { parsed = JSON.parse(saved); } catch (_) { return; }
      const text = parsed.text || '';
      if (!text) return;
  
      // Strip [label] prefixes if labeled
      const lines = text.trim().split(/\n/).filter(Boolean);
      const isLabeled = /^\[([^\]]+)\]/.test(lines[0] || '');
  
      let cleanText = text;
      if (isLabeled) {
        cleanText = lines.map(line => {
          const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
          return match ? match[2] : line;
        }).join(' ');
      }
  
      const words = cleanText.trim().split(/\s+/).filter(Boolean);
      const totalWords = words.length;
      const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
  
      // Update DOM (defensive — elements may not all exist)
      const totalEl    = document.getElementById('totalWords');
      const uniqueEl   = document.getElementById('uniqueWords');
      const sentimentEl = document.getElementById('sentimentScore');
      const vocabEl    = document.getElementById('vocabStats');
  
      if (totalEl)  totalEl.textContent = totalWords;
      if (uniqueEl) uniqueEl.textContent = uniqueWords;
  
      if (sentimentEl) {
        const sentimentScore = Math.min(1, Math.max(0, (uniqueWords / totalWords).toFixed(2)));
        let sentimentLabel = 'Neutral';
        if (sentimentScore > 0.65) sentimentLabel = 'Positive';
        else if (sentimentScore < 0.35) sentimentLabel = 'Negative';
        sentimentEl.textContent = `${sentimentScore} (${sentimentLabel})`;
      }
  
      if (vocabEl) {
        const vocabScore = (uniqueWords / Math.sqrt(totalWords)).toFixed(2);
        let vocabLabel = 'Moderate';
        if (vocabScore > 0.7) vocabLabel = 'Diverse';
        else if (vocabScore < 0.4) vocabLabel = 'Limited';
        vocabEl.textContent = `${vocabScore} (${vocabLabel})`;
      }
    }
  
    window.initializeOverviewPage = initializeOverviewPage;
  })();