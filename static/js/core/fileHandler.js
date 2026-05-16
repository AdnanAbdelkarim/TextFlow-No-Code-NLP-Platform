/**
 * File upload handler module.
 *
 * Wires up file input + URL fetch on the input page (index.html).
 * Handles TXT/CSV/XLSX/PDF/DOCX uploads + URL-based file fetching.
 * Detects labeled vs unlabeled, multi-label binary vs single-label formats.
 *
 * Public API:
 *   initializeFileHandler() - call from input page DOMContentLoaded
 */
(function () {
    'use strict';
  
    /**
     * Initialize file upload + URL fetch handlers.
     * Idempotent — safe to call multiple times.
     */
    function initializeFileHandler() {
      const fileInput = document.getElementById('fileInput');
      const textArea = document.getElementById('textInput');
      const analyzeBtn = document.getElementById('analyzeButton') || document.getElementById('analyzeBtn');
      const wordCountDisplay = document.getElementById('liveWordCount');
      const fetchFromUrlBtn = document.getElementById('fetchFromUrlBtn');
      const fileUrlInput = document.getElementById('fileUrlInput');
  
      // Local helper: word count update with closure over textArea/wordCountDisplay
      function updateLocalWordCount() {
        if (!textArea || !wordCountDisplay) return;
        const text = textArea.value.trim();
        const wordCount = text ? text.split(/\s+/).length : 0;
        wordCountDisplay.textContent = `Words: ${wordCount} / 1,000,000`;
      }
  
      // ---- File input change ----
      if (fileInput && textArea) {
        fileInput.addEventListener('change', _handleFileChange);
      }
  
      // ---- Analyze button ----
      if (analyzeBtn && textArea) {
        analyzeBtn.addEventListener('click', () => {
          const userText = textArea.value.trim();
          if (!userText) {
            alert('Please enter or upload text before analyzing.');
            return;
          }
          sessionStorage.setItem('textData', JSON.stringify({ text: userText }));
          window.location.href = '/overview';
        });
      }
  
      // ---- Live word count ----
      if (textArea && wordCountDisplay) {
        textArea.addEventListener('input', updateLocalWordCount);
      }
  
      // ---- Fetch from URL ----
      if (fetchFromUrlBtn && fileUrlInput) {
        fetchFromUrlBtn.addEventListener('click', async () => {
          const url = fileUrlInput.value.trim();
          if (!url) {
            alert('Please enter a valid URL.');
            return;
          }
          const ext = url.split('.').pop().toLowerCase();
          try {
            const response = await fetch(url);
            if (!response.ok) throw new Error('Network response was not ok');
  
            if (ext === 'txt') {
              const text = await response.text();
              textArea.value = text;
              sessionStorage.setItem('textData', JSON.stringify({ text }));
              _clearLabeledKeys();
              sessionStorage.setItem('mode', 'unlabeled');
              updateLocalWordCount();
            } else if (ext === 'docx') {
              const arrayBuffer = await response.arrayBuffer();
              const doc = await window.docx.parseDocx(arrayBuffer);
              const text = (doc.children || [])
                .map(p => (p.children || []).map(run => run.text).join(''))
                .join('\n');
              textArea.value = text;
              sessionStorage.setItem('textData', JSON.stringify({ text }));
              _clearLabeledKeys();
              sessionStorage.setItem('mode', 'unlabeled');
              updateLocalWordCount();
            } else {
              alert('Unsupported file format. Only .txt or .docx URLs are allowed.');
            }
          } catch (err) {
            console.error('Error fetching file:', err);
            alert('Failed to fetch and read the file. Check the URL or file type.');
          }
        });
      }
  
      // Inner handler for fileInput change
      function _handleFileChange(event) {
        // Reset state for new upload
        window.lastCSVData = null;
  
        // Invalidate ALL session caches — new file means all computed data is stale
        if (window.sessionCache) {
          window.sessionCache.clear();
        }
  
        // Clear all labeled session data centrally
        if (typeof window.clearLabeledSessionData === 'function') {
          window.clearLabeledSessionData();
        } else {
          _clearLabeledKeys();
          sessionStorage.removeItem('preprocessingSettings');
          sessionStorage.removeItem('preprocessingApplied');
          sessionStorage.removeItem('preprocessingInfo');
          sessionStorage.removeItem('preprocessedData');
        }
  
        // Notify backend to clear preprocessing
        fetch('/api/clear_preprocessing', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }).catch(() => {});
  
        // Clear advanced page result panels
        ['nerResults', 'sentimentResults', 'topicModelingResults', 'classificationResults']
          .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
          });
  
        const file = event.target.files[0];
        if (!file) return;
  
        const maxSize = 500 * 1024 * 1024; // 500 MB
        if (file.size > maxSize) {
          alert('❌ File is too large. Please upload a file under 100 MB.');
          event.target.value = '';
          return;
        }
  
        const ext = file.name.split('.').pop().toLowerCase();
  
        if (ext === 'txt')      _handleTXT(file, textArea, updateLocalWordCount);
        else if (ext === 'docx') _handleDOCX(file, textArea, updateLocalWordCount);
        else if (ext === 'pdf')  _handlePDF(file, textArea, updateLocalWordCount);
        else if (ext === 'csv')  _handleCSV(file);
        else if (ext === 'xlsx') _handleXLSX(file, textArea, updateLocalWordCount);
        else alert('Unsupported file format. Please upload a .txt, .docx, .pdf, .csv, or .xlsx file.');
      }
    }
  
    // ============================================================
    // INTERNAL: per-format handlers
    // ============================================================
  
    function _handleTXT(file, textArea, updateLocalWordCount) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const text = e.target.result.trim();
        const lines = text.split('\n').filter(line => line.trim());
        if (lines.length === 0) {
          alert('❌ File is empty.');
          return;
        }
  
        // Detect labeled multi-binary format
        const detection = _detectMultiLabelTXT(lines);
  
        if (detection.isLabeled && detection.parsedData) {
          _processLabeledTXT(detection);
        } else {
          // Unlabeled
          textArea.value = text;
          sessionStorage.setItem('textData', JSON.stringify({ text }));
          _clearLabeledKeys();
          sessionStorage.setItem('mode', 'unlabeled');
          updateLocalWordCount();
        }
      };
      reader.readAsText(file);
    }
  
    function _detectMultiLabelTXT(lines) {
      const firstLine = lines[0];
      const tabParts   = firstLine.split('\t');
      const commaParts = firstLine.split(',');
  
      let separator = null;
      let parts = null;
  
      if (tabParts.length > 1) { separator = '\t'; parts = tabParts; }
      else if (commaParts.length > 1) { separator = ','; parts = commaParts; }
  
      if (!separator || !parts) return { isLabeled: false };
  
      let labelColumnCount = 0;
      let labelColumns = [];
  
      for (let i = 0; i < parts.length - 1; i++) {
        const cleanVal = parts[i].trim().replace(/^["']|["']$/g, '');
        const isBinaryValue = cleanVal === '0' || cleanVal === '1';
        const looksLikeLabelName = !isBinaryValue && cleanVal.length < 20 && !cleanVal.includes(' ');
  
        if (isBinaryValue || looksLikeLabelName) {
          labelColumnCount++;
          labelColumns.push(cleanVal);
        } else {
          break;
        }
      }
  
      const secondLine = lines.length > 1 ? lines[1] : null;
      let hasHeader = false;
      if (secondLine && labelColumnCount > 0) {
        const secondParts = secondLine.split(separator);
        const firstColSecondRow = secondParts[0]?.trim().replace(/^["']|["']$/g, '');
        if (labelColumns.every(v => v !== '0' && v !== '1') &&
            (firstColSecondRow === '0' || firstColSecondRow === '1')) {
          hasHeader = true;
        }
      }
  
      const lastColumn = parts[parts.length - 1].trim();
      const hasTextColumn = lastColumn.length > 20 || lastColumn.startsWith('"');
  
      if (labelColumnCount < 1 || !hasTextColumn) return { isLabeled: false };
  
      const startIdx = hasHeader ? 1 : 0;
      if (!hasHeader) {
        labelColumns = Array.from({ length: labelColumnCount }, (_, i) => `label${i}`);
      }
  
      const parsedData = [];
      lines.slice(startIdx).forEach(line => {
        const columns = line.split(separator);
        const labels = columns.slice(0, labelColumnCount).map(l => l.trim().replace(/^["']|["']$/g, ''));
        let textContent = columns.slice(labelColumnCount).join(separator).trim();
        textContent = textContent.replace(/^["']|["']$/g, '');
  
        if (!textContent || textContent.length === 0) return;
  
        const activeLabels = [];
        labels.forEach((val, idx) => {
          if (val === '1') activeLabels.push(idx);
        });
  
        if (activeLabels.length === 0) {
          parsedData.push({
            label: '-1', text: textContent,
            originalLabels: labels, activeIndices: [],
            labelNames: [], isMultiLabel: false
          });
          return;
        }
  
        activeLabels.forEach(idx => {
          parsedData.push({
            label: idx.toString(), text: textContent,
            originalLabels: labels, activeIndices: [idx],
            labelNames: [labelColumns[idx]],
            isMultiLabel: activeLabels.length > 1
          });
        });
      });
  
      if (parsedData.length === 0) return { isLabeled: false };
  
      return {
        isLabeled: true,
        parsedData, labelColumns, labelColumnCount, separator, hasHeader
      };
    }
  
    function _processLabeledTXT(detection) {
      const { parsedData, labelColumns, labelColumnCount } = detection;
  
      sessionStorage.setItem('labelColumns', JSON.stringify(labelColumns));
      sessionStorage.setItem('labelColumnCount', labelColumnCount.toString());
  
      const csvHeader = labelColumns.join(',') + ',text\n';
      const csvRows = parsedData.map(row => {
        const labelCols = row.originalLabels.map(l => `"${l}"`).join(',');
        const textCol = `"${row.text.replace(/"/g, '""')}"`;
        return `${labelCols},${textCol}`;
      });
      sessionStorage.setItem('uploadedCSV', csvHeader + csvRows.join('\n'));
  
      const labeledData = parsedData.map(row => {
        const labelDisplay = row.labelNames.length > 0 ? row.labelNames.join('+') : row.label;
        return `[${labelDisplay}] ${row.text}`;
      });
      sessionStorage.setItem('textData', JSON.stringify({ text: labeledData.join('\n') }));
      sessionStorage.setItem('detectedTextCol', 'text');
      sessionStorage.setItem('detectedLabelCol', labelColumns[0]);
  
      const rowsText = parsedData.map(row => row.text);
      sessionStorage.setItem('lastCSVTextRows', JSON.stringify(rowsText));
  
      // Group by text content to combine labels
      const textToLabels = {};
      parsedData.forEach(row => {
        const text = row.text;
        if (!textToLabels[text]) {
          textToLabels[text] = {
            text, labelNames: new Set(),
            originalLabels: row.originalLabels, activeIndices: new Set()
          };
        }
        row.activeIndices.forEach(idx => {
          textToLabels[text].labelNames.add(labelColumns[idx]);
          textToLabels[text].activeIndices.add(idx);
        });
      });
  
      const processedData = [];
      Object.values(textToLabels).forEach(item => {
        if (item.activeIndices.size > 0) {
          const allLabels = Array.from(item.activeIndices).map(idx => labelColumns[idx]);
          processedData.push({
            label: Array.from(item.activeIndices)[0].toString(),
            text: item.text,
            labelNames: Array.from(item.labelNames),
            originalLabels: item.originalLabels,
            activeIndices: Array.from(item.activeIndices),
            isMultiLabel: item.activeIndices.size > 1,
            allLabels,
            allLabelIndices: Array.from(item.activeIndices)
          });
        }
      });
  
      if (typeof window.setLastCSVData === 'function') {
        window.setLastCSVData(processedData, true);
      } else {
        window.lastCSVData = processedData;
        sessionStorage.setItem('lastCSVData', JSON.stringify(processedData));
      }
  
      const allUniqueLabels = labelColumns.filter((_, index) =>
        processedData.some(row => row.activeIndices.includes(index))
      );
      sessionStorage.setItem('uniqueLabels', JSON.stringify(allUniqueLabels));
  
      window.location.href = '/overview';
    }
  
    function _handleDOCX(file, textArea, updateLocalWordCount) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const arrayBuffer = e.target.result;
        mammoth.extractRawText({ arrayBuffer }).then(result => {
          const text = result.value.trim();
          textArea.value = text;
          sessionStorage.setItem('textData', JSON.stringify({ text }));
          _clearLabeledKeys();
          sessionStorage.setItem('mode', 'unlabeled');
          updateLocalWordCount();
        }).catch(err => {
          alert('Failed to extract text from DOCX.');
          console.error(err);
        });
      };
      reader.readAsArrayBuffer(file);
    }
  
    function _handlePDF(file, textArea, updateLocalWordCount) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const typedarray = new Uint8Array(e.target.result);
        pdfjsLib.getDocument({ data: typedarray }).promise.then(pdf => {
          const textPromises = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            textPromises.push(
              pdf.getPage(i).then(page =>
                page.getTextContent().then(tc =>
                  tc.items.map(item => item.str).join(' ')
                )
              )
            );
          }
          Promise.all(textPromises).then(texts => {
            const text = texts.join('\n\n');
            textArea.value = text;
            sessionStorage.setItem('textData', JSON.stringify({ text }));
            _clearLabeledKeys();
            sessionStorage.setItem('mode', 'unlabeled');
            updateLocalWordCount();
          });
        }).catch(err => alert('Error reading PDF: ' + err.message));
      };
      reader.readAsArrayBuffer(file);
    }
  
    function _handleCSV(file) {
      file.text().then(csvText => {
        sessionStorage.setItem('uploadedCSV', csvText);
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: function (results) {
            const data = results.data;
            if (!data.length) {
              alert('CSV is empty or invalid.');
              return;
            }
  
            // Normalize column names (trim whitespace)
            data.forEach(row => {
              Object.keys(row).forEach(key => {
                const cleanKey = key.trim();
                if (cleanKey !== key) {
                  row[cleanKey] = row[key];
                  delete row[key];
                }
              });
            });
  
            const allColumns = Object.keys(data[0]);
  
            // Detect multi-label binary format
            let labelColumnCount = 0;
            for (let i = 0; i < allColumns.length - 1; i++) {
              const col = allColumns[i];
              const values = data.map(row => row[col]).filter(Boolean);
              const isBinary = values.every(v => v === '0' || v === '1' || v === 0 || v === 1);
              if (isBinary) labelColumnCount++;
              else break;
            }
  
            if (labelColumnCount > 0) {
              _processMultiLabelCSV(data, allColumns, labelColumnCount);
            } else {
              _processSingleLabelCSV(data, allColumns);
            }
          }
        });
      });
    }
  
    function _processMultiLabelCSV(data, allColumns, labelColumnCount) {
      const textCol = allColumns[allColumns.length - 1];
      const labelColumns = allColumns.slice(0, labelColumnCount);
  
      sessionStorage.setItem('labelColumns', JSON.stringify(labelColumns));
      sessionStorage.setItem('labelColumnCount', labelColumnCount.toString());
  
      const processedData = [];
      data.forEach(row => {
        const text = row[textCol]?.toString().trim();
        if (!text) return;
  
        const activeLabels = labelColumns.filter(col => {
          const val = row[col];
          return val === '1' || val === 1;
        });
  
        if (activeLabels.length === 0) {
          processedData.push({
            label: '-1', text,
            originalLabels: labelColumns.map(col => row[col]),
            labelNames: []
          });
          return;
        }
  
        activeLabels.forEach(labelName => {
          const labelIndex = labelColumns.indexOf(labelName);
          processedData.push({
            label: labelIndex.toString(), text,
            originalLabels: labelColumns.map(col => row[col]),
            labelNames: [labelName],
            isMultiLabel: activeLabels.length > 1
          });
        });
      });
  
      if (typeof window.setLastCSVData === 'function') {
        window.setLastCSVData(processedData, true);
      } else {
        window.lastCSVData = processedData;
        sessionStorage.setItem('lastCSVData', JSON.stringify(processedData));
      }
  
      const allUniqueLabels = [...new Set(processedData.map(row => row.label))]
        .filter(l => l !== '-1').sort();
      sessionStorage.setItem('uniqueLabels', JSON.stringify(allUniqueLabels));
  
      const labeledData = processedData.map(row => {
        const labelDisplay = row.labelNames.length > 0 ? row.labelNames.join('+') : row.label;
        return `[${labelDisplay}] ${row.text}`;
      });
      sessionStorage.setItem('textData', JSON.stringify({ text: labeledData.join('\n') }));
      sessionStorage.setItem('detectedTextCol', textCol);
      sessionStorage.setItem('detectedLabelCol', labelColumns[0]);
  
      const rowsText = processedData.map(row => row.text);
      sessionStorage.setItem('lastCSVTextRows', JSON.stringify(rowsText));
  
      window.location.href = '/overview';
    }
  
    function _processSingleLabelCSV(data, allColumns) {
      let textCol = null;
      let labelCol = null;
  
      for (let i = 0; i < allColumns.length; i++) {
        const col = allColumns[i];
        const values = data.map(row => row[col]);
        const unique = [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
        const isText = values.some(v => typeof v === 'string' && v.length > 20);
        const isLabel = unique.length > 0 && unique.every(v =>
          !isNaN(v) || ['spam', 'ham', 'not spam'].includes(v.toLowerCase())
        );
        if (!textCol && isText) textCol = col;
        if (!labelCol && isLabel) labelCol = col;
      }
  
      if (!textCol || !labelCol) {
        alert('Could not auto-detect text and label columns.');
        return;
      }
  
      const labelMap = {};
      let labelIndex = 0;
  
      const singleLabelData = data.map(row => {
        const rawLabel = row[labelCol]?.toString().trim();
        const text = row[textCol]?.toString().trim();
        if (!rawLabel || !text) return null;
        const label = !isNaN(rawLabel) ? rawLabel : (
          labelMap[rawLabel] ?? (labelMap[rawLabel] = labelIndex++)
        );
        return { label: String(label), text };
      }).filter(Boolean);
  
      if (typeof window.setLastCSVData === 'function') {
        window.setLastCSVData(singleLabelData, true);
      } else {
        window.lastCSVData = singleLabelData;
        sessionStorage.setItem('lastCSVData', JSON.stringify(singleLabelData));
      }
  
      const labeledData = singleLabelData.map(row => `[${row.label}] ${row.text}`);
      sessionStorage.setItem('textData', JSON.stringify({ text: labeledData.join('\n') }));
      sessionStorage.setItem('detectedTextCol', textCol);
      sessionStorage.setItem('detectedLabelCol', labelCol);
  
      const rowsText = singleLabelData.map(row => row.text);
      sessionStorage.setItem('lastCSVTextRows', JSON.stringify(rowsText));
  
      window.location.href = '/overview';
    }
  
    function _handleXLSX(file, textArea, updateLocalWordCount) {
      const reader = new FileReader();
      reader.onload = function (e) {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const parsed = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  
        const labeledData = parsed
          .filter((row, i) => i > 0 && row[0] && row[1] !== undefined)
          .map(row => ({ text: row[0].toString().trim(), label: row[1].toString().trim() }));
  
        const displayText = labeledData.map(entry => `[${entry.label}] ${entry.text}`).join('\n');
        textArea.value = displayText;
        sessionStorage.setItem('textData', JSON.stringify({ text: displayText }));
        sessionStorage.setItem('isLabeled', 'true');
        updateLocalWordCount();
      };
      reader.readAsArrayBuffer(file);
    }
  
    // ============================================================
    // INTERNAL: session key cleanup
    // ============================================================
  
    function _clearLabeledKeys() {
      [
        'detectedTextCol', 'detectedLabelCol', 'lastCSVTextRows',
        'labelColumns', 'labelColumnCount', 'isLabeled'
      ].forEach(key => sessionStorage.removeItem(key));
    }
  
    // Expose public API
    window.initializeFileHandler = initializeFileHandler;
  })();