// ---- server helpers ----
// === API helpers (Safari-safe) ===
let wordCloudCache = new Map();
let currentCacheKey = null;
// === Page feature flags & safe no-ops ===
const HAS_FILE_INPUT = !!document.getElementById('fileInput');

// Some pages (Advanced) don’t define rerender. Make it a no-op there.
if (typeof window.rerender !== 'function') {
  window.rerender = function noopRerender() {};
}

window.addEventListener('DOMContentLoaded', () => {
  const plugin = window['chartjs-plugin-annotation'] || window.ChartAnnotation;
  if (window.Chart && plugin) Chart.register(plugin);
});

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  const raw = await r.text(); // read as text first (handles HTML error pages)
  let data = {};
  try {
    if ((r.headers.get('content-type') || '').includes('application/json')) {
      data = JSON.parse(raw);
    } else {
      data = JSON.parse(raw); // will throw if non-JSON; caught below
    }
  } catch (_) { /* keep data = {} and surface raw snippet on error */ }

  if (!r.ok) {
    const snippet = (data.detail || data.error || raw || '').slice(0, 300);
    throw new Error(`${url} ${r.status}: ${snippet}`);
  }
  return data;
}

// --- ADD ONCE (anywhere in script.js, e.g., near other helpers) ---
function normalizeUnlabeledDocs(text) {
  return [{ id: "doc-0", text: String(text ?? "").trim() }];
}
function enterUnlabeledMode(state) {
  // Prevent accidental CSV branch
  state.detectedTextCol = null;
  state.detectedLabelCol = null;
  state.lastCSVTextRows = [];
  state.mode = "unlabeled";
}
/*
// --- CALL THIS in your DOCX/PDF handler right after extraction ---
async function handleUnlabeledTextExtracted(extractedText) {
  enterUnlabeledMode(state);

  const docs = normalizeUnlabeledDocs(extractedText);

  const payload = {
    mode: "unlabeled",
    docs // [{id, text}]  <-- consistent shape for backend/visuals
  };

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  renderResults(data); // <- your existing renderer (no change needed)
}*/


// Add near the top of script.js (once)
const NER_LABEL_NAMES = {
  PERSON: "Person",
  ORG: "Organization",
  GPE: "Country/City/State",
  LOC: "Location",
  NORP: "Nationality/Religious/Political group",
  PRODUCT: "Product",
  EVENT: "Event",
  WORK_OF_ART: "Work of Art",
  LAW: "Law",
  LANGUAGE: "Language",
  DATE: "Date",
  TIME: "Time",
  MONEY: "Money",
  QUANTITY: "Quantity",
  PERCENT: "Percent",
  CARDINAL: "Cardinal number",
  ORDINAL: "Ordinal number",
  FAC: "Facility"
};

const API_BASE = (typeof window.API_BASE === 'string' && window.API_BASE.trim())
  ? window.API_BASE
  : window.location.origin;

const api = (p) => new URL(p, API_BASE).toString();

async function getJSON(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0,200)}`);
  }
  const ct = r.headers.get('content-type') || '';
  const text = await r.text();
  if (!ct.includes('application/json')) {
    throw new Error(`Expected JSON, got ${ct || 'unknown'}: ${text.slice(0,200)}`);
  }
  return JSON.parse(text);
}


let coverageCtrl = null;

function isAbort(err) {
  return err && (err.name === "AbortError" || /aborted/i.test(String(err)));
}

async function postJSON(url, payload, opts = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: opts.signal || undefined   // ← pass AbortController signal if provided
  });
  if (!res.ok) throw new Error(await res.text().catch(() => res.status));
  return res.json();
}


// build a lighter payload: trim each row + cap rows
function slimRows(rows, maxRows = 2000, maxChars = 2000) {
  return (rows || [])
    .slice(0, maxRows)
    .map(t => (t || "").toString().slice(0, maxChars));
}

// Add scrolled class when page is scrolled
window.addEventListener('scroll', function() {
  const stickyHeader = document.querySelector('.sticky-header, .sticky-top-section');
  if (stickyHeader) {
    if (window.scrollY > 10) {
      stickyHeader.classList.add('scrolled');
    } else {
      stickyHeader.classList.remove('scrolled');
    }
  }
});
// Utility function to create tabs for class-specific plots
function createClassTabs(classes, onClick, type = 'network', activeClass = null) {
  let containerSelector;
  switch(type) {
    case 'network':
      containerSelector = "#networkContainer .network-flex";
      break;
    case 'coverage':
      containerSelector = "#frequencyChart .coverage-flex";
      break;
    case 'zipf':
      containerSelector = "#zipfPlot .zipf-flex";
      break;
    case 'wordcloud':
      containerSelector = "#wordCloud .wordcloud-tabs";
      break;
    default:
      console.error("Unknown visualization type:", type);
      return null;
  }

  const container = document.querySelector(containerSelector);
  if (!container) {
    console.warn(`⚠️ No container found for ${type}`);
    return null;
  }

  // Remove old tabs
  const oldTabs = container.querySelector(".class-tabs");
  if (oldTabs) oldTabs.remove();
  const oldContent = container.querySelector(".class-tabs-content");
  if (oldContent) oldContent.remove();

  // Sort classes
  const sortedClasses = [...classes].sort((a, b) => {
    if (!isNaN(a) && !isNaN(b)) return Number(a) - Number(b);
    return String(a).localeCompare(String(b));
  });

  const tabContainer = document.createElement("div");
  tabContainer.classList.add("class-tabs");

  // ✅ ADD "All Data" tab for ALL visualization types
  const allDataBtn = document.createElement("button");
  allDataBtn.className = "class-tab";
  allDataBtn.dataset.class = "all";
  allDataBtn.textContent = "All Data";
  
  // Set active if it's the activeClass or if no activeClass specified
  if (activeClass === "all" || (!activeClass)) {
    allDataBtn.classList.add("active");
  }
  
  tabContainer.appendChild(allDataBtn);

  // Create class tabs
  sortedClasses.forEach((className, index) => {
    const btn = document.createElement("button");
    btn.className = "class-tab";
    btn.dataset.class = className;
    btn.textContent = `Class ${className}`;

    // Set active state - only if it matches activeClass
    if (String(className) === String(activeClass)) {
      btn.classList.add("active");
      // If a class is active, remove active from "All Data"
      allDataBtn.classList.remove("active");
    }

    tabContainer.appendChild(btn);
  });

  // Create content container
  const contentContainer = document.createElement("div");
  contentContainer.classList.add("class-tabs-content");
  container.appendChild(tabContainer);

  if (type === 'wordcloud') {
    const flexContainer = document.querySelector("#wordCloud .wordcloud-flex");
    if (flexContainer) {
      flexContainer.appendChild(contentContainer);
    }
  } else {
    container.appendChild(contentContainer);
  }

  // Add click listeners
  tabContainer.addEventListener("click", (e) => {
    if (!e.target.matches(".class-tab")) return;
    tabContainer.querySelectorAll(".class-tab").forEach(tab => tab.classList.remove("active"));
    e.target.classList.add("active");
    onClick(e.target.dataset.class);
  });

  console.log(`✅ ${type} tabs created with active class:`, activeClass);
  return { tabContainer, contentContainer, effectiveActiveClass: activeClass };
}


let networkCtrl = null;
let lastNetworkCall = { className: null, timestamp: null, stack: null };

window.fetchAndRenderCooccurrence = async function (rows, includeStopwords, topN, minCooccurrence, className = '') {
  // Debug: Track who's calling this function
  const callStack = new Error().stack;
  const callId = Math.random().toString(36).substr(2, 9);
  const timestamp = new Date().toISOString();
  
  console.log(`🆔 [${callId}] Network call START:`, {
    className,
    timestamp,
    rowCount: rows?.length || 0,
    previousClass: lastNetworkCall.className
  });
  
  // Log the caller location for debugging
  const stackLines = callStack.split('\n');
  if (stackLines.length > 2) {
    console.log(`🆔 [${callId}] Called from:`, stackLines[2]?.trim());
  }

  // cancel any in-flight request
  if (networkCtrl) { 
    console.log(`🆔 [${callId}] Aborting previous network request`);
    try { networkCtrl.abort(); } catch {} 
  }
  networkCtrl = new AbortController();

  // trim large inputs
  rows = slimRows(rows, 2000, 2000);

  try {
    // CRITICAL: The backend expects includeStopwords=false to FILTER stopwords
    // So when checkbox is UNCHECKED (we want to hide stopwords), send false
    const payload = {
      rows,
      includeStopwords: !!includeStopwords,  // false = filter stopwords, true = show them
      topN: Number(topN) || 100,
      minCooccurrence: Number(minCooccurrence) || 2,
    };

    console.log(`🆔 [${callId}] Sending to /api/cooccurrence:`, { 
      className,
      includeStopwords: payload.includeStopwords,
      rowCount: rows.length,
      topN: payload.topN,
      minCooccurrence: payload.minCooccurrence
    });

    const res = await fetch(api("/api/cooccurrence"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: networkCtrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`/api/cooccurrence ${res.status}`);
    const net = await res.json();

    console.log(`🆔 [${callId}] Received network data:`, {
      className,
      nodes: net.nodes?.length || 0,
      links: net.links?.length || 0,
      hasResults: (net.nodes?.length || 0) > 0
    });

    // normalize link weight
    if (Array.isArray(net.links)) {
      for (const L of net.links) if (L.weight == null && L.value != null) L.weight = L.value;
    }

    // FIXED: Use class-specific state management
    const containerId = className ? `cooccurrenceNetwork-${className}` : 'cooccurrenceNetwork';
    
    // Initialize state if not exists
    if (!window.netSimState) window.netSimState = {};
    if (!window.pinnedState) window.pinnedState = {};
    
    // Clear previous state for this container
    if (window.pinnedState[containerId]) {
      window.pinnedState[containerId].clear();
    } else {
      window.pinnedState[containerId] = new Set();
    }
    
    // Stop previous simulation for this container
    if (window.netSimState[containerId] && typeof window.netSimState[containerId].stop === "function") {
      window.netSimState[containerId].stop();
    }

    // Track this call
    lastNetworkCall = {
      className,
      timestamp,
      stack: callStack
    };

    // Use the appropriate render function
    if (className) {
      console.log(`🆔 [${callId}] Rendering for class: ${className}`);
      renderKeywordNetworkForClass(net, className);
    } else {
      console.log(`🆔 [${callId}] Rendering generic network`);
      renderKeywordNetwork(net, containerId);
    }
    
  } catch (e) {
    if (e.name === "AbortError") {
      console.log(`🆔 [${callId}] Request was aborted`);
      return;
    }
    console.error(`🆔 [${callId}] Keyword network failed:`, e);
    
    const containerId = className ? `cooccurrenceNetwork-${className}` : 'cooccurrenceNetwork';
    const svg = d3.select(`#${containerId}`);
    svg.selectAll("*").remove();
    const w = 900, h = 600;
    svg.attr("viewBox", `0 0 ${w} ${h}`)
       .append("text").attr("x", w/2).attr("y", h/2)
       .attr("text-anchor", "middle").style("fill", "crimson")
       .text("❌ Failed to load keyword network (check /api/cooccurrence).");
  } finally {
    networkCtrl = null;
    console.log(`🆔 [${callId}] Network call END for class: ${className}`);
  }
};


// ✅ Cleaned and de-duplicated version of user's full-featured script.js
let uploadedText = ""; // Store uploaded text separately
let labelChartInstance = null;

window.addEventListener("DOMContentLoaded", () => {
  const csvUploaded = sessionStorage.getItem("uploadedCSV");
  const predictiveTab = document.getElementById("predictiveTab");

  if (csvUploaded && predictiveTab) {
    predictiveTab.style.display = "inline-block";
  }
});


const stopwords = new Set([
  'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
  'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
  'between', 'both', 'but', 'by', 'can', 'did', 'do', 'does', 'doing', 'down',
  'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has', 'have',
  'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
  'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me',
  'more', 'most', 'my', 'myself', 'no', 'nor', 'not', 'of', 'off', 'on', 'once',
  'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own', 'same',
  'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their', 'theirs',
  'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those', 'through',
  'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what', 'when',
  'where', 'which', 'while', 'who', 'whom', 'why', 'with', 'would', 'you', 'your',
  'yours', 'yourself', 'yourselves', 'been', 'being', 'because', 'before', 'after',
  'during', 'until', 'above', 'below', 'between', 'from', 'into', 'through', 'each',
  'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor', 'not',
  'only', 'own', 'same', 'so', 'than', 'too', 'very', 'can', 'will', 'just', 'don',
  'should', 'now'
]);


function updateLiveWordCount() {
  const textInput = document.getElementById("textInput");
  const wordCountDisplay = document.getElementById("liveWordCount");
  if (textInput && wordCountDisplay) {
    const text = textInput.value.trim() || uploadedText.trim();
    const wordCount = text ? text.split(/\s+/).length : 0;
    wordCountDisplay.textContent = `Words: ${wordCount} / 1,000,000`;
  }
}

async function getFrequencyFromServer(text, includeStopwords = false) {
  const response = await fetch('/api/word_frequency', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, includeStopwords })
  });

  if (!response.ok) {
    console.error('Failed to fetch frequency data from server.');
    return {};
  }

  return await response.json(); // { word: count, ... }
}


async function getLabelDistributionFromServer(lines) {
  const response = await fetch('/api/label_distribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines })
  });

  if (!response.ok) {
    console.error("Label distribution fetch failed.");
    return {};
  }

  return await response.json();  // { label: count, ... }
}


async function generateLabelDistribution(data) {
  const response = await fetch('/api/label_distribution', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lines: data })  // ✅ This is the key fix!
  });

  if (!response.ok) {
    console.error("Label distribution fetch failed.");
    return;
  }

  const labelCounts = await response.json();
  const labels = Object.keys(labelCounts);
  const values = labels.map(label => labelCounts[label]);

  const ctx = document.getElementById("labelChart").getContext("2d");

  // ✅ Safe destroy check before rendering new chart
  if (window.labelChart && typeof window.labelChart.destroy === "function") {
    window.labelChart.destroy();
  }

  // ✅ Render the new chart
  window.labelChart = new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [{
        label: "Samples per Label",
        data: values,
        backgroundColor: labels.map((_, i) => `hsl(${i * 40}, 70%, 60%)`)
      }]
    },
    options: {
      responsive: false,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: false }
      },
      scales: {
        x: { title: { display: true, text: "Class Label" } },
        y: { beginAtZero: true, title: { display: true, text: "Count" } }
      }
    }
  });
}

function downloadChartAsPNG(canvasId, filename) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) {
    console.error("❌ Canvas not found:", canvasId);
    alert("Chart not found. Please ensure the chart is displayed.");
    return;
  }

  try {
    // Create a temporary canvas for higher resolution
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    const scale = 2; // Higher resolution
    
    tempCanvas.width = canvas.width * scale;
    tempCanvas.height = canvas.height * scale;
    
    // Scale and draw the original canvas
    tempCtx.scale(scale, scale);
    tempCtx.drawImage(canvas, 0, 0);
    
    // Convert to PNG and download
    const link = document.createElement('a');
    link.download = filename;
    link.href = tempCanvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    console.log("✅ Chart downloaded successfully");
  } catch (error) {
    console.error("❌ Download failed:", error);
    alert("Download failed. Please try again.");
  }
}


function insertPredictiveTabIfNeeded() {
  if (sessionStorage.getItem("isLabeled") === "true") {
    const alreadyExists = document.querySelector('a[href="/predictive"]');
    if (!alreadyExists) {
      const predictiveTab = document.createElement("a");
      predictiveTab.href = "/predictive";
      predictiveTab.className = "tab-button";
      predictiveTab.textContent = "Predictive Modelling";
      document.querySelector(".tabs").appendChild(predictiveTab);
    }
  }
}


function generateWordCloudWithFreqFilter(container, freqArray, minFreq) {
  let filtered = freqArray.filter(([word, freq]) => freq >= minFreq);
  
  // PERFORMANCE: Limit words but keep them as real text
  if (filtered.length > 300) {
    console.log(`Limiting ${filtered.length} words to 300 for performance`);
    filtered = filtered.slice(0, 300);
  }
  
  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#666;">No words meet this frequency threshold.</div>';
    return;
  }
  
  const w = Math.max(container.clientWidth - 40, 500);
  const h = 600;
  const maxF = filtered[0][1];
  const minF = filtered[filtered.length - 1][1];
  
  // Auto-sizing logic
  const minFont = Math.max(14, Math.round(w / 60));
  const maxFont = Math.max(60, Math.round(w / 8));
  const fontScale = d3.scaleSqrt().domain([minF, maxF]).range([minFont, maxFont]).clamp(true);

  // Prepare words
  const words = filtered.map(([text, freq]) => ({
    text: text.replace(/_/g, ' '),
    size: fontScale(freq),
    frequency: freq
  }));

  // Clear container
  container.innerHTML = '';
  
  // Create a container for the word cloud
  const cloudContainer = document.createElement('div');
  cloudContainer.className = 'wordcloud-canvas-container';
  cloudContainer.style.width = w + 'px';
  cloudContainer.style.height = h + 'px';
  cloudContainer.style.position = 'relative';
  cloudContainer.style.margin = '0 auto';
  container.appendChild(cloudContainer);

  // ✅ FIX: Use setTimeout to yield control
  setTimeout(() => {
    if (window.d3 && d3.layout && typeof d3.layout.cloud === "function") {
      d3.layout.cloud()
        .size([w, h])
        .words(words)
        .padding(5)
        .rotate(() => (Math.random() > 0.75 ? 90 : 0))
        .font("Arial, sans-serif")
        .fontSize(d => d.size)
        .fontWeight("bold")
        .spiral("rectangular")
        .on("end", function(placedWords) {
          renderWordsAsHTML(cloudContainer, placedWords);
        })
        .start();
    } else {
      // Fallback: simple grid layout
      renderSimpleWordGrid(cloudContainer, words, w, h);
    }
  }, 0); // ✅ KEY: Yield control to browser
}


let originalCSVData = [];


// FIXED: Generate large word clouds for CSV (matching unlabeled size)
function generateWordCloudsFromCSV(data) {
  const includeStopwords = document.getElementById("includeStopwords").checked;

  // Step 1: Collect words per label
  const labelToWords = {};

  data.forEach(row => {
    const text = row.text || row.email || "";
    const label = String(row.label);

    const words = text.toLowerCase().split(/\W+/).filter(w => {
      if (w.length <= 2) return false;
      if (!includeStopwords && stopwords.has(w)) return false;
      return true;
    });

    if (!labelToWords[label]) labelToWords[label] = [];
    labelToWords[label].push(...words);
  });

  // Step 2: Generate word frequencies as arrays for d3-cloud
  const labelToFreqArray = {};
  for (const label in labelToWords) {
    const freqMap = {};
    labelToWords[label].forEach(word => {
      freqMap[word] = (freqMap[word] || 0) + 1;
    });
    
    // Convert to array format [["word", frequency], ...]
    labelToFreqArray[label] = Object.entries(freqMap)
      .filter(([w, f]) => w && Number.isFinite(f) && f > 0)
      .sort((a, b) => b[1] - a[1]); // high → low
  }

  // Step 3: Clear old content and build containers
  const container = document.querySelector("#wordCloud .wordcloud-flex");
  container.innerHTML = "";

  // Sort labels numerically if possible
  const sortedLabels = Object.keys(labelToFreqArray).sort((a, b) => {
    const numA = parseFloat(a);
    const numB = parseFloat(b);
    if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
    return String(a).localeCompare(String(b));
  });

  sortedLabels.forEach(label => {
    const freqArray = labelToFreqArray[label];
    
    if (!freqArray.length) {
      const div = document.createElement("div");
      div.className = "wordcloud-box";
      div.innerHTML = `<h5>Class ${label || "Unlabeled"}</h5><div style="color: crimson;">No words to display.</div>`;
      container.appendChild(div);
      return;
    }

    const div = document.createElement("div");
    div.className = "wordcloud-box";
    const displayLabel = label || "Unlabeled";
    div.innerHTML = `<h5>Class ${displayLabel}</h5>`;
    container.appendChild(div);

    // Create a container for the word cloud - FULL SIZE
    const cloudContainer = document.createElement("div");
    cloudContainer.className = "wordcloud-canvas-container";
    div.appendChild(cloudContainer);

    // Generate the word cloud with automatic font sizing - FULL SIZE
    generateWordCloudWithAutoSizing(cloudContainer, freqArray);
  });
}

// Updated helper function for full-size word clouds
function generateWordCloudWithAutoSizing(container, freqArray) {
  const wordCount = freqArray.length;
  
  console.log(`📊 Starting word cloud with ${wordCount} words`);
  
  const isDark = document.body.classList.contains("dark-mode");
  
  // Color scheme
  const color = (d3.schemeCategory10 || []).length
    ? d3.scaleOrdinal(d3.schemeCategory10)
    : () => (isDark ? "#f0f0f0" : "#333");
  
  // Clear container
  container.innerHTML = '';
  
  // ✅ Container styling - fill available space
  container.style.position = 'relative';
  container.style.width = '100%';
  container.style.minHeight = '600px';
  
  let currentZoomLevel = 1;
  
  // ✅ Function to render word cloud at a specific zoom level
  function renderAtZoomLevel(zoomLevel) {
    console.log(`🔄 Re-rendering at zoom level: ${zoomLevel}`);
    
    currentZoomLevel = zoomLevel;
    
    // ✅ Get actual container dimensions dynamically
    const containerWidth = container.clientWidth || 1200;
    const containerHeight = Math.max(container.clientHeight, 600);
    
    // ✅ Use 100% of container dimensions
    const w = containerWidth;
    const h = containerHeight;
    
    console.log(`📐 Canvas dimensions: ${w}x${h}`);
    
    // Dynamic font sizing based on word count AND zoom
    const maxF = freqArray[0][1] || 1;
    const minF = freqArray[freqArray.length - 1][1] || 1;
    
    // ✅ Font sizes scale with zoom - smaller fonts when zoomed out
    const baseFontSize = Math.max(6, Math.min(12, 150 / Math.sqrt(wordCount)));
    const minFont = Math.max(baseFontSize * zoomLevel, 6);
    const maxFont = Math.max(minFont * 6, 30 * zoomLevel);
    
    const fontScale = d3.scaleSqrt().domain([minF, maxF]).range([minFont, maxFont]);
    
    console.log(`🎨 Zoom ${zoomLevel.toFixed(2)}x - Font range: ${minFont.toFixed(1)}px - ${maxFont.toFixed(1)}px`);
    
    // Prepare all words with new sizes
    const words = freqArray.map(([text, freq]) => ({ 
      text, 
      size: fontScale(freq)
    }));
    
    // Clear previous render (except controls)
    const existingControls = container.querySelector('#zoom-controls');
    container.innerHTML = '';
    
    // ✅ Create SVG with 100% width and height
    const svg = d3.select(container).append("svg")
      .attr("width", "100%")
      .attr("height", "100%")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "xMidYMid meet")
      .style("display", "block")
      .style("min-height", "600px")
      .style("background", isDark ? "#1a1a1a" : "#ffffff")
      .style("border", "1px solid #e5e7eb")
      .style("border-radius", "8px");
    
    const centerGroup = svg.append("g")
      .attr("transform", `translate(${w / 2}, ${h / 2})`);
    
    // Draw function
    function draw(placed) {
      const placedCount = placed.length;
      const totalCount = words.length;
      const percentage = Math.round((placedCount / totalCount) * 100);
      
      console.log(`✅ Placed ${placedCount}/${totalCount} words (${percentage}%) at zoom ${zoomLevel.toFixed(2)}x`);
      
      // ✅ Show feedback ABOVE the canvas
      const feedbackDiv = document.createElement('div');
      feedbackDiv.style.cssText = 'text-align: center; padding: 8px; margin-bottom: 10px;';
      
      if (placedCount < totalCount) {
        const missing = totalCount - placedCount;
        feedbackDiv.style.cssText += 'color: #dc2626; font-size: 13px; background: #fef2f2; border: 1px solid #fecaca; border-radius: 6px;';
        feedbackDiv.innerHTML = `⚠️ Showing ${placedCount} of ${totalCount} words (${percentage}%) - <strong>${missing} words couldn't fit</strong>. Try zooming out to see more words.`;
      } else {
        feedbackDiv.style.cssText += 'color: #16a34a; font-size: 13px; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 6px;';
        feedbackDiv.innerHTML = `✅ Successfully showing <strong>all ${totalCount} words</strong> at ${Math.round(zoomLevel * 100)}% zoom`;
      }
      
      container.insertBefore(feedbackDiv, container.firstChild);
      
      // Draw words
      centerGroup.selectAll("text")
        .data(placed)
        .enter().append("text")
        .attr("text-anchor", "middle")
        .style("font-family", "Arial, sans-serif")
        .style("font-weight", "bold")
        .style("font-size", d => d.size + "px")
        .style("fill", d => color(d.text))
        .style("cursor", "pointer")
        .attr("transform", d => `translate(${d.x},${d.y}) rotate(${d.rotate})`)
        .text(d => d.text)
        .on("mouseover", function() {
          d3.select(this).style("opacity", 0.7).style("text-decoration", "underline");
        })
        .on("mouseout", function() {
          d3.select(this).style("opacity", 1).style("text-decoration", "none");
        });
    }
    
    // Generate word cloud with d3-cloud
    if (window.d3 && d3.layout && typeof d3.layout.cloud === "function") {
      d3.layout.cloud()
        .size([w, h]) // Use calculated dimensions for layout
        .words(words)
        .padding(Math.max(1, 3 * zoomLevel))
        .rotate(() => {
          const rand = Math.random();
          if (rand > 0.85) return 90;
          if (rand > 0.70) return -90;
          if (rand > 0.60) return 45;
          if (rand > 0.50) return -45;
          return 0;
        })
        .font("Arial, sans-serif")
        .fontSize(d => d.size)
        .fontWeight("bold")
        .spiral("archimedean")
        .timeInterval(Infinity)
        .on("end", draw)
        .start();
    } else {
      const msg = document.createElement("div");
      msg.style.color = "crimson";
      msg.style.fontSize = "14px";
      msg.style.padding = "20px";
      msg.textContent = "Word Cloud unavailable: d3-cloud not loaded.";
      container.appendChild(msg);
    }
    
    // Re-append controls if they existed
    if (existingControls) {
      container.appendChild(existingControls);
    }
  }
  
  // ✅ Initial render at 100% zoom
  renderAtZoomLevel(1.0);
  
  // ✅ Add zoom controls
  const controlsDiv = document.createElement('div');
  controlsDiv.id = 'zoom-controls';
  controlsDiv.style.cssText = 'text-align: center; padding: 12px; margin-top: 15px; background: linear-gradient(135deg, #f8fafc 0%, #e0f2fe 100%); border-radius: 8px; border: 1px solid #bae6fd;';
  controlsDiv.innerHTML = `
    <div style="display: flex; justify-content: center; align-items: center; gap: 15px; flex-wrap: wrap;">
      <button id="zoom-out-btn" style="
        padding: 10px 20px;
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 14px;
        box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
        transition: transform 0.2s;
      " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
        🔍− Zoom Out
      </button>
      
      <div style="display: flex; align-items: center; gap: 10px; background: white; padding: 8px 16px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
        <span style="color: #64748b; font-weight: 600; font-size: 13px;">Zoom:</span>
        <span id="zoom-display" style="
          font-weight: 700;
          font-size: 18px;
          color: #1e40af;
          min-width: 60px;
          display: inline-block;
          text-align: center;
        ">100%</span>
      </div>
      
      <button id="zoom-in-btn" style="
        padding: 10px 20px;
        background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 14px;
        box-shadow: 0 2px 4px rgba(59, 130, 246, 0.3);
        transition: transform 0.2s;
      " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
        🔍+ Zoom In
      </button>
      
      <button id="zoom-reset-btn" style="
        padding: 10px 20px;
        background: linear-gradient(135deg, #64748b 0%, #475569 100%);
        color: white;
        border: none;
        border-radius: 8px;
        cursor: pointer;
        font-weight: 600;
        font-size: 14px;
        box-shadow: 0 2px 4px rgba(100, 116, 139, 0.3);
        transition: transform 0.2s;
      " onmouseover="this.style.transform='scale(1.05)'" onmouseout="this.style.transform='scale(1)'">
        ↺ Reset
      </button>
    </div>
    <div style="margin-top: 10px; font-size: 12px; color: #64748b; font-style: italic;">
      💡 Zoom Out = Smaller words, more fit in view • Zoom In = Larger words, fewer fit • Use mouse wheel to zoom
    </div>
  `;
  container.appendChild(controlsDiv);
  
  // ✅ Zoom button handlers with debouncing
  let zoomTimeout;
  const zoomDisplay = document.getElementById('zoom-display');
  const zoomInBtn = document.getElementById('zoom-in-btn');
  const zoomOutBtn = document.getElementById('zoom-out-btn');
  const zoomResetBtn = document.getElementById('zoom-reset-btn');
  
  zoomInBtn.addEventListener('click', () => {
    clearTimeout(zoomTimeout);
    const newZoom = Math.min(currentZoomLevel * 1.25, 2.5);
    zoomDisplay.textContent = `${Math.round(newZoom * 100)}%`;
    zoomTimeout = setTimeout(() => renderAtZoomLevel(newZoom), 300);
  });
  
  zoomOutBtn.addEventListener('click', () => {
    clearTimeout(zoomTimeout);
    const newZoom = Math.max(currentZoomLevel / 1.25, 0.25);
    zoomDisplay.textContent = `${Math.round(newZoom * 100)}%`;
    zoomTimeout = setTimeout(() => renderAtZoomLevel(newZoom), 300);
  });
  
  zoomResetBtn.addEventListener('click', () => {
    clearTimeout(zoomTimeout);
    zoomDisplay.textContent = '100%';
    renderAtZoomLevel(1.0);
  });
  
  // ✅ Mouse wheel zoom with debouncing
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    clearTimeout(zoomTimeout);
    
    const delta = e.deltaY > 0 ? 0.95 : 1.05;
    const newZoom = Math.max(0.25, Math.min(2.5, currentZoomLevel * delta));
    
    zoomDisplay.textContent = `${Math.round(newZoom * 100)}%`;
    
    zoomTimeout = setTimeout(() => renderAtZoomLevel(newZoom), 400);
  }, { passive: false });
  
  // ✅ Handle window resize - re-render at current zoom level
  let resizeTimeout;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      console.log('📐 Window resized, re-rendering word cloud');
      renderAtZoomLevel(currentZoomLevel);
    }, 500);
  });
}

// ===== CORRECTED WORD CLOUD WITH SMART RANGE SLIDER =====

async function getEntitiesFromText(text) {
  try {
    const response = await fetch("/api/extract_entities", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    const data = await response.json();
    return data.entities || [];
  } catch (err) {
    console.error("Entity extraction failed:", err);
    return [];
  }
}

function processTextWithNER(text, entities) {
  let processedText = text;
  const sortedEntities = entities
    .filter(e => e.text && e.text.includes(' '))
    .sort((a, b) => b.text.length - a.text.length);
  
  sortedEntities.forEach(entity => {
    const original = entity.text;
    const replaced = original.replace(/\s+/g, '_');
    const regex = new RegExp(`\\b${original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    processedText = processedText.replace(regex, replaced);
  });
  
  return processedText;
}

// ==================== WORD CLOUD CACHE ====================
// Initialize word cloud cache if not exists
if (!window.wordCloudCache) {
  window.wordCloudCache = {
    cache: {},        // Cache for frequency data
    dataCache: {},    // Cache for filtered class data
    allDataCache: null, 
    // Check if frequency data is cached
    has: function(className) { 
      return this.cache.hasOwnProperty(className); 
    },
    
    // Get cached frequency data
    get: function(className) { 
      return this.cache[className]; 
    },
    
    // Cache frequency data
    set: function(className, data) { 
      this.cache[className] = data;
      console.log(`✅ Cached word cloud for "${className}"`);
    },
    
    // Cache filtered class data (to avoid re-filtering)
    setAllData: function(freqArray) {
      this.allDataCache = {
        freqArray: freqArray,
        timestamp: Date.now()
      };
      console.log("✅ Cached ALL data frequencies");
    },
    
    getAllData: function() {
      return this.allDataCache;
    },
    
    hasAllData: function() {
      return this.allDataCache !== null;
    },
    // Clear all caches
    clear: function() { 
      this.cache = {}; 
      this.dataCache = {};
      console.log("🧹 Cleared all word cloud caches");
    }
  };
}

async function renderWordCloudForClass(data, className) {
  const container = document.querySelector('.wordcloud-flex');
  if (!container) return;
  
  const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
  
  console.log(`🔍 Rendering word cloud for class: "${className}"`);
  
  // ✅ 1. Check if this specific class is already cached
  if (window.wordCloudCache && window.wordCloudCache.has(className)) {
    console.log(`⚡ Loading "${className}" from cache`);
    const cached = window.wordCloudCache.get(className);
    renderCachedWordCloud(container, className, cached);
    return;
  }
  
  // ✅ 2. Filter the data for this class
  let classData;
  if (className === "all") {
    classData = data;
  } else {
    const targetClassNum = className.replace('label', '');
    classData = data.filter(row => {
      const rowClass = row.class !== undefined ? row.class : row.label;
      return String(rowClass || 'Unlabeled') === targetClassNum;
    });
  }
  
  if (!classData || classData.length === 0) {
    const displayTitle = className === "all" ? "All Data" : `Class ${className}`;
    container.innerHTML = `<h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>
                          <div style="color: #666; margin-top: 20px; text-align: center;">
                            No data available for this class.
                          </div>`;
    return;
  }
  
  // ✅ 3. SMART CACHING LOGIC:
  // If we have "all" data cached, use it to filter for this class
  if (className !== "all" && window.wordCloudCache && window.wordCloudCache.hasAllData()) {
    console.log(`🔍 Filtering "${className}" from cached "all" data`);
    
    // Get text for this specific class
    const classTextData = classData.map(row => row.text || "").filter(text => text.trim());
    const classText = classTextData.join(' ');
    
    if (!classText.trim()) {
      const displayTitle = className === "all" ? "All Data" : `Class ${className}`;
      container.innerHTML = `<h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>
                            <div style="color: #666; margin-top: 20px; text-align: center;">
                              No text content available for this class.
                            </div>`;
      return;
    }
    
    // Get cached "all" frequencies
    const allCached = window.wordCloudCache.getAllData();
    const allFreqArray = allCached.freqArray;
    
    // Create a set of words from this class for fast lookup
    const classWords = new Set();
    classText.toLowerCase().split(/\W+/).forEach(w => {
      if (w.length > 2) {
        if (!includeStopwords && stopwords.has(w.replace(/_/g, ' '))) return;
        classWords.add(w);
      }
    });
    
    // Filter "all" frequencies to only include words from this class
    const classFreqArray = allFreqArray.filter(([word, freq]) => {
      return classWords.has(word);
    });
    
    if (classFreqArray.length > 0) {
      const maxFreq = classFreqArray[0][1];
      const minFreq = classFreqArray[classFreqArray.length - 1][1];
      
      // Cache this class's filtered frequencies
      window.wordCloudCache.set(className, {
        freqArray: classFreqArray,
        maxFreq: maxFreq,
        minFreq: minFreq,
        wordCount: classTextData.length,
        timestamp: Date.now(),
        source: 'filtered'
      });
      
      // Render immediately
      renderWordCloudFromFrequencies(container, className, classFreqArray, maxFreq, minFreq);
      return;
    }
  }
  
  // ✅ 4. If no cache available, fetch from Python (with loading indicator)
  const textData = classData.map(row => row.text || "").filter(text => text.trim());
  const combinedText = textData.join(' ');

  // Calculate UNIQUE word count for loading message
  // Calculate UNIQUE word count for loading message (filtering stopwords)
  const allWords = combinedText.toLowerCase().split(/\W+/).filter(w => w.length > 2);  // Filter short words
  const uniqueWordsSet = new Set();

  allWords.forEach(word => {
    // Apply the same stopword filtering that will be used
    if (!includeStopwords && stopwords.has(word.replace(/_/g, ' '))) {
      return;  // Skip stopwords
    }
    uniqueWordsSet.add(word);
  });

  const uniqueWordCount = uniqueWordsSet.size;

  const displayTitle = className === "all" ? "All Data" : `Class ${className}`;
  container.innerHTML = `
    <h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>
    <div style="text-align: center; padding: 40px; color: #666;">
      <div class="spinner" style="width: 40px; height: 40px; border: 4px solid #f3f3f3; border-top: 4px solid #3498db; border-radius: 50%; margin: 0 auto 20px; animation: spin 1s linear infinite;"></div>
      <p>Generating word cloud of ${uniqueWordCount.toLocaleString()} unique words...</p>
      <p style="font-size: 0.9em; color: #999;">This may take a moment for large datasets.</p>
    </div>
  `;
  
  // Add CSS for spinner if not already added
  if (!document.querySelector('#spinner-style')) {
    const style = document.createElement('style');
    style.id = 'spinner-style';
    style.textContent = `
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);
  }
  
  try {
    const response = await fetch("/api/wordcloud_frequencies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rows: textData,
        includeStopwords: includeStopwords,
        className: className
      })
    });
    
    const result = await response.json();
    
    if (result.frequencies && result.frequencies.length > 0) {
      const freqArray = result.frequencies;
      const maxFreq = freqArray[0][1];
      const minFreq = freqArray[freqArray.length - 1][1];
      
      // Cache the results
      window.wordCloudCache.set(className, {
        freqArray: freqArray,
        maxFreq: maxFreq,
        minFreq: minFreq,
        wordCount: textData.length,
        timestamp: Date.now(),
        source: 'api'
      });
      
      // If this is "all" data, cache it separately
      if (className === "all") {
        window.wordCloudCache.setAllData(freqArray);
      }
      
      renderWordCloudFromFrequencies(container, className, freqArray, maxFreq, minFreq);
    } else {
      container.innerHTML = `
        <h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>
        <div style="color: #666; margin-top: 20px; text-align: center;">
          No words found for this class with current settings.
        </div>
      `;
    }
  } catch (error) {
    console.error("Word cloud failed:", error);
    // Fallback to local processing...
    container.innerHTML = `
      <h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>
      <div style="color: crimson; margin-top: 20px; text-align: center;">
        ❌ Failed to generate word cloud. Please try again.
      </div>
    `;
  }
}

// Helper function to render word cloud from frequencies
function renderWordCloudFromFrequencies(container, className, freqArray, maxFreq, minFreq) {
  // Clear container
  container.innerHTML = '';
  
  const displayTitle = className === "all" ? "All Data" : `Class ${className}`;
  container.innerHTML = `<h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>`;
  
  // ✅ Build smart frequency ranges
  const frequencyRanges = buildSmartFrequencyRanges(freqArray);
  console.log('Frequency ranges:', frequencyRanges);
  
  if (!frequencyRanges.length) {
    container.innerHTML += '<div style="color: crimson; margin-top: 20px;">No words to display.</div>';
    return;
  }
  
  // Start at first range (lowest frequency)
  const currentRange = frequencyRanges[0];
  
  // Create slider container with numeric input
  const sliderContainer = document.createElement('div');
  sliderContainer.className = 'word-cloud-slider-container';
  sliderContainer.style.cssText = 'margin: 20px auto; max-width: 600px; padding: 0 20px;';
  
  const rangeDisplay = (currentRange.min === currentRange.max) 
    ? `<span id="freq-value-${className}" style="font-weight: 700; font-size: 1.5em; color: var(--primary-blue);">${currentRange.max}</span>`
    : `<span id="freq-value-${className}" style="font-weight: 700; font-size: 1.5em; color: var(--primary-blue);">${currentRange.min}-${currentRange.max}</span>`;
  
  sliderContainer.innerHTML = `
    <div style="text-align: center; margin-bottom: 12px;">
      ${rangeDisplay}
    </div>
    <div style="display: flex; align-items: center; gap: 15px;">
      <input 
        type="number" 
        id="freq-input-${className}" 
        min="1" 
        max="${frequencyRanges.length}" 
        value="1" 
        step="1"
        style="
          width: 80px;
          padding: 8px 12px;
          border: 2px solid var(--neutral-300);
          border-radius: var(--radius-md);
          font-size: 1rem;
          font-weight: 600;
          text-align: center;
          background: white;
          color: var(--neutral-800);
        "
        onkeydown="handleFrequencyInput(event, '${className}')"
      >
      <input 
        type="range" 
        id="freq-slider-${className}" 
        min="1" 
        max="${frequencyRanges.length}" 
        value="1" 
        step="1"
        style="flex: 1; cursor: pointer;"
      >
    </div>
    <div style="display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-top: 4px;">
      <span>${minFreq} (All words)</span>
      <span>${maxFreq} (Top word only)</span>
    </div>
  `;
  
  container.appendChild(sliderContainer);
  
  const cloudContainer = document.createElement("div");
  cloudContainer.className = "wordcloud-canvas-container";
  cloudContainer.id = `cloud-container-${className}`;
  cloudContainer.style.width = "100%";
  cloudContainer.style.minHeight = "650px";
  container.appendChild(cloudContainer);
  
  // ✅ INSTANT rendering with cached data
  generateWordCloudWithFreqFilter(cloudContainer, freqArray, currentRange.min);
  
  // ✅ Set up slider controls
  const slider = document.getElementById(`freq-slider-${className}`);
  const input = document.getElementById(`freq-input-${className}`);
  const valueDisplay = document.getElementById(`freq-value-${className}`);
  
  if (slider && input && valueDisplay) {
    // Set slider properties based on smart ranges
    slider.min = 1;
    slider.max = frequencyRanges.length;
    input.min = 1;
    input.max = frequencyRanges.length;
    
    // Initialize slider gradient
    updateSliderGradient(slider);
    
    // Sync slider and input
    function updateFrequency(rangeIndex) {
      const adjustedIndex = rangeIndex - 1;
      
      if (adjustedIndex < 0 || adjustedIndex >= frequencyRanges.length) {
        console.error(`Invalid range index: ${rangeIndex}`);
        return;
      }
      
      const range = frequencyRanges[adjustedIndex];
      
      // Update display
      if (range.min === range.max) {
        valueDisplay.innerHTML = range.max;
      } else {
        valueDisplay.innerHTML = `${range.min}-${range.max}`;
      }
      
      // Update inputs
      slider.value = rangeIndex;
      input.value = rangeIndex;
      
      // Update slider gradient
      updateSliderGradient(slider);
      
      // Re-render word cloud with the minimum frequency of this range
      generateWordCloudWithFreqFilter(cloudContainer, freqArray, range.min);
    }
    
    // Helper function to update slider gradient
    function updateSliderGradient(sliderElement) {
      const progress = ((sliderElement.value - sliderElement.min) / (sliderElement.max - sliderElement.min)) * 100;
      sliderElement.style.background = `linear-gradient(to right, #4f46e5 0%, #4f46e5 ${progress}%, #e5e7eb ${progress}%, #e5e7eb 100%)`;
    }
    
    // Event listeners
    slider.addEventListener('input', (e) => {
      const rangeIndex = parseInt(e.target.value);
      updateFrequency(rangeIndex);
    });
    
    let inputTimeout;
    input.addEventListener('input', (e) => {
      clearTimeout(inputTimeout);
      inputTimeout = setTimeout(() => {
        let rangeIndex = parseInt(e.target.value);
        const max = parseInt(slider.max);
        const min = parseInt(slider.min);
        
        if (isNaN(rangeIndex)) {
          rangeIndex = parseInt(slider.value);
          input.value = rangeIndex;
          return;
        }
        
        rangeIndex = Math.max(min, Math.min(max, rangeIndex));
        updateFrequency(rangeIndex);
      }, 300);
    });
    
    // Initialize
    updateFrequency(1);
  }
}
// Function to render from cache (for instant tab switching)
function renderCachedWordCloud(container, className, cachedData) {
  const { freqArray, maxFreq, minFreq } = cachedData;
  renderWordCloudFromFrequencies(container, className, freqArray, maxFreq, minFreq);
}

// Fallback function for local processing (if Python API fails)
async function renderWordCloudLocally(container, className, combinedText, includeStopwords) {
  console.log("🔄 Processing word cloud locally...");
  
  try {
    const entities = await getEntitiesFromText(combinedText);
    const processedText = processTextWithNER(combinedText, entities);
    
    const words = [];
    processedText.toLowerCase().split(/\W+/).forEach(w => {
      if (w.length <= 2) return;
      if (!includeStopwords && stopwords.has(w.replace(/_/g, ' '))) return;
      words.push(w);
    });
    
    console.log(`📊 Local processing - Words extracted: ${words.length} words`);
    
    const freqMap = {};
    words.forEach(word => {
      freqMap[word] = (freqMap[word] || 0) + 1;
    });
    
    const freqArray = Object.entries(freqMap)
      .filter(([w, f]) => w && Number.isFinite(f) && f > 0)
      .sort((a, b) => b[1] - a[1]);
    
    console.log(`📊 Local processing - Unique words: ${freqArray.length}`);
    
    if (!freqArray.length) {
      container.innerHTML = `<div style="color: crimson; margin-top: 20px;">No words to display.</div>`;
      return;
    }
    
    const maxFreq = freqArray[0][1];
    const minFreq = freqArray[freqArray.length - 1][1];
    
    // Cache locally computed results too
    if (window.wordCloudCache) {
      window.wordCloudCache.set(className, {
        freqArray: freqArray,
        maxFreq: maxFreq,
        minFreq: minFreq,
        wordCount: words.length,
        timestamp: Date.now(),
        source: 'local'
      });
    }
    
    // Render using the same function
    renderWordCloudFromFrequencies(container, className, freqArray, maxFreq, minFreq);
    
  } catch (error) {
    console.error("❌ Local word cloud processing failed:", error);
    container.innerHTML = `
      <div style="color: crimson; margin-top: 20px;">
        ❌ Failed to generate word cloud. Please try again.
      </div>
    `;
  }
}
  
// Handle numeric input with arrow keys and validation
function handleFrequencyInput(event, className) {
  const input = event.target;
  const slider = document.getElementById(`freq-slider-${className}`);
  const max = parseInt(slider.max);
  
  // Allow arrow keys
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    event.preventDefault();
    let newValue = parseInt(input.value) + (event.key === 'ArrowUp' ? 1 : -1);
    newValue = Math.max(1, Math.min(max, newValue));
    
    // ✅ Update both inputs immediately
    input.value = newValue;
    slider.value = newValue;
    updateFrequency(newValue);
  }
  
  // Handle Enter key to apply changes
  if (event.key === 'Enter') {
    let newValue = parseInt(input.value);
    
    // Validate range
    if (isNaN(newValue)) {
      newValue = parseInt(slider.value);
    } else {
      newValue = Math.max(1, Math.min(max, newValue));
    }
    
    // ✅ Update both inputs immediately
    input.value = newValue;
    slider.value = newValue;
    updateFrequency(newValue);
    input.blur(); // Remove focus after Enter
  }
}

// Add cache clearing when new data is uploaded
function clearWordCloudCache() {
  wordCloudCache.clear();
  currentCacheKey = null;
  console.log("🧹 Cleared word cloud cache");
}


// ✅ Build smart frequency ranges where words actually change
function buildSmartFrequencyRanges(freqArray) {
  const ranges = [];
  const uniqueFreqs = [...new Set(freqArray.map(([, freq]) => freq))].sort((a, b) => a - b);
  
  for (let i = 0; i < uniqueFreqs.length; i++) {
    const currentFreq = uniqueFreqs[i];
    
    // Get words at this frequency threshold
    const wordsAtFreq = new Set(
      freqArray.filter(([, f]) => f >= currentFreq).map(([w]) => w)
    );
    
    // Find the highest frequency that shows the same set of words
    let rangeEnd = currentFreq;
    for (let j = i + 1; j < uniqueFreqs.length; j++) {
      const nextFreq = uniqueFreqs[j];
      const wordsAtNext = new Set(
        freqArray.filter(([, f]) => f >= nextFreq).map(([w]) => w)
      );
      
      // Check if word sets are identical
      if (wordsAtNext.size !== wordsAtFreq.size || 
          [...wordsAtNext].some(w => !wordsAtFreq.has(w))) {
        break;
      }
      
      rangeEnd = nextFreq;
    }
    
    // Add this range
    ranges.push({
      min: currentFreq,
      max: rangeEnd,
      wordCount: wordsAtFreq.size
    });
    
    // Skip to end of this range
    const nextIndex = uniqueFreqs.indexOf(rangeEnd) + 1;
    if (nextIndex < uniqueFreqs.length) {
      i = nextIndex - 1; // -1 because loop will increment
    } else {
      break;
    }
  }
  
  return ranges;
}

function generateWordCloudWithFreqFilter(container, freqArray, minFreq) {
  let filtered = freqArray.filter(([word, freq]) => freq >= minFreq);
  
  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#666;">No words meet this frequency threshold.</div>';
    return;
  }
  
  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:40px;color:#666;">No words meet this frequency threshold.</div>';
    return;
  }
  
  const w = Math.max(container.clientWidth - 40, 500);
  const h = 600;
  const maxF = filtered[0][1];
  const minF = filtered[filtered.length - 1][1];
  
  // Auto-sizing logic
  const minFont = Math.max(14, Math.round(w / 60));
  const maxFont = Math.max(60, Math.round(w / 8));
  const fontScale = d3.scaleSqrt().domain([minF, maxF]).range([minFont, maxFont]).clamp(true);

  // Prepare words
  const words = filtered.map(([text, freq]) => ({
    text: text.replace(/_/g, ' '),
    size: fontScale(freq),
    frequency: freq
  }));

  // Clear container
  container.innerHTML = '';
  
  // Create a container for the word cloud
  const cloudContainer = document.createElement('div');
  cloudContainer.className = 'wordcloud-canvas-container';
  cloudContainer.style.width = w + 'px';
  cloudContainer.style.height = h + 'px';
  cloudContainer.style.position = 'relative';
  cloudContainer.style.margin = '0 auto';
  container.appendChild(cloudContainer);

  // Use D3 cloud for layout but render as HTML elements
  if (window.d3 && d3.layout && typeof d3.layout.cloud === "function") {
    d3.layout.cloud()
      .size([w, h])
      .words(words)
      .padding(5)
      .rotate(() => (Math.random() > 0.75 ? 90 : 0))
      .font("Arial, sans-serif")
      .fontSize(d => d.size)
      .fontWeight("bold")
      .spiral("rectangular")
      .on("end", function(placedWords) {
        renderWordsAsHTML(cloudContainer, placedWords);
      })
      .start();
  } else {
    // Fallback: simple grid layout
    renderSimpleWordGrid(cloudContainer, words, w, h);
  }
}

// Render words as actual HTML elements (selectable, no background)
function renderWordsAsHTML(container, placedWords) {
  const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd', 
                 '#8c564b', '#e377c2', '#7f7f7f', '#bcbd22', '#17becf'];
  
  // Create SVG container for better performance than individual HTML elements
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", container.clientWidth);
  svg.setAttribute("height", container.clientHeight);
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  
  const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
  g.setAttribute("transform", `translate(${container.clientWidth / 2}, ${container.clientHeight / 2})`);
  svg.appendChild(g);
  
  placedWords.forEach((word, index) => {
    const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
    text.setAttribute("text-anchor", "middle");
    text.setAttribute("transform", `translate(${word.x},${word.y}) rotate(${word.rotate})`);
    text.style.fontFamily = "Arial, sans-serif";
    text.style.fontWeight = "bold";
    text.style.fontSize = word.size + "px";
    text.style.fill = colors[index % colors.length];
    text.style.cursor = "pointer";
    text.textContent = word.text;
    
    // Add hover effect
    text.addEventListener('mouseenter', function() {
      this.style.fill = '#000000';
      this.style.textShadow = '0 0 8px rgba(0,0,0,0.3)';
    });
    text.addEventListener('mouseleave', function() {
      this.style.fill = colors[index % colors.length];
      this.style.textShadow = 'none';
    });
    
    g.appendChild(text);
  });
  
  container.appendChild(svg);
}

// Alternative: Use regular HTML elements (more interactive but slower)
function renderWordsAsHTMLElements(container, placedWords) {
  const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'];
  
  placedWords.forEach((word, index) => {
    const span = document.createElement('span');
    span.textContent = word.text;
    span.style.position = 'absolute';
    span.style.left = '50%';
    span.style.top = '50%';
    span.style.transform = `translate(${word.x}px, ${word.y}px) rotate(${word.rotate}deg)`;
    span.style.fontFamily = 'Arial, sans-serif';
    span.style.fontWeight = 'bold';
    span.style.fontSize = word.size + 'px';
    span.style.color = colors[index % colors.length];
    span.style.whiteSpace = 'nowrap';
    span.style.pointerEvents = 'auto';
    span.style.cursor = 'pointer';
    span.style.userSelect = 'text';
    
    // Add hover effects
    span.addEventListener('mouseenter', function() {
      this.style.color = '#000000';
      this.style.textShadow = '0 0 8px rgba(0,0,0,0.3)';
      this.style.zIndex = '1000';
    });
    span.addEventListener('mouseleave', function() {
      this.style.color = colors[index % colors.length];
      this.style.textShadow = 'none';
      this.style.zIndex = 'auto';
    });
    
    container.appendChild(span);
  });
}

// Simple grid fallback
function renderSimpleWordGrid(container, words, width, height) {
  const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'];
  
  words.forEach((word, index) => {
    const span = document.createElement('span');
    span.textContent = word.text;
    span.style.display = 'inline-block';
    span.style.margin = '5px';
    span.style.fontFamily = 'Arial, sans-serif';
    span.style.fontWeight = 'bold';
    span.style.fontSize = word.size + 'px';
    span.style.color = colors[index % colors.length];
    span.style.cursor = 'pointer';
    span.style.userSelect = 'text';
    
    container.appendChild(span);
  });
}

// Fallback function in case WordCloud2 isn't available
function renderWordCloudCanvasFallback(canvas, wordList, width, height) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  
  const colors = ['#1f77b4', '#ff7f0e', '#2ca02c', '#d62728', '#9467bd'];
  
  // Simple centered rendering as fallback
  wordList.forEach(([text, size], index) => {
    const row = Math.floor(index / 10);
    const col = index % 10;
    const x = (col + 0.5) * (width / 10);
    const y = (row + 0.5) * (height / Math.ceil(wordList.length / 10));
    
    ctx.font = `bold ${size}px Arial, sans-serif`;
    ctx.fillStyle = colors[index % colors.length];
    ctx.fillText(text, x, y);
  });
}
// NEW: Canvas-based word cloud renderer
function renderWordCloudCanvas(canvas, words, colorScale) {
  const ctx = canvas.getContext('2d');
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  
  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Simple spiral placement algorithm (you can enhance this later)
  let angle = 0;
  const radiusStep = 2;
  
  words.forEach((word, index) => {
    const fontSize = word.size;
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    
    // Measure text
    const metrics = ctx.measureText(word.text);
    const textWidth = metrics.width;
    const textHeight = fontSize; // Approximate height
    
    // Simple spiral positioning (replace with better algorithm if needed)
    const radius = radiusStep * angle;
    const x = centerX + radius * Math.cos(angle) - textWidth / 2;
    const y = centerY + radius * Math.sin(angle) + textHeight / 2;
    
    // Check if word fits (basic collision detection)
    if (x >= 0 && x + textWidth <= canvas.width && 
        y - textHeight >= 0 && y <= canvas.height) {
      
      // Set color - preserve your exact color scheme
      ctx.fillStyle = colorScale(word.text);
      
      // Add shadow for depth (like your current design)
      ctx.shadowColor = 'rgba(0, 0, 0, 0.3)';
      ctx.shadowBlur = 3;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 1;
      
      // Draw the text
      ctx.fillText(word.text, x, y);
      
      // Reset shadow for next word
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 0;
    }
    
    angle += 0.1; // Increase angle for next word
  });
}

// Alternative: Use WordCloud.js for professional results
function renderWordCloudWithLibrary(canvas, words, colorScale) {
  // Convert words to WordCloud.js format
  const wordList = words.map(word => [word.text, word.size]);
  
  WordCloud(canvas, {
    list: wordList,
    gridSize: Math.round(8 * canvas.width / 1024),
    weightFactor: function(size) {
      return size; // Use our pre-calculated sizes
    },
    fontFamily: 'Arial, sans-serif',
    color: function(word, weight, fontSize, distance, theta) {
      return colorScale(word);
    },
    rotateRatio: 0.25, // 25% of words rotated (like your current design)
    rotationSteps: 2, // Only 0 and 90 degrees
    backgroundColor: '#ffffff',
    minSize: 14
  });
}


function renderKeywordNetworkForClass(graph, className) {
  // ✅ FIXED: Target the network-specific container
  const networkContainer = document.querySelector('#networkContainer .class-tabs-content');
  
  if (!networkContainer) {
    console.error("❌ No network content container found!");
    return;
  }
  
  console.log("✅ Found network content container");
  
  // ✅ Update title for "All Data"
  const displayTitle = className === "all" ? "All Data" : `Class ${className}`;
  networkContainer.innerHTML = `<h5 style="margin-top: 20px;text-align: center;">${displayTitle}</h5>`;
  
  const svgContainer = document.createElement('div');
  svgContainer.className = 'keyword-network-container';
  svgContainer.style.width = '100%';
  svgContainer.style.minHeight = '700px';
  svgContainer.style.position = 'relative';
  
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const svgId = `cooccurrenceNetwork-${className}`;
  svg.setAttribute("id", svgId);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "700");
  svg.setAttribute("viewBox", "0 0 1200 700");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.style.display = "block";
  svg.style.border = "1px solid #e5e7eb";
  svg.style.borderRadius = "8px";
  svg.style.background = "#ffffff";
  
  svgContainer.appendChild(svg);
  networkContainer.appendChild(svgContainer);
  
  if (!window.netSimState) window.netSimState = {};
  if (!window.pinnedState) window.pinnedState = {};
  
  if (window.netSimState[svgId]) {
    try { window.netSimState[svgId].stop(); } catch {}
    window.netSimState[svgId] = null;
  }
  window.pinnedState[svgId] = new Set();
  
  renderKeywordNetwork(graph, svgId);
}

function renderKeywordNetwork(graph, containerId = 'cooccurrenceNetwork') {

  const svg = d3.select(`#${containerId}`);

  if (!window.netSimState) window.netSimState = {};
  if (!window.pinnedState) window.pinnedState = {};
  if (!window.pinnedState[containerId]) window.pinnedState[containerId] = new Set();

  const pinned = window.pinnedState[containerId];

  if (!graph?.nodes?.length || !graph?.links?.length) {
    svg.selectAll("*").remove();
    const viewBox = svg.attr("viewBox")?.split(" ") || [0,0,1200,700];
    const w = +viewBox[2];
    const h = +viewBox[3];

    svg.append("text")
      .attr("x", w/2)
      .attr("y", h/2)
      .attr("text-anchor","middle")
      .style("font-size","16px")
      .style("fill","crimson")
      .text("No results for current settings.");

    return;
  }

  if (window.netSimState[containerId]) {
    try { window.netSimState[containerId].stop(); } catch {}
  }

  svg.selectAll("*").remove();

  const viewBox = svg.attr("viewBox")?.split(" ") || [0,0,1200,700];
  const w = +viewBox[2];
  const h = +viewBox[3];
  const padding = 40;

  const nodes = graph.nodes.map(d => ({...d}));


  /* ---------- EDGE FILTERING ---------- */

  const MIN_LINK_WEIGHT = 10;
  const MAX_LINKS = 120;

  const links = graph.links
    .filter(d => (d.value ?? d.weight ?? 1) >= MIN_LINK_WEIGHT)
    .sort((a,b) => (b.value ?? b.weight ?? 1) - (a.value ?? a.weight ?? 1))
    .slice(0, MAX_LINKS)
    .map(d => ({...d, value: d.value ?? d.weight ?? 1}));


  /* ---------- INITIAL NODE POSITION ---------- */

  nodes.forEach(n => {
    n.x = padding + Math.random()*(w-2*padding);
    n.y = padding + Math.random()*(h-2*padding);
  });


  /* ---------- DEGREE CALCULATION ---------- */

  const degree = new Map(nodes.map(n => [n.id,0]));

  links.forEach(l=>{
    const s = l.source?.id || l.source;
    const t = l.target?.id || l.target;

    degree.set(s,(degree.get(s)||0)+1);
    degree.set(t,(degree.get(t)||0)+1);
  });


  /* ---------- NODE SIZE (FIT TEXT INSIDE) ---------- */

  const baseSize = d3.scaleSqrt()
    .domain(d3.extent(nodes, d => degree.get(d.id) || 1))
    .range([18,40]);

  function nodeR(d){
    const degreeSize = baseSize(degree.get(d.id)||1);
    const textWidth = d.id.length * 6;
    const textRadius = textWidth/2 + 14;
    return Math.max(degreeSize, textRadius);
  }


  /* ---------- EDGE SCALE ---------- */

  const minCo = d3.min(links,d=>d.value)||1;
  const maxCo = d3.max(links,d=>d.value)||1;

  const edgeScale = d3.scaleLinear()
    .domain([minCo,maxCo])
    .range([1,6]);


  /* ---------- SVG STRUCTURE ---------- */

  const root = svg.append("g");

  root.append("rect")
    .attr("class","zoom-catcher")
    .attr("x",0)
    .attr("y",0)
    .attr("width",w)
    .attr("height",h)
    .style("fill","none")
    .style("pointer-events","all");

  const g = root.append("g");


  /* ---------- LINKS ---------- */

  const link = g.append("g")
    .selectAll("line")
    .data(links)
    .enter()
    .append("line")
    .attr("stroke","#999")
    .attr("stroke-opacity",0.25)
    .attr("stroke-width",d=>edgeScale(d.value))
    .style("pointer-events","none");


  /* ---------- NODES ---------- */

  const nodeGroups = g.selectAll("g.node-group")
    .data(nodes)
    .enter()
    .append("g")
    .attr("class","node-group")
    .style("cursor","pointer");

  const circles = nodeGroups.append("circle")
    .attr("r",d=>nodeR(d))
    .attr("fill","#3b82f6")
    .attr("stroke","#fff")
    .attr("stroke-width",2);


  /* ---------- LABELS ---------- */

  const labels = nodeGroups.append("text")
    .attr("text-anchor","middle")
    .attr("dominant-baseline","central")
    .attr("font-weight","bold")
    .attr("font-size",16)
    .attr("fill","#111")
    .style("user-select","none")
    .style("pointer-events","none")
    .text(d=>d.id);


  /* ---------- HIGHLIGHT FUNCTION ---------- */

  let selectedNode = null;
  let connectedNodes = new Set();

  function highlightSelection(node){

    connectedNodes.clear();

    if(node){
      connectedNodes.add(node.id);

      links.forEach(l=>{
        const s = l.source.id || l.source;
        const t = l.target.id || l.target;

        if(s===node.id) connectedNodes.add(t);
        if(t===node.id) connectedNodes.add(s);
      });
    }

    circles
      .attr("fill",d=>connectedNodes.has(d.id) ? "#10b981" : "#3b82f6")
      .attr("opacity",d=>!node || connectedNodes.has(d.id) ? 1 : 0.25);

    labels
      .attr("opacity",d=>!node || connectedNodes.has(d.id) ? 1 : 0.25);

    link
      .attr("stroke",d=>{
        if(!node) return "#999";

        const s = d.source.id || d.source;
        const t = d.target.id || d.target;

        return (connectedNodes.has(s) && connectedNodes.has(t))
          ? "#10b981"
          : "#999";
      })
      .attr("stroke-opacity",d=>{
        if(!node) return 0.25;

        const s = d.source.id || d.source;
        const t = d.target.id || d.target;

        return (connectedNodes.has(s) && connectedNodes.has(t))
          ? 0.9
          : 0.05;
      });
  }


  /* ---------- CLICK EVENTS ---------- */

  nodeGroups.on("click", function(event,d){
    event.stopPropagation();

    selectedNode = (selectedNode===d) ? null : d;

    highlightSelection(selectedNode);
  });

  root.select("rect.zoom-catcher").on("click",function(){
    selectedNode = null;
    highlightSelection(null);
  });


  /* ---------- SIMULATION ---------- */

  const linkForce = d3.forceLink(links)
    .id(d=>d.id)
    .distance(l=>{
      const w = +l.value || 1;
      return Math.max(220,380-25*Math.log1p(w));
    })
    .strength(0.01);


  const sim = d3.forceSimulation(nodes)
    .alpha(0.1)
    .alphaDecay(0.05)
    .velocityDecay(0.9)
    .force("link",linkForce)
    .force("charge",d3.forceManyBody().strength(-80))
    .force("collide",d3.forceCollide().radius(d=>nodeR(d)+12))
    .on("tick",ticked);

  window.netSimState[containerId] = sim;


  function ticked(){

    link
      .attr("x1",d=>d.source.x)
      .attr("y1",d=>d.source.y)
      .attr("x2",d=>d.target.x)
      .attr("y2",d=>d.target.y);

    nodeGroups
      .attr("transform",d=>`translate(${d.x},${d.y})`);
  }


  /* ---------- ZOOM ---------- */

  const zoom = d3.zoom()
    .scaleExtent([0.4,4])
    .on("zoom",e=>{
      g.attr("transform",e.transform);
    });

  root.select("rect.zoom-catcher").call(zoom);


  /* ---------- DRAG ---------- */

  const drag = d3.drag()
    .on("start",(event,d)=>{
      if(!event.active) sim.alphaTarget(0.3).restart();
      d.fx=d.x;
      d.fy=d.y;
    })
    .on("drag",(event,d)=>{
      d.fx=event.x;
      d.fy=event.y;
    })
    .on("end",(event,d)=>{
      if(!event.active) sim.alphaTarget(0);
      pinned.add(d.id);
    });

  nodeGroups.call(drag);
}


// === Vocabulary Coverage (cumulative % vs rank, with 80%/90% guides) ===
window.generateCoverageChartServer = async function(rows, includeStopwords, minRank = 1, maxRank = 5000) {
  try {
    const slim = (rows || []).map(t => (t || "").toString().slice(0, 2000));
    const freq = await postJSON("/api/word_frequency", {
      rows: slim,
      includeStopwords: !!includeStopwords
    });
    
    const wrap = document.getElementById("frequencyChart");
    if (!Array.isArray(freq) || !freq.length) {
      wrap.innerHTML = "<p style='color:red'>❌ No data for coverage.</p>";
      return;
    }

    // Sort by frequency desc and compute cumulative coverage
    freq.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
    const total = freq.reduce((acc, d) => acc + (d.frequency || 0), 0) || 1;

    let cum = 0;
    const points = []; // [{x: rank, y: coverage%}]
    for (let i = 0; i < freq.length; i++) {
      cum += (freq[i].frequency || 0);
      points.push({ x: i + 1, y: (cum / total) * 100 });
    }

    const rankAtCoverage = thr => {
      for (const p of points) if (p.y >= thr) return p.x;
      return points[points.length - 1].x;
    };

    const thresholds = [80, 90];
    const v80 = rankAtCoverage(thresholds[0]);
    const v90 = rankAtCoverage(thresholds[1]);

    // Ensure canvas
    let canvas = wrap.querySelector("canvas");
    if (!canvas) {
      canvas = document.createElement("canvas");
      wrap.innerHTML = "";
      wrap.appendChild(canvas);
    }

    // Draw chart
    if (window.coverageChart) window.coverageChart.destroy();
    const ctx = canvas.getContext("2d");
    window.coverageChart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [{
          label: "Cumulative Coverage (%)",
          data: points,
          parsing: false,
          borderColor: "#2f80ed",
          borderWidth: 4,     // thicker blue line
          pointRadius: 0,
          tension: 0,
          fill: false
        }]
      },
      options: {
        responsive: true,
        aspectRatio: 1250/430,
        // Tooltip only when cursor is on the line
        interaction: { mode: "nearest", intersect: true },
        plugins: {
          legend: { display: false },
          // red dashed guides via annotation plugin
          annotation: {
            annotations: {
              h80: { type: "line", yMin: thresholds[0], yMax: thresholds[0], borderColor: "red", borderWidth: 2, borderDash: [6,4] },
              h90: { type: "line", yMin: thresholds[1], yMax: thresholds[1], borderColor: "red", borderWidth: 2, borderDash: [6,4] },
              v80: { type: "line", xMin: v80, xMax: v80, borderColor: "red", borderWidth: 2, borderDash: [6,4] },
              v90: { type: "line", xMin: v90, xMax: v90, borderColor: "red", borderWidth: 2, borderDash: [6,4] }
            }
          },
          tooltip: { intersect: true, mode: "nearest" },
          title: { display: false } // keep your HTML <h4> title above canvas
        },
        elements: { point: { radius: 0, hitRadius: 12, hoverRadius: 4 } },
        scales: {
          x: { type: "linear", title: { display: true, text: "Word Rank" }, min: +minRank, max: +maxRank },
          y: { title: { display: true, text: "Cumulative Coverage (%)" }, min: 0, max: 100 }
        }
      }
    });

    // ---------------- DOM LEGEND (top-right of the chart box) ----------------
    // Make the container positioned so we can absolutely position the legend.
    wrap.style.position = "relative";

    let domLegend = wrap.querySelector(".coverage-legend-dom");
    if (!domLegend) {
      domLegend = document.createElement("div");
      domLegend.className = "coverage-legend-dom";
      domLegend.style.position = "absolute";
      domLegend.style.top = "8px";
      domLegend.style.right = "8px";
      domLegend.style.background = "rgba(255,255,255,0.85)";
      domLegend.style.border = "1px dashed #cbd5e1";
      domLegend.style.borderRadius = "6px";
      domLegend.style.padding = "8px 10px";
      domLegend.style.font = '12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
      domLegend.style.color = "#111827";
      domLegend.style.pointerEvents = "none"; // ignore mouse
      wrap.appendChild(domLegend);
    }

    domLegend.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;white-space:nowrap;">
        <span style="display:inline-block;width:40px;border-top:2px dashed #e11d48;"></span>
        <span>Horizontal: coverage targets (80%, 90%)</span>
      </div>
      <div style="display:flex;align-items:center;gap:8px;white-space:nowrap;">
        <span style="display:inline-block;height:16px;border-left:2px dashed #e11d48;"></span>
        <span>Vertical: rank hitting targets (k at 80% = ${v80.toLocaleString()}, 90% = ${v90.toLocaleString()})</span>
      </div>
    `;
    // ------------------------------------------------------------------------
  } catch (err) {
    console.error("Coverage fetch failed:", err);
    document.getElementById("frequencyChart").innerHTML =
      "<p style='color:red'>❌ Failed to load coverage.</p>";
  }
};


async function renderCoverageForClass(rows, includeStopwords, minRank, maxRank, className) {
  // ✅ Prevent concurrent renders for the same class
  const renderKey = `coverage_${className}_${includeStopwords}`;
  if (window.currentCoverageRender === renderKey) {
    console.log("⏭️ Skipping duplicate Coverage render:", renderKey);
    return;
  }
  window.currentCoverageRender = renderKey;
  
  console.log(`🎯 Coverage render called for "${className}" - rows length: ${rows?.length || 0}`);
  
  const container = document.querySelector('.coverage-flex .class-tabs-content');
  if (!container) {
    console.error("❌ No .class-tabs-content found for coverage!");
    window.currentCoverageRender = null;
    return;
  }

  // ✅ Guard against empty data
  if (!rows || rows.length === 0) {
    console.warn("⚠️ No rows provided to renderCoverageForClass");
    container.innerHTML = `<div style='text-align:center;padding:40px;'>❌ No data available for coverage.</div>`;
    window.currentCoverageRender = null;
    return;
  }

  // ✅ Update title for "All Data"
  const displayLabel = className === "all" ? "All Data" : `Class ${className}`;
  container.innerHTML = `<h5 style="margin-top: 20px;text-align: center;">${displayLabel}</h5>`;

  const canvasWrapper = document.createElement('div');
  canvasWrapper.id = `coverageChart-${className}`;
  canvasWrapper.style.cssText = 'position: relative; width: 100%; height: 430px;';
  const canvas = document.createElement('canvas');
  canvasWrapper.appendChild(canvas);
  container.appendChild(canvasWrapper);

  try {
    const slim = (rows || []).map(t => (t || "").toString().slice(0, 2000));
    const freq = await postJSON("/api/word_frequency", {
      rows: slim,
      includeStopwords: !!includeStopwords
    });
    
    if (!Array.isArray(freq) || !freq.length) {
      canvasWrapper.innerHTML = "<div style='text-align:center;padding:40px;'>❌ No data for coverage.</div>";
      window.currentCoverageRender = null;
      return;
    }

    freq.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
    
    const vocabularySize = freq.length;
    const effectiveMaxRank = Math.min(maxRank, vocabularySize);
    
    const total = freq.reduce((acc, d) => acc + (d.frequency || 0), 0) || 1;
    let cum = 0;
    const points = [];
    
    for (let i = 0; i < freq.length; i++) {
      cum += (freq[i].frequency || 0);
      points.push({ x: i + 1, y: (cum / total) * 100 });
    }

    const rankAtCoverage = thr => {
      for (const p of points) if (p.y >= thr) return p.x;
      return points[points.length - 1].x;
    };

    const v80 = rankAtCoverage(80);
    const v90 = rankAtCoverage(90);

    const chartKey = `coverageChart_${className.replace(/[^a-zA-Z0-9]/g, '_')}`;
    if (window[chartKey] && typeof window[chartKey].destroy === "function") {
      window[chartKey].destroy();
    }

    const ctx = canvas.getContext("2d");
    window[chartKey] = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [{
          label: "Cumulative Coverage (%)",
          data: points,
          parsing: false,
          borderColor: "#2f80ed",
          borderWidth: 4,
          pointRadius: 0,
          tension: 0,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: true },
        plugins: {
          legend: { display: false },
          annotation: {
            annotations: {
              h80: { type: "line", yMin: 80, yMax: 80, borderColor: "red", borderWidth: 2, borderDash: [6,4] },
              h90: { type: "line", yMin: 90, yMax: 90, borderColor: "red", borderWidth: 2, borderDash: [6,4] },
              v80: { type: "line", xMin: v80, xMax: v80, borderColor: "red", borderWidth: 2, borderDash: [6,4] },
              v90: { type: "line", xMin: v90, xMax: v90, borderColor: "red", borderWidth: 2, borderDash: [6,4] }
            }
          },
          tooltip: { intersect: true, mode: "nearest" },
          title: { display: false }
        },
        elements: { point: { radius: 0, hitRadius: 12, hoverRadius: 4 } },
        scales: {

          x: { 
            type: "linear",
            title: { 
              display: true,
              text: "Word Rank",
              color: "#000",
              font: {
                size: 18,
                weight: "bold"
              }
            },
            min: +minRank,
            max: effectiveMaxRank
          },
        
          y: { 
            title: { 
              display: true,
              text: "Cumulative Coverage (%)",
              color: "#000",
              font: {
                size: 18,
                weight: "bold"
              }
            },
            min: 0,
            max: 100
          }
        
        }
      }
    });

    let domLegend = canvasWrapper.querySelector(".coverage-legend-dom");
    if (!domLegend) {
      domLegend = document.createElement("div");
      domLegend.className = "coverage-legend-dom";
      domLegend.style.cssText = `
        position: absolute; top: 8px; right: 8px;
        background: rgba(255,255,255,0.85); border: 1px dashed #cbd5e1;
        border-radius: 6px; padding: 8px 10px;
        font: 12px system-ui, sans-serif; color: #111827; pointer-events: none;
      `;
      canvasWrapper.appendChild(domLegend);
    }
    
    domLegend.innerHTML = `
      <div style="margin-bottom: 4px;"><strong>Legend</strong></div>
      <div style="margin: 3px 0;">🔴 Horizontal: coverage targets (80%, 90%)</div>
      <div style="margin: 3px 0;">🔴 Vertical: rank hitting targets (k₈₀ = ${v80.toLocaleString()}, k₉₀ = ${v90.toLocaleString()})</div>
      <div style="margin-top: 6px; font-size: 11px; color: #6b7280;">Vocabulary size: ${vocabularySize.toLocaleString()} words</div>
    `;
    
    // ✅ Clear the lock after successful render
    window.currentCoverageRender = null;
    
  } catch (err) {
    console.error("Coverage fetch failed:", err);
    canvasWrapper.innerHTML = "<div style='text-align:center;padding:40px;'>❌ Failed to load coverage.</div>";
    window.currentCoverageRender = null;
  }
}



// Re-render when the user changes range/stopwords/TopN
window.updateCoverageRange = function () {
  const min = parseInt(document.getElementById("minRank")?.value || "1", 10);
  const max = parseInt(document.getElementById("maxRank")?.value || "10000", 10);
  const includeStop = !!document.getElementById("includeStopwords")?.checked;
  
  // Check if we have labeled CSV data
  const hasLabels = Array.isArray(window.lastCSVData) && 
                    window.lastCSVData.length > 0 && 
                    window.lastCSVData[0].label !== undefined;
  
  console.log(`🔄 Updating coverage range: ${min}-${max}, Has labels: ${hasLabels}`);

  if (hasLabels) {
    // ✅ LABELED DATA: Use class tabs
    const activeTab = document.querySelector('#frequencyChart .class-tab.active');
    const className = activeTab ? activeTab.dataset.class : "all";
    
    console.log("🔍 Coverage update - Active class:", className);
    
    let textData;
    if (className === "all") {
      textData = window.lastCSVData.map(row => row.text || row.email || "");
    } else {
      // ✅ FIXED: Proper class filtering
      const targetClassNum = className.replace('label', '');
      const classData = window.lastCSVData.filter(row => {
        // Handle multi-label format
        if (row.labelNames && Array.isArray(row.labelNames)) {
          return row.labelNames.includes(className);
        }
        // Handle single label format
        const rowClass = row.class !== undefined ? row.class : row.label;
        return String(rowClass || 'Unlabeled') === targetClassNum;
      });
      textData = classData.map(row => row.text || row.email || "");
    }
    
    console.log("🔍 Coverage update - Data for class:", {
      className,
      dataCount: textData.length
    });
    
    if (textData.length > 0) {
      renderCoverageForClass(textData, includeStop, min, max, className);
    } else {
      console.warn("⚠️ No data found for class:", className);
    }
  } else {
    // ✅ UNLABELED DATA: Use getRowsForCharts()
    const rows = getRowsForCharts();
    
    console.log(`📊 Unlabeled data - rows count: ${rows.length}`);
    
    if (!rows || rows.length === 0) {
      console.warn("⚠️ No unlabeled data available");
      return;
    }
    
    // Use the unlabeled function
    window.generateCoverageChartServer(rows, includeStop, min, max);
  }
};


// Also refresh when “Top N Words” changes (if your backend uses it)
document.getElementById("wordLimit")?.addEventListener("change", () => {
  window.updateCoverageRange();
});





// Download Chart.js canvas as PNG (for Coverage plot)
function downloadCanvasAsPNG(canvasId, filename) {
  // Try multiple selectors to find the canvas
  let canvas = document.getElementById(canvasId);
  
  if (!canvas) {
    // Try finding canvas in frequencyChart container
    canvas = document.querySelector('#frequencyChart canvas');
  }
  
  if (!canvas) {
    // Try finding any canvas in coverage-flex
    canvas = document.querySelector('.coverage-flex canvas');
  }
  
  if (!canvas) {
    alert('❌ Canvas not found. Please ensure the chart is displayed.');
    console.error('Canvas not found. Tried selectors:', canvasId, '#frequencyChart canvas', '.coverage-flex canvas');
    return;
  }
  
  console.log('✅ Canvas found:', canvas);
  
  // Convert canvas to PNG and download
  canvas.toBlob(function(blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.download = filename;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// Download Coverage Chart (wrapper function)
function downloadCoverageChart() {
  downloadCanvasAsPNG('coverageChart', 'coverage-chart.png');
}

// Download SVG as PNG (for Zipf, Label Distribution, etc.)
function downloadSVGAsPNG(containerId, filename) {
  const container = document.getElementById(containerId);
  
  if (!container) {
    alert(`❌ Container #${containerId} not found.`);
    console.error('Container not found:', containerId);
    return;
  }
  
  const svg = container.querySelector('svg');
  
  if (!svg) {
    alert('❌ SVG not found in container. Please ensure the chart is displayed.');
    console.error('SVG not found in container:', containerId);
    return;
  }
  
  console.log('✅ SVG found:', svg);
  
  const serializer = new XMLSerializer();
  const svgString = serializer.serializeToString(svg);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const img = new Image();
  const svgBlob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  
  img.onload = function () {
    canvas.width = svg.width.baseVal.value || svg.clientWidth || 800;
    canvas.height = svg.height.baseVal.value || svg.clientHeight || 600;
    
    // Fill white background (optional)
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    
    const a = document.createElement("a");
    a.download = filename;
    a.href = canvas.toDataURL("image/png");
    a.click();
  };
  
  img.onerror = function(err) {
    console.error('Error loading SVG:', err);
    alert('❌ Failed to convert SVG to PNG.');
    URL.revokeObjectURL(url);
  };
  
  img.src = url;
}



let currentNERMethod = "both";
let currentNERText = "";

function updateNERMethod() {
    const selected = document.querySelector('input[name="nerMethod"]:checked');
    if (selected) {
        currentNERMethod = selected.value;
        // Automatically refresh NER when method changes
        if (currentNERText) {
            displayNER(currentNERText);
        }
    }
}

function refreshNER() {
    if (currentNERText) {
        displayNER(currentNERText);
    }
}

async function displayNER(text) {
  const container = document.getElementById("nerResults");
  container.innerHTML = "<em>Analyzing named entities...</em>";
  
  // Store current text for refresh
  currentNERText = text;
  
  try {
    // ✅ Use window.lastCSVData if available (handles multi-label properly)
    let textsToAnalyze = [];
    if (window.lastCSVData && window.lastCSVData.length > 0) {
      textsToAnalyze = window.lastCSVData.map(row => row.text || "").filter(Boolean);
      // Combine all texts for NER analysis
      text = textsToAnalyze.join("\n\n");
    }
    
    // Get selected method
    const method = currentNERMethod;
    
    // Show which method is being used while loading
    const methodNames = {
      'spacy': 'spaCy',
      'nltk': 'NLTK', 
      'both': 'spaCy + NLTK'
    };
    container.innerHTML = `<em>Analyzing named entities using ${methodNames[method]}...</em>`;
    
    const response = await fetch("/ner", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        text: text,
        ner_method: method  // Send method to backend
      })
    });
    
    const rawText = await response.text();
    let result = {};
    try { result = rawText ? JSON.parse(rawText) : {}; } catch { result = {}; }
    
    if (!response.ok) {
      const msg = (result && (result.detail || result.error)) || rawText || "NER request failed.";
      throw new Error(msg);
    }
    
    const raw = (result && result.entities) ? result.entities : [];
    
    // Update entity processing to handle source info if needed
    const entities = raw.map(e => ({
      type: e.type || e.label || e.label_ || "ENTITY",
      value: e.value || e.text || "",
      source: e.source || "unknown"  // Capture source for debugging if needed
    }));
    
    if (!entities.length) {
      let methodText = "";
      switch(method) {
        case "spacy": methodText = "spaCy"; break;
        case "nltk": methodText = "NLTK"; break;
        default: methodText = "spaCy + NLTK";
      }
      container.innerHTML = `<i>No named entities found using ${methodText}.</i>`;
      return;
    }
    
    // Rest of your existing grouping and display code remains the same...
    const grouped = {
      'ORG': [],
      'PERSON': [],
      'GPE': [],
      'DATE': [],
      'CARDINAL_MONEY': [],
      'LOC': [],
      'FACILITY': [],
      'PRODUCT': [],
      'EVENT': [],
      'OTHER': []
    };
    
    entities.forEach(e => {
      const type = e.type.toUpperCase();
      if (type.includes('ORG')) {
        grouped.ORG.push(e.value);
      } else if (type.includes('PERSON') || type === 'PER') {
        grouped.PERSON.push(e.value);
      } else if (type.includes('GPE')) {
        grouped.GPE.push(e.value);
      } else if (type.includes('DATE') || type.includes('TIME')) {
        grouped.DATE.push(e.value);
      } else if (type.includes('CARDINAL') || type.includes('MONEY') || type.includes('PERCENT') || type.includes('QUANTITY')) {
        grouped.CARDINAL_MONEY.push(e.value);
      } else if (type.includes('LOC') && !type.includes('GPE')) {
        grouped.LOC.push(e.value);
      } else if (type.includes('FAC')) {
        grouped.FACILITY.push(e.value);
      } else if (type.includes('PRODUCT')) {
        grouped.PRODUCT.push(e.value);
      } else if (type.includes('EVENT')) {
        grouped.EVENT.push(e.value);
      } else {
        grouped.OTHER.push(e.value);
      }
    });
    
    const activeColumns = [];
    const columnData = [];
    const allColumns = [
      { key: 'ORG', label: 'Organization' },
      { key: 'PERSON', label: 'Person' },
      { key: 'GPE', label: 'Location (GPE)' },
      { key: 'DATE', label: 'Date/Time' },
      { key: 'CARDINAL_MONEY', label: 'Cardinal/Money' },
      { key: 'LOC', label: 'Location' },
      { key: 'FACILITY', label: 'Facility' },
      { key: 'PRODUCT', label: 'Product' },
      { key: 'EVENT', label: 'Event' }
    ];
    
    allColumns.forEach(col => {
      if (grouped[col.key].length > 0) {
        const countMap = {};
        grouped[col.key].forEach(item => {
          countMap[item] = (countMap[item] || 0) + 1;
        });
        
        const deduped = Object.entries(countMap).map(([value, count]) => {
          return count > 1 ? `${value} (×${count})` : value;
        });
        
        activeColumns.push(col);
        columnData.push(deduped);
      }
    });
    
    if (activeColumns.length === 0) {
      let methodText = "";
      switch(method) {
        case "spacy": methodText = "spaCy"; break;
        case "nltk": methodText = "NLTK"; break;
        default: methodText = "spaCy + NLTK";
      }
      container.innerHTML = `<i>No named entities found using ${methodText}.</i>`;
      return;
    }
    
    const maxRows = Math.max(...columnData.map(col => col.length));
    
    // Update title to show method used
    let methodDisplay = "";
    switch(method) {
      case "spacy": methodDisplay = " (spaCy)"; break;
      case "nltk": methodDisplay = " (NLTK)"; break;
      default: methodDisplay = " (spaCy + NLTK)";
    }
    
    let tableHTML = `
      <details class="ner-block" open>
        <summary style="font-weight:bold; color:#0074cc; font-size: 1.1em; cursor: pointer; padding: 10px; background: #f9f9f9; border-radius: 6px;">
          Named Entity Recognition${methodDisplay} - ${entities.length} entities found
        </summary>
        <div style="max-height: 400px; overflow-y: auto; overflow-x: hidden; margin-top: 15px; border: 1px solid #ddd; border-radius: 6px;">
          <table style="width: 100%; border-collapse: collapse; table-layout: fixed;">
            <thead style="position: sticky; top: 0; background: #0074cc; z-index: 10;">
              <tr>`;
    
    activeColumns.forEach(col => {
      tableHTML += `<th style="padding: 8px; border-bottom: 2px solid #ddd; text-align: left; font-weight: 700; color: white; word-wrap: break-word; white-space: normal;">${col.label}</th>`;
    });
    
    tableHTML += `
              </tr>
            </thead>
            <tbody>`;
    
    for (let i = 0; i < maxRows; i++) {
      tableHTML += '<tr style="transition: background 0.2s;" onmouseover="this.style.background=\'#f5f5f5\'" onmouseout="this.style.background=\'white\'">';
      columnData.forEach(colData => {
        const value = colData[i] || '';
        tableHTML += `<td style="padding: 8px; border-bottom: 1px solid #eee; word-wrap: break-word; white-space: normal;">${value}</td>`;
      });
      tableHTML += '</tr>';
    }
    
    tableHTML += `
            </tbody>
          </table>
        </div>
      </details>`;
    
    container.innerHTML = tableHTML;
  } catch (error) {
    container.innerHTML = `<span style="color:red;">Error: ${error.message}</span>`;
    console.error("NER error:", error);
  }
}

function displayClassification(text) {
  const container = document.getElementById("classification");
  
  // ✅ FIXED: Check for ANY label format, not just numeric
  const hasLabels = /^\[([^\]]+)\]/m.test(text);
  
  if (hasLabels) {
    const classSet = new Set();
    const lines = text.split(/\n+/);
    const classDistribution = {};
    
    // Analyze class distribution
    lines.forEach(line => {
      // ✅ FIXED: Capture any text in brackets, not just digits
      const match = line.match(/^\[([^\]]+)\]/);
      if (match) {
        const labelPart = match[1];
        
        // Handle multi-label format (labels separated by +)
        if (labelPart.includes('+')) {
          const labels = labelPart.split('+').map(l => l.trim());
          labels.forEach(label => {
            classSet.add(label);
            classDistribution[label] = (classDistribution[label] || 0) + 1;
          });
        } else {
          // Single label
          classSet.add(labelPart);
          classDistribution[labelPart] = (classDistribution[labelPart] || 0) + 1;
        }
      }
    });
    
    const classCount = classSet.size;
    const totalDocuments = lines.filter(line => /^\[([^\]]+)\]/m.test(line)).length;
    
    const classificationType = classCount === 2 ? "Binary Classification" : 
                              classCount > 2 ? "Multi-class Classification" : 
                              "Single Class";
    
    const maxCount = Math.max(...Object.values(classDistribution));
    
    // Create professional classification display
    container.innerHTML = `
      <details class="classification-section">
        <summary style="font-weight:bold; color:#0074cc; font-size: 1.1em; cursor: pointer; padding: 10px; background: #f9f9f9; border-radius: 6px;">
          Classification - ${classCount} Class${classCount === 1 ? "" : "es"} Detected
        </summary>
        <div style="max-height: 700px; overflow-y: auto; padding: 1.5rem; margin-top: 10px;">
          <div class="classification-card">
            <div class="classification-header">
              <div class="classification-badge">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                Document Classification
              </div>
              <div class="classification-status labeled">
                ${classificationType}
              </div>
            </div>
            <div class="classification-content">
              <div class="classification-summary">
                <div class="summary-item">
                  <div class="summary-value">${classCount}</div>
                  <div class="summary-label">Classes</div>
                </div>
                <div class="summary-item">
                  <div class="summary-value">${totalDocuments}</div>
                  <div class="summary-label">Documents</div>
                </div>
                <div class="summary-item">
                  <div class="summary-value">${Math.round(totalDocuments / classCount)}</div>
                  <div class="summary-label">Avg per Class</div>
                </div>
              </div>
              <div class="class-distribution">
                <h4>Class Distribution</h4>
                ${createDistributionChart(classDistribution, totalDocuments, maxCount)}
              </div>
              <div class="classification-details">
                <div class="detail-item">
                  <span class="detail-label">Dataset Type:</span>
                  <span class="detail-value">${classificationType}</span>
                </div>
                <div class="detail-item">
                  <span class="detail-label">Analysis:</span>
                  <span class="detail-value">Ready for Predictive Modeling</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </details>
    `;
  } else {
    // Unlabeled document display (unchanged)
    container.innerHTML = `
      <details class="classification-section">
        <summary style="font-weight: bold; font-size: 1.2em; cursor: pointer; padding: 12px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; color: #1e40af;">
          Classification - No Labels Detected
        </summary>
        <div style="max-height: 700px; overflow-y: auto; padding: 1.5rem; margin-top: 10px;">
          <div class="classification-card">
            <div class="classification-header">
              <div class="classification-badge">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/>
                </svg>
                Document Classification
              </div>
              <div class="classification-status unlabeled">
                Unlabeled Document
              </div>
            </div>
            <div class="classification-content">
              <div class="unlabeled-message">
                <div class="message-icon">📝</div>
                <div class="message-content">
                  <h4>Single Document Analysis</h4>
                  <p>This document is not labeled for classification. To perform predictive modeling, upload a labeled dataset with multiple classes.</p>
                </div>
              </div>
              <div class="classification-actions">
                <button class="btn btn-secondary" onclick="showUploadHelp()">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 16v-4m0 8h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10z"/>
                  </svg>
                  Upload Requirements
                </button>
              </div>
            </div>
          </div>
        </div>
      </details>
    `;
  }
}

// ✅ FIXED: Bar scaling function - no class gets full width
function createDistributionChart(distribution, total, maxCount) {
  const classes = Object.keys(distribution).sort();
  
  return `
    <div class="distribution-chart">
      ${classes.map(className => {
        const count = distribution[className];
        const percentage = ((count / total) * 100).toFixed(1);
        // ✅ FIXED: Scale bars relative to the largest class, but cap at 90% for visual clarity
        const width = Math.min(90, (count / maxCount) * 90);
        
        return `
          <div class="distribution-item">
            <div class="distribution-label">
              <span class="class-name">Class ${className}</span>
              <span class="class-stats">${count} (${percentage}%)</span>
            </div>
            <div class="distribution-bar">
              <div class="bar-fill" style="width: ${width}%"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Helper function for upload requirements
function showUploadHelp() {
  alert(`📋 Upload Requirements for Classification:
  
• CSV file with at least 2 columns
• One column for text content
• One column for class labels
• Minimum 10 documents per class
• Supported formats: CSV, XLSX

Example structure:
text,label
"This is spam email",spam
"This is normal email",ham
  `);
}


function drawZipfPlot(data, opts = {}) {
  // === options you can tweak ===
  const fitStartRank = +opts.fitStartRank || 50;
  const fitEndRank   = +opts.fitEndRank   || 5000;
  const showTopDots  = opts.showTopDots ?? true;
  const coverageSteps = opts.coverageSteps || [50, 80, 90];

  // --- sanitize ---
  data = (data || [])
    .map(d => ({ rank:+d.rank, freq:+d.freq }))
    .filter(d => d.rank > 0 && d.freq > 0 && Number.isFinite(d.rank) && Number.isFinite(d.freq))
    .sort((a,b) => a.rank - b.rank);

  const root = d3.select("#zipfPlot");
  root.html("");

  if (!data.length) {
    root.append("div").style("color","crimson").text("❌ No valid data for Zipf plot (check /api/zipf).");
    return;
  }
  
  // ✅ Get container dimensions dynamically
  const containerEl = root.node();
  const containerWidth = containerEl.clientWidth || 1250;
  
  // ---- layout ----
  const margin = { top: 40, right: 40, bottom: 70, left: 80 };
  const width  = containerWidth - margin.left - margin.right;
  const height = 520 - margin.top - margin.bottom;

  // ✅ Create responsive SVG
  const svg = root.append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("display", "block")
    .style("max-width", "100%");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  // ---- title inside SVG ----
  g.append("text")
    .attr("x", width/2).attr("y", -8)
    .attr("text-anchor", "middle")
    .attr("font-weight", 600)
    .attr("font-size", 14)
    .text("Zipf's Law (log–log rank vs. frequency)");

  // ---- scales & axes ----
  const x = d3.scaleLog().domain([1, d3.max(data, d => d.rank)]).range([0, width]);
  const y = d3.scaleLog().domain([1, d3.max(data, d => d.freq)]).range([height, 0]);

  g.append("g").call(d3.axisLeft(y).ticks(6, "~s"));
  g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(6, "~s"));

  g.append("text").attr("x", width/2).attr("y", height+36).attr("text-anchor","middle").attr("font-size", 12).text("Log(Rank)");
  g.append("text").attr("transform","rotate(-90)").attr("x",-height/2).attr("y",-44).attr("text-anchor","middle").attr("font-size", 12).text("Log(Frequency)");

  // ---- main curve ----
  const line = d3.line().x(d => x(d.rank)).y(d => y(d.freq));
  g.append("path").datum(data).attr("fill","none").attr("stroke","#1e90ff").attr("stroke-width",2.5).attr("d", line);

  // ---- cumulative coverage (for markers) ----
  const totalTokens = d3.sum(data, d => d.freq);
  let cum = 0;
  const withCum = data.map(d => { cum += d.freq; return { ...d, cumPct: 100*(cum/totalTokens) }; });
  const rankAtCoverage = t => (withCum.find(d => d.cumPct >= t) || withCum[withCum.length-1]).rank;

  // coverage ticks near the x-axis
  const covGroup = g.append("g").attr("class", "coverage-markers");
  coverageSteps.forEach(step => {
    const r = rankAtCoverage(step);
    covGroup.append("line")
      .attr("x1", x(r)).attr("x2", x(r))
      .attr("y1", height - 18).attr("y2", height)
      .attr("stroke", "#9ca3af").attr("stroke-dasharray", "4,4").attr("stroke-width", 1);
    covGroup.append("text")
      .attr("x", x(r)).attr("y", height - 22).attr("text-anchor", "middle")
      .attr("font-size", 10).attr("fill", "#6b7280").text(`${step}%`);
  });

  // ---- hapax (freq == 1) ----
  const hapaxCount = data.filter(d => d.freq === 1).length;
  const hapaxPctTypes = 100 * (hapaxCount / data.length);
  const hapax = data.find(d => d.freq === 1);
  let hapaxRank = null;
  if (hapax) {
    hapaxRank = hapax.rank;
    g.append("line")
      .attr("x1", x(hapaxRank)).attr("x2", x(hapaxRank))
      .attr("y1", 0).attr("y2", height)
      .attr("stroke", "#ef4444")
      .attr("stroke-dasharray", "6,4")
      .attr("stroke-width", 1.5)
      .attr("opacity", 0.6);
  }

  // ---- least-squares fit on log10 space within [fitStartRank, fitEndRank] ----
  const start = Math.max(+fitStartRank, 1);
  const end   = Math.min(+fitEndRank, data[data.length-1].rank);
  const fitData = data.filter(d => d.rank >= start && d.rank <= end);

  const log10 = v => Math.log10(v);
  let a=NaN,b=NaN,r2=NaN;
  if (fitData.length >= 3) {
    const xs = fitData.map(d => log10(d.rank));
    const ys = fitData.map(d => log10(d.freq));
    const n  = xs.length;
    const xbar = d3.mean(xs), ybar = d3.mean(ys);
    const Sxx = d3.sum(xs, x => (x-xbar)**2);
    const Sxy = d3.sum(d3.range(n), i => (xs[i]-xbar)*(ys[i]-ybar));
    b = Sxy / Sxx;
    a = ybar - b*xbar;

    const yhat = xs.map(xi => a + b*xi);
    const SSE  = d3.sum(d3.range(n), i => (ys[i]-yhat[i])**2);
    const SST  = d3.sum(ys, yi => (yi-ybar)**2);
    r2 = 1 - SSE/SST;

    // fit line
    const fitX1 = start, fitX2 = end;
    const fitY1 = 10 ** (a + b*log10(fitX1));
    const fitY2 = 10 ** (a + b*log10(fitX2));
    g.append("line")
      .attr("x1", x(fitX1)).attr("x2", x(fitX2))
      .attr("y1", y(fitY1)).attr("y2", y(fitY2))
      .attr("stroke", "#111").attr("stroke-width", 2).attr("stroke-dasharray", "6,4");

    // fit window markers
    g.append("line")
      .attr("x1", x(start)).attr("x2", x(start))
      .attr("y1", 0).attr("y2", height)
      .attr("stroke", "#6b7280").attr("stroke-dasharray", "4,4").attr("opacity", 0.7);

    g.append("line")
      .attr("x1", x(end)).attr("x2", x(end))
      .attr("y1", 0).attr("y2", height)
      .attr("stroke", "#6b7280").attr("stroke-dasharray", "4,4").attr("opacity", 0.7);
  }

  // ---- optional top-k dots ----
  if (showTopDots) {
    [1,10,100].forEach(k => {
      const d = data.find(d => d.rank === k);
      if (!d) return;
      g.append("circle").attr("cx", x(d.rank)).attr("cy", y(d.freq))
        .attr("r", 3.5).attr("fill", "#1e90ff").attr("stroke", "#fff").attr("stroke-width", 1);
    });
  }

  // ---- tooltip along the curve ----
  const tipContainer = d3.select(root.node().parentElement);
  tipContainer.style("position","relative");
  const tip = tipContainer.append("div")
    .attr("class","zipf-tip")
    .style("position","absolute").style("pointer-events","none")
    .style("background","rgba(17,24,39,0.9)").style("color","#fff")
    .style("padding","6px 8px").style("border-radius","6px")
    .style("font-size","12px").style("opacity",0).style("z-index", 1000);

  g.append("path").datum(data).attr("fill","none").attr("stroke","transparent").attr("stroke-width",16).attr("d", line)
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const rankGuess = x.invert(mx);
      const idx = d3.bisector(d => d.rank).left(data, rankGuess);
      const i = Math.max(0, Math.min(data.length-1, idx));
      const d = data[i];
      tip
        .style("left", `${event.offsetX+12}px`)
        .style("top",  `${event.offsetY-24}px`)
        .style("opacity", 1)
        .html(
          `<div><b>rank</b> ${d.rank.toLocaleString()}</div>
           <div><b>freq</b> ${d.freq.toLocaleString()}</div>
           <div><b>rel%</b> ${(100*d.freq/totalTokens).toFixed(3)}%</div>
           <div><b>cum%</b> ${withCum[i].cumPct.toFixed(2)}%</div>`
        );
    })
    .on("mouseleave", () => tip.style("opacity", 0));

  // ================= DOM LEGEND (outside the chart, top-right) =================
  const legendContainerEl =
    document.getElementById("zipfContainer") ||
    root.node().closest(".viz-box") ||
    root.node().parentElement;
  
  if (getComputedStyle(legendContainerEl).position === "static") {
    legendContainerEl.style.position = "relative";
  }
  
  legendContainerEl.querySelectorAll(".zipf-legend-dom").forEach(n => n.remove());
  
  const legend = document.createElement("div");
  legend.className = "zipf-legend-dom";
  Object.assign(legend.style, {
    position: "absolute",
    top: "6px",
    right: "8px",
    maxWidth: "560px",
    background: "rgba(255,255,255,0.95)",
    border: "1px dashed #cbd5e1",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "12px",
    lineHeight: "1.35",
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    zIndex: 10
  });
  
  const tokens = totalTokens.toLocaleString();
  const types  = data.length.toLocaleString();
  const ttr    = (data.length / totalTokens).toFixed(3);
  const herdan = (Math.log(data.length) / Math.log(totalTokens)).toFixed(3);
  const slopeB = Number.isFinite(b)  ? b.toFixed(3)  : "n/a";
  const expoS  = Number.isFinite(b)  ? (-b).toFixed(3) : "n/a";
  const r2txt  = Number.isFinite(r2) ? r2.toFixed(3) : "n/a";
  const k50    = rankAtCoverage(50).toLocaleString();
  const k80    = rankAtCoverage(80).toLocaleString();
  const k90    = rankAtCoverage(90).toLocaleString();
  
  legend.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;">How to read this chart</div>
  
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:36px;height:0;border-top:3px solid #1e90ff;display:inline-block;"></span>
      <span><b>Blue line</b>: empirical log–log curve of word frequency vs. rank.</span>
    </div>
  
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:36px;height:0;border-top:2px dashed #111;display:inline-block;"></span>
      <span><b>Black dashed</b>: least-squares Zipf fit on ranks <b>${fitStartRank}</b>–<b>${fitEndRank}</b>
        (slope <b>b=${slopeB}</b>, exponent <b>s=${expoS}</b>, R²=<b>${r2txt}</b>).</span>
    </div>
  
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:0;height:16px;border-left:2px dashed #e11d48;display:inline-block;"></span>
      <span><b>Red dashed</b>: hapax cutoff — first rank where frequency = 1${
        hapaxRank ? ` (rank <b>${hapaxRank.toLocaleString()}</b>; ${hapaxCount.toLocaleString()} types, ${hapaxPctTypes.toFixed(1)}% of vocabulary).` : "."
      }</span>
    </div>
  
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:0;height:16px;border-left:2px dashed #6b7280;display:inline-block;"></span>
      <span><b>Gray dashed</b>: boundaries of the fit window. Bottom ticks mark coverage:
        k<sub>50</sub>=${k50}, k<sub>80</sub>=${k80}, k<sub>90</sub>=${k90}.</span>
    </div>
  
    <hr style="border:none;border-top:1px dotted #e5e7eb;margin:8px 0;">
    <div><b>Corpus</b>: Tokens N=${tokens}; Types V=${types}; TTR=${ttr}; Herdan C=${herdan}</div>
  `;
  
  legendContainerEl.appendChild(legend);
}

async function generateZipfPlotServer(rows, includeStopwords = true) {
  try {
    const data = await getJSON(api("/api/zipf"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows, includeStopwords })
    });
    drawZipfPlot(data);
  } catch (err) {
    console.error("Zipf plot fetch failed:", err);
    d3.select("#zipfPlot").html("<p style='color:red'>❌ Failed to load Zipf plot. Check /api/zipf in Network tab.</p>");
  }
}

async function renderZipfForClass(rows, includeStopwords, className) {
  // ✅ Prevent concurrent renders for the same class
  const renderKey = `zipf_${className}_${includeStopwords}`;
  if (window.currentZipfRender === renderKey) {
    console.log("⏭️ Skipping duplicate Zipf render:", renderKey);
    return;
  }
  window.currentZipfRender = renderKey;
  
  console.log(`🎯 Zipf render called for "${className}" - rows length: ${rows?.length || 0}`);
  
  const container = document.querySelector('.zipf-flex .class-tabs-content');
  if (!container) {
    console.error("❌ No .class-tabs-content found for Zipf!");
    window.currentZipfRender = null;
    return;
  }
  
  // ✅ Guard against empty data
  if (!rows || rows.length === 0) {
    console.warn("⚠️ No rows provided to renderZipfForClass");
    container.innerHTML = `<div style='text-align:center;padding:40px;'>❌ No data available for Zipf plot.</div>`;
    window.currentZipfRender = null;
    return;
  }

  // ✅ Update title for "All Data"
  const displayLabel = className === "all" ? "All Data" : `Class ${className}`;
  container.innerHTML = `<h5 style="margin-top: 20px;text-align: center;">${displayLabel}</h5>`;
  
  const plotWrapper = document.createElement('div');
  plotWrapper.id = `zipfPlot-${className}`;
  // ✅ CRITICAL: Set width to 100% to fill the container
  plotWrapper.style.cssText = 'position: relative; width: 100%; min-height: 650px;';
  container.appendChild(plotWrapper);

  try {
    const slim = (rows || []).map(row => {
  // Case 1: Row is already a string
  if (typeof row === 'string') {
    return row.slice(0, 2000);
  }
  
  // Case 2: Row is an object (CSV or multi-binary format)
  if (row && typeof row === 'object') {
    // Try to extract text from common field names
    // For CSV: usually has 'text', 'email', 'Message' fields  
    // For multi-binary from coerce_docs: has 'text' field
    const text = row.text || row.email || row.Message || 
                 row.content || row.body || row.message ||
                 (row.data && row.data.text) || '';
    
    // If text is an object, try to stringify it
    if (text && typeof text === 'object') {
      return JSON.stringify(text).slice(0, 2000);
    }
    
    return String(text || '').slice(0, 2000);
  }
  
  // Case 3: Fallback
  return String(row || '').slice(0, 2000);
}).filter(text => text.trim().length > 0);
    const freq = await postJSON("/api/word_frequency", {
      rows: slim,
      includeStopwords: !!includeStopwords
    });

    if (!Array.isArray(freq) || !freq.length) {
      plotWrapper.innerHTML = "<div style='text-align:center;padding:40px;'>❌ No data for Zipf plot.</div>";
      window.currentZipfRender = null;
      return;
    }

    freq.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
    const zipfData = freq.map((item, index) => ({
      rank: index + 1,
      freq: item.frequency || 0
    }));

    const vocabularySize = freq.length;
    const fitEndRank = Math.min(5000, vocabularySize);

    drawZipfPlotForClass(zipfData, plotWrapper, className, {
      fitStartRank: 50,
      fitEndRank: fitEndRank,
      showTopDots: true,
      coverageSteps: [50, 80, 90]
    });
    
    window.currentZipfRender = null;
  } catch (err) {
    console.error("Zipf fetch failed:", err);
    plotWrapper.innerHTML = "<div style='text-align:center;padding:40px;'>❌ Failed to load Zipf plot.</div>";
    window.currentZipfRender = null;
  }
}

function drawZipfPlotForClass(data, containerElement, className, opts = {}) {
  const fitStartRank = +opts.fitStartRank || 50;
  const fitEndRank   = +opts.fitEndRank   || 5000;
  const showTopDots  = opts.showTopDots ?? true;
  const coverageSteps = opts.coverageSteps || [50, 80, 90];

  data = (data || [])
    .map(d => ({ rank:+d.rank, freq:+d.freq }))
    .filter(d => d.rank > 0 && d.freq > 0 && Number.isFinite(d.rank) && Number.isFinite(d.freq))
    .sort((a,b) => a.rank - b.rank);

  const root = d3.select(containerElement);
  root.html("");

  if (!data.length) {
    root.append("div").style("color","crimson").text("❌ No valid data for Zipf plot.");
    return;
  }
  
  // ✅ Get PARENT container dimensions for full width
  const parentContainer = containerElement.parentElement;
  const containerWidth = containerElement.clientWidth || 1250;
  
  console.log(`📐 Zipf plot container width: ${containerWidth}px`);
  
  const margin = { top: 28, right: 22, bottom: 46, left: 56 };
  const width  = containerWidth - margin.left - margin.right - 60;
  const height = 430 - margin.top - margin.bottom;

  const svg = root.append("svg")
    .attr("width", "100%")
    .attr("height", height + margin.top + margin.bottom)
    .attr("viewBox", `0 0 ${width + margin.left + margin.right} ${height + margin.top + margin.bottom}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("display", "block")
    .style("max-width", "100%");

  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  g.append("text")
    .attr("x", width/2).attr("y", -8)
    .attr("text-anchor", "middle")
    .attr("font-weight", 600)
    .attr("font-size", 14)
    .text("Zipf's Law (log–log rank vs. frequency)");

  const x = d3.scaleLog().domain([1, d3.max(data, d => d.rank)]).range([0, width]);
  const y = d3.scaleLog().domain([1, d3.max(data, d => d.freq)]).range([height, 0]);

  g.append("g").call(d3.axisLeft(y).ticks(6, "~s"));
  g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(6, "~s"));

  g.append("text")
    .attr("x", width/2)
    .attr("y", height + 38)
    .attr("text-anchor","middle")
    .attr("font-size", 18)
    .attr("font-weight","bold")
    .attr("fill","#000")
    .text("Log(Rank)");

  g.append("text")
    .attr("transform","rotate(-90)")
    .attr("x",-height/2)
    .attr("y",-48)
    .attr("text-anchor","middle")
    .attr("font-size", 18)
    .attr("font-weight","bold")
    .attr("fill","#000")
    .text("Log(Frequency)");
  
  
  const line = d3.line().x(d => x(d.rank)).y(d => y(d.freq));
  g.append("path").datum(data).attr("fill","none").attr("stroke","#1e90ff").attr("stroke-width",2.5).attr("d", line);

  const totalTokens = d3.sum(data, d => d.freq);
  let cum = 0;
  const withCum = data.map(d => { cum += d.freq; return { ...d, cumPct: 100*(cum/totalTokens) }; });
  const rankAtCoverage = t => (withCum.find(d => d.cumPct >= t) || withCum[withCum.length-1]).rank;

  const covGroup = g.append("g").attr("class", "coverage-markers");
  coverageSteps.forEach(step => {
    const r = rankAtCoverage(step);
    covGroup.append("line")
      .attr("x1", x(r)).attr("x2", x(r))
      .attr("y1", height - 18).attr("y2", height)
      .attr("stroke", "#9ca3af").attr("stroke-dasharray", "4,4").attr("stroke-width", 1);
    covGroup.append("text")
      .attr("x", x(r)).attr("y", height - 22).attr("text-anchor", "middle")
      .attr("font-size", 10).attr("fill", "#6b7280").text(`${step}%`);
  });

  const hapaxCount = data.filter(d => d.freq === 1).length;
  const hapaxPctTypes = 100 * (hapaxCount / data.length);
  const hapax = data.find(d => d.freq === 1);
  let hapaxRank = null;
  if (hapax) {
    hapaxRank = hapax.rank;
    g.append("line")
      .attr("x1", x(hapaxRank)).attr("x2", x(hapaxRank))
      .attr("y1", 0).attr("y2", height)
      .attr("stroke", "#ef4444")
      .attr("stroke-dasharray", "6,4")
      .attr("stroke-width", 1.5)
      .attr("opacity", 0.6);
  }

  const start = Math.max(+fitStartRank, 1);
  const end   = Math.min(+fitEndRank, data[data.length-1].rank);
  const fitData = data.filter(d => d.rank >= start && d.rank <= end);

  const log10 = v => Math.log10(v);
  let a=NaN,b=NaN,r2=NaN;
  if (fitData.length >= 3) {
    const xs = fitData.map(d => log10(d.rank));
    const ys = fitData.map(d => log10(d.freq));
    const n  = xs.length;
    const xbar = d3.mean(xs), ybar = d3.mean(ys);
    const Sxx = d3.sum(xs, x => (x-xbar)**2);
    const Sxy = d3.sum(d3.range(n), i => (xs[i]-xbar)*(ys[i]-ybar));
    b = Sxy / Sxx;
    a = ybar - b*xbar;

    const yhat = xs.map(xi => a + b*xi);
    const SSE  = d3.sum(d3.range(n), i => (ys[i]-yhat[i])**2);
    const SST  = d3.sum(ys, yi => (yi-ybar)**2);
    r2 = 1 - SSE/SST;

    const fitX1 = start, fitX2 = end;
    const fitY1 = 10 ** (a + b*log10(fitX1));
    const fitY2 = 10 ** (a + b*log10(fitX2));
    g.append("line")
      .attr("x1", x(fitX1)).attr("x2", x(fitX2))
      .attr("y1", y(fitY1)).attr("y2", y(fitY2))
      .attr("stroke", "#111").attr("stroke-width", 2).attr("stroke-dasharray", "6,4");

    g.append("line")
      .attr("x1", x(start)).attr("x2", x(start))
      .attr("y1", 0).attr("y2", height)
      .attr("stroke", "#6b7280").attr("stroke-dasharray", "4,4").attr("opacity", 0.7);

    g.append("line")
      .attr("x1", x(end)).attr("x2", x(end))
      .attr("y1", 0).attr("y2", height)
      .attr("stroke", "#6b7280").attr("stroke-dasharray", "4,4").attr("opacity", 0.7);
  }

  if (showTopDots) {
    [1,10,100].forEach(k => {
      const d = data.find(d => d.rank === k);
      if (!d) return;
      g.append("circle").attr("cx", x(d.rank)).attr("cy", y(d.freq))
        .attr("r", 3.5).attr("fill", "#1e90ff").attr("stroke", "#fff").attr("stroke-width", 1);
    });
  }

  const tipContainer = d3.select(containerElement.parentElement);
  tipContainer.style("position","relative");
  const tip = tipContainer.append("div")
    .attr("class","zipf-tip")
    .style("position","absolute").style("pointer-events","none")
    .style("background","rgba(17,24,39,0.9)").style("color","#fff")
    .style("padding","6px 8px").style("border-radius","6px")
    .style("font-size","12px").style("opacity",0).style("z-index", 1000);

  g.append("path").datum(data).attr("fill","none").attr("stroke","transparent").attr("stroke-width",16).attr("d", line)
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event);
      const rankGuess = x.invert(mx);
      const idx = d3.bisector(d => d.rank).left(data, rankGuess);
      const i = Math.max(0, Math.min(data.length-1, idx));
      const d = data[i];
      tip
        .style("left", `${event.offsetX+12}px`)
        .style("top",  `${event.offsetY-24}px`)
        .style("opacity", 1)
        .html(
          `<div><b>rank</b> ${d.rank.toLocaleString()}</div>
           <div><b>freq</b> ${d.freq.toLocaleString()}</div>
           <div><b>rel%</b> ${(100*d.freq/totalTokens).toFixed(3)}%</div>
           <div><b>cum%</b> ${withCum[i].cumPct.toFixed(2)}%</div>`
        );
    })
    .on("mouseleave", () => tip.style("opacity", 0));

  const legendContainerEl = containerElement.parentElement;
  
  if (getComputedStyle(legendContainerEl).position === "static") {
    legendContainerEl.style.position = "relative";
  }
  
  legendContainerEl.querySelectorAll(".zipf-legend-dom").forEach(n => n.remove());
  
  const legend = document.createElement("div");
  legend.className = "zipf-legend-dom";
  Object.assign(legend.style, {
    position: "absolute",
    top: "6px",
    right: "8px",
    maxWidth: "560px",
    background: "rgba(255,255,255,0.95)",
    border: "1px dashed #cbd5e1",
    borderRadius: "8px",
    padding: "10px 12px",
    fontSize: "12px",
    lineHeight: "1.35",
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
    zIndex: 10
  });
  
  const tokens = totalTokens.toLocaleString();
  const types  = data.length.toLocaleString();
  const ttr    = (data.length / totalTokens).toFixed(3);
  const herdan = (Math.log(data.length) / Math.log(totalTokens)).toFixed(3);
  const slopeB = Number.isFinite(b)  ? b.toFixed(3)  : "n/a";
  const expoS  = Number.isFinite(b)  ? (-b).toFixed(3) : "n/a";
  const r2txt  = Number.isFinite(r2) ? r2.toFixed(3) : "n/a";
  const k50    = rankAtCoverage(50).toLocaleString();
  const k80    = rankAtCoverage(80).toLocaleString();
  const k90    = rankAtCoverage(90).toLocaleString();
  
  legend.innerHTML = `
    <div style="font-weight:600;margin-bottom:6px;">How to read this chart</div>
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:36px;height:0;border-top:3px solid #1e90ff;display:inline-block;"></span>
      <span><b>Blue line</b>: empirical log–log curve of word frequency vs. rank.</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:36px;height:0;border-top:2px dashed #111;display:inline-block;"></span>
      <span><b>Black dashed</b>: least-squares Zipf fit on ranks <b>${fitStartRank}</b>–<b>${fitEndRank}</b>
        (slope <b>b=${slopeB}</b>, exponent <b>s=${expoS}</b>, R²=<b>${r2txt}</b>).</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:0;height:16px;border-left:2px dashed #e11d48;display:inline-block;"></span>
      <span><b>Red dashed</b>: hapax cutoff — first rank where frequency = 1${
        hapaxRank ? ` (rank <b>${hapaxRank.toLocaleString()}</b>; ${hapaxCount.toLocaleString()} types, ${hapaxPctTypes.toFixed(1)}% of vocabulary).` : "."
      }</span>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:4px 0;">
      <span style="width:0;height:16px;border-left:2px dashed #6b7280;display:inline-block;"></span>
      <span><b>Gray dashed</b>: boundaries of the fit window. Bottom ticks mark coverage:
        k<sub>50</sub>=${k50}, k<sub>80</sub>=${k80}, k<sub>90</sub>=${k90}.</span>
    </div>
    <hr style="border:none;border-top:1px dotted #e5e7eb;margin:8px 0;">
    <div><b>Corpus</b>: Tokens N=${tokens}; Types V=${types}; TTR=${ttr}; Herdan C=${herdan}</div>
  `;
  
  legendContainerEl.appendChild(legend);
}



async function updateUniqueWordsDisplay(rows, includeStopwords) {
  try {
    const slim = (rows || []).map(t => (t || "").toString().slice(0, 2000));
    const freq = await postJSON("/api/word_frequency", {
      rows: slim,
      includeStopwords: !!includeStopwords
    });
    
    if (Array.isArray(freq) && freq.length > 0) {
      const vocabularySize = freq.length;
      
      // Update the display element (adjust selector to match your HTML)
      const uniqueWordsElement = document.querySelector(".unique-words-count");
      if (uniqueWordsElement) {
        uniqueWordsElement.textContent = vocabularySize.toLocaleString();
      }
      
      console.log(`📊 Vocabulary size updated: ${vocabularySize}`);
    }
  } catch (err) {
    console.error("Failed to update unique words count:", err);
  }
}

// PDF file support using PDF.js
function handlePDFUpload(file) {
  const fileReader = new FileReader();
  fileReader.onload = function () {
    const typedarray = new Uint8Array(this.result);

    pdfjsLib.getDocument({ data: typedarray }).promise.then(pdf => {
      let textPromises = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        textPromises.push(pdf.getPage(i).then(page => {
          return page.getTextContent().then(textContent => {
            return textContent.items.map(item => item.str).join(' ');
          });
        }));
      }

      Promise.all(textPromises).then(texts => {
        uploadedText = texts.join('\n\n');
        document.getElementById("textInput").value = uploadedText;
      });
    }).catch(error => {
      alert("Error reading PDF: " + error.message);
    });
  };
  fileReader.readAsArrayBuffer(file);
}


// Handle URL fetch and analyze
function fetchURLText() {
  const url = document.getElementById("urlInput").value;
  if (!url) {
    alert("Please enter a valid URL.");
    return;
  }

  fetch(url)
    .then(response => response.text())
    .then(html => {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const bodyText = doc.body.innerText;
      uploadedText = bodyText;
      document.getElementById("textInput").value = uploadedText;
    })
    .catch(error => {
      alert("Failed to fetch or parse URL content: " + error.message);
    });
}

let afinnLexicon = {};

fetch("/static/js/afinn.json")
  .then(res => res.json())
  .then(data => afinnLexicon = data)
  .catch(err => console.error("AFINN lexicon load failed", err));



// ===== SENTIMENT ANALYSIS WITH FILTER =====

const classifySentiment = (sentence) => {
  const words = sentence.toLowerCase().split(/\W+/);
  let score = 0;
  
  words.forEach(word => {
    if (afinnLexicon[word] !== undefined) {
      score += afinnLexicon[word];
    }
  });
  
  let label = "Neutral";
  let color = "#999";
  if (score > 0) {
    label = "Positive";
    color = "green";
  } else if (score < 0) {
    label = "Negative";
    color = "red";
  }
  
  return { label, score, color };
};

async function displaySentenceLevelSentiment(text) {
  const container = document.getElementById("sentimentResults");
  container.innerHTML = "<em>Analyzing sentiment...</em>";
  
  try {
    const response = await fetch("/sentiment", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text })
    });
    
    const result = await response.json();
    if (result.error) throw new Error(result.error);
    
    const results = result.results;
    if (!results.length) {
      container.innerHTML = "<i>No valid sentences found for analysis.</i>";
      return;
    }
    
    // Calculate sentiment distribution
    const sentimentCounts = {
      Positive: results.filter(r => r.sentiment === 'Positive').length,
      Negative: results.filter(r => r.sentiment === 'Negative').length,
      Neutral: results.filter(r => r.sentiment === 'Neutral').length
    };
    
    // Build filter dropdown with blue styling
    const filterHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 12px; background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); border-radius: 8px; border: 1px solid #bae6fd;">
        <div style="display: flex; gap: 20px; font-size: 14px;">
          <span style="background: white; padding: 4px 12px; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);"><strong>Positive:</strong> <span style="color: #16a34a; font-weight: 600;">${sentimentCounts.Positive}</span></span>
          <span style="background: white; padding: 4px 12px; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);"><strong>Negative:</strong> <span style="color: #dc2626; font-weight: 600;">${sentimentCounts.Negative}</span></span>
          <span style="background: white; padding: 4px 12px; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);"><strong>Neutral:</strong> <span style="color: #64748b; font-weight: 600;">${sentimentCounts.Neutral}</span></span>
        </div>
        <div style="position: relative;">
          <select id="sentiment-filter" style="
            padding: 8px 36px 8px 14px; 
            border: 2px solid #2563eb; 
            border-radius: 8px; 
            font-size: 14px; 
            font-weight: 600;
            cursor: pointer; 
            background: linear-gradient(to bottom, #ffffff 0%, #f8fafc 100%);
            color: #1e40af;
            box-shadow: 0 2px 4px rgba(37, 99, 235, 0.1);
            appearance: none;
            -webkit-appearance: none;
            -moz-appearance: none;
            transition: all 0.2s ease;
          " onmouseover="this.style.borderColor='#1d4ed8'; this.style.boxShadow='0 4px 6px rgba(37, 99, 235, 0.2)'" onmouseout="this.style.borderColor='#2563eb'; this.style.boxShadow='0 2px 4px rgba(37, 99, 235, 0.1)'">
            <option value="all">All Sentiments</option>
            <option value="Positive">Positive Only</option>
            <option value="Negative">Negative Only</option>
            <option value="Neutral">Neutral Only</option>
          </select>
          <svg style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; width: 16px; height: 16px;" fill="none" stroke="#2563eb" stroke-width="2" viewBox="0 0 24 24">
            <path d="M19 9l-7 7-7-7"/>
          </svg>
        </div>
      </div>`;
    
    // Build sentence list
    let sentenceHTML = "";
    results.forEach((r) => {
      // ✅ Extract label from text if present
      let displayText = r.text;
      let extractedLabel = r.label;
      
      // Check if text starts with [label...] format
      const labelMatch = displayText.match(/^\[([^\]]+)\]\s*(.*)$/);
      if (labelMatch) {
        extractedLabel = labelMatch[1]; // e.g., "label1"
        displayText = labelMatch[2]; // Text without the label
      }
      
      // ✅ FIXED: Show label in title, keep only text and score in content
      const summary = extractedLabel !== null
        ? `Sentence ${r.sentence_id} (Label: ${extractedLabel}) - ${r.sentiment}`
        : `Sentence ${r.sentence_id} - ${r.sentiment}`;
      
      sentenceHTML += `
        <details class="sentence-block sentiment-item" data-sentiment="${r.sentiment}" style="margin-bottom: 8px; border: 1px solid #e5e7eb; border-radius: 6px; padding: 8px; background: white;">
          <summary style="color:${r.color}; font-weight:bold; cursor: pointer; padding: 4px;">${summary}</summary>
          <div style="margin-left: 1em; margin-top: 8px; padding: 8px; background: #f9fafb; border-radius: 4px;">
            <p style="margin: 0 0 8px 0; line-height: 1.6;">${displayText}</p>
            <span style="color:${r.color}; font-size: 13px;"><em>Score:</em> <strong>${r.score}</strong></span>
          </div>
        </details>`;
    });
    
    // ✅ CHANGED: Wrap entire sentiment section in collapsed details
    container.innerHTML = `
      <details class="sentiment-section">
        <summary style="font-weight:bold; color:#0074cc; font-size: 1.1em; cursor: pointer; padding: 10px; background: #f9f9f9; border-radius: 6px;">
          Sentiment Analysis - ${results.length} sentences analyzed
        </summary>
        <div style="background: white; padding: 1.5rem; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-top: 10px;">
          ${filterHTML}
          <div id="sentiment-list" style="max-height: 600px; overflow-y: auto; padding-right: 8px;">
            ${sentenceHTML}
          </div>
        </div>
      </details>`;
    
    // Add filter event listener
    const filterSelect = document.getElementById('sentiment-filter');
    if (filterSelect) {
      filterSelect.addEventListener('change', (e) => {
        const selectedSentiment = e.target.value;
        const sentimentItems = document.querySelectorAll('.sentiment-item');
        sentimentItems.forEach(item => {
          if (selectedSentiment === 'all' || item.dataset.sentiment === selectedSentiment) {
            item.style.display = 'block';
          } else {
            item.style.display = 'none';
          }
        });
        
        // Update visible count
        const visibleCount = Array.from(sentimentItems).filter(item => item.style.display !== 'none').length;
        console.log(`Showing ${visibleCount} of ${sentimentItems.length} sentences`);
      });
    }
  } catch (error) {
    container.innerHTML = `<span style="color:red;">Error: ${error.message}</span>`;
  }
}

// Custom scrollbar styling for sentiment list
const style = document.createElement('style');
style.textContent = `
  #sentiment-list {
    scrollbar-width: thin;
    scrollbar-color: #cbd5e1 #f1f5f9;
  }
  
  #sentiment-list::-webkit-scrollbar {
    width: 8px;
  }
  
  #sentiment-list::-webkit-scrollbar-track {
    background: #f1f5f9;
    border-radius: 4px;
  }
  
  #sentiment-list::-webkit-scrollbar-thumb {
    background: #cbd5e1;
    border-radius: 4px;
  }
  
  #sentiment-list::-webkit-scrollbar-thumb:hover {
    background: #94a3b8;
  }
  
  .sentence-block summary:hover {
    background: #f1f5f9;
    border-radius: 4px;
  }
  
  .sentence-block[open] {
    border-color: #3b82f6;
  }
`;
document.head.appendChild(style);





document.addEventListener("DOMContentLoaded", function () {
  insertPredictiveTabIfNeeded();
  const fileInput = document.getElementById("fileInput");
  const textArea = document.getElementById("textInput");
  const analyzeBtn = document.getElementById("analyzeButton") || document.getElementById("analyzeBtn");
  const wordCountDisplay = document.getElementById("liveWordCount");
  const fetchFromUrlBtn = document.getElementById("fetchFromUrlBtn");
  const fileUrlInput = document.getElementById("fileUrlInput");

  function renderLabelDistributionChart(labeledLines) {
    const labelCounts = {};
    
    // Get label columns info to handle multi-label format
    const labelColumns = JSON.parse(sessionStorage.getItem("labelColumns") || "null");
    const labelColumnCount = parseInt(sessionStorage.getItem("labelColumnCount") || "0");
    
    labeledLines.forEach(line => {
      // Updated regex to capture both numeric labels AND label names
      const match = line.match(/^\[([^\]]+)\]/); // extract label like [0] or [glass] or [metal+plastic]
      if (match) {
        const labelPart = match[1];
        
        // Handle multi-label format (labels separated by +)
        if (labelPart.includes('+')) {
          const labels = labelPart.split('+').map(l => l.trim());
          labels.forEach(label => {
            labelCounts[label] = (labelCounts[label] || 0) + 1;
          });
        } else {
          // Single label
          labelCounts[labelPart] = (labelCounts[labelPart] || 0) + 1;
        }
      }
    });
    
    const labels = Object.keys(labelCounts).sort(); // Sort for consistent display
    const values = labels.map(label => labelCounts[label]);
    
    const ctx = document.getElementById("labelChart");
    if (!ctx) return;
    
    new Chart(ctx, {
      type: "bar",
      data: {
        labels: labels,
        datasets: [{
          label: "Count per Class Label",
          data: values,
          backgroundColor: labels.map((_, i) => `hsl(${(i * 45) % 360}, 70%, 60%)`)
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { display: false },
          title: {
            display: false
          }
        },
        scales: {
          x: {
            title: {
              display: true,
              text: "Class Label",
              color: "#000",
              font: {
                size: 18,
                weight: "bold"
              }
            }
          },
          y: {
            beginAtZero: true,
            title: {
              display: true,
              text: "Count",
              color: "#000",
              font: {
                size: 18,
                weight: "bold"
              }
            }
          }
        }
      }
    });
  }



  // === OVERVIEW PAGE LOGIC ===
if (window.location.pathname.includes("/overview")) {
  const saved = sessionStorage.getItem("textData");
  if (!saved) return;
  
  const { text } = JSON.parse(saved);
  
  // ✅ FIXED: Check if text is labeled and extract only actual text content
  let cleanText = text;
  const lines = text.trim().split(/\n/).filter(Boolean);
  const isLabeled = /^\[([^\]]+)\]/.test(lines[0] || "");
  
  if (isLabeled) {
    // Remove labels from each line
    cleanText = lines
      .map(line => {
        const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
        return match ? match[2] : line;
      })
      .join(" ");
  }
  
  const words = cleanText.trim().split(/\s+/).filter(Boolean);
  const totalWords = words.length;
  const uniqueWords = new Set(words.map(w => w.toLowerCase())).size;
  
  document.getElementById("totalWords").textContent = totalWords;
  document.getElementById("uniqueWords").textContent = uniqueWords;
  
  const sentimentScore = Math.min(1, Math.max(0, (uniqueWords / totalWords).toFixed(2)));
  let sentimentLabel = "Neutral";
  if (sentimentScore > 0.65) sentimentLabel = "Positive";
  else if (sentimentScore < 0.35) sentimentLabel = "Negative";
  
  document.getElementById("sentimentScore").textContent = `${sentimentScore} (${sentimentLabel})`;
  
  const vocabScore = (uniqueWords / Math.sqrt(totalWords)).toFixed(2);
  let vocabLabel = "Moderate";
  if (vocabScore > 0.7) vocabLabel = "Diverse";
  else if (vocabScore < 0.4) vocabLabel = "Limited";
  
  document.getElementById("vocabStats").textContent = `${vocabScore} (${vocabLabel})`;
  
  return;
}

// === VISUALIZATIONS PAGE LOGIC ===
if (window.location.pathname.includes("/visualizations")) {
  const saved = sessionStorage.getItem("textData");
  const uploadedCSV = sessionStorage.getItem("uploadedCSV");
  
  if (!saved && !uploadedCSV) {
    console.log("❌ No data found, redirecting to home");
    window.location.href = '/overview';
    return;
  }

  const wordLimitSelector = document.getElementById("wordLimit");
  const stopwordCheckbox = document.getElementById("includeStopwords");
  
  const data = JSON.parse(saved);
  const words = data.text.split(/\n/).filter(Boolean);
  
  // ✅ FIXED: Check for ANY label format
  const isLabeled = /^\[([^\]]+)\]/.test(words[0] || "");
  
  document.getElementById("labelDistribution").style.display = isLabeled ? "block" : "none";
  
  if (isLabeled) {
    renderLabelDistributionChart(words);
  }

  // ✅ RESTORE window.lastCSVData from sessionStorage if needed
  if (!window.lastCSVData) {
    const storedCSVData = sessionStorage.getItem("lastCSVData");
    if (storedCSVData) {
      try {
        window.lastCSVData = JSON.parse(storedCSVData);
        console.log("✅ Restored window.lastCSVData from sessionStorage:", window.lastCSVData.length, "rows");
      } catch (e) {
        console.error("Failed to parse lastCSVData from sessionStorage:", e);
      }
    }
  }

  async function getWordFreqServer(rows, includeStopwords) {
    try {
      const res = await fetch("/api/word_frequency", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows,
          include_stopwords: !!includeStopwords
        })
      });
      const data = await res.json();
      const out = data.frequencies ?? data;
      const size = Array.isArray(out) ? out.length : Object.keys(out || {}).length;
      if (!size) throw new Error("Empty server response");
      return out;
    } catch (e) {
      console.warn("word_frequency: using client fallback:", e);
      const counts = {};
      for (const r of rows || []) {
        for (const tok of String(r).toLowerCase().match(/\b[\w''-]+\b/g) || []) {
          counts[tok] = (counts[tok] || 0) + 1;
        }
      }
      return counts;
    }
  }

  async function renderAll() {
    const includeStopwords = !!stopwordCheckbox.checked;
    
    // ---------- LABELED CSV PATH ----------
    if (isLabeled && sessionStorage.getItem("uploadedCSV")) {
      const sampleRows = window.lastCSVData || [];
      if (!sampleRows.length) {
        console.error("❌ No CSV data available.");
      } else {
        console.log("✅ Using data from sessionStorage");
        
        const existingTabs = document.querySelectorAll(".class-tab");
        const activeClassTab = document.querySelector(".class-tab.active");
        const activeClass = activeClassTab?.dataset.class || window.activeClass || null;
        
        if (existingTabs.length > 0 && activeClass) {
          console.log("♻️ Tabs already exist — re-rendering active class only");
          initializeClassSpecificPlots(window.lastCSVData, "all", activeClass);
        } else {
          console.log("🆕 No tabs detected — initializing from scratch");
          initializeClassSpecificPlots(window.lastCSVData, "all");
        }
      }
    } else {
      // ✅ FIXED: Handle any label format in extraction
      const rowsForCloud = words
        .map(line => {
          const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
          return match ? match[2] : line;
        })
        .filter(Boolean);
      
      // ✅ NO AWAIT - start word cloud but don't wait
      getWordFreqServer(rowsForCloud, includeStopwords).then(freq => {
        generateWordCloudFromFreq(freq);
      });
      
      document.getElementById("labelDistribution").style.display = "none";
    }
  
    // ---------- Shared: Coverage & Zipf for unlabeled data ----------
    if (!isLabeled || !sessionStorage.getItem("uploadedCSV")) {
      const rowsForCharts = (window.lastCSVData && window.lastCSVData.length)
        ? window.lastCSVData.map(r => r.text || r.Message || "").filter(Boolean)
        : words.map(line => {
            const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
            return match ? match[2] : line;
          }).filter(Boolean);
      
      const min = parseInt(document.getElementById("minRank").value, 10) || 1;
      const max = parseInt(document.getElementById("maxRank").value, 10) || Infinity;
      
      // ✅ NO AWAIT - start coverage chart but don't wait
      generateCoverageChartServer(rowsForCharts, includeStopwords, min, max);
      
      // ✅ NO AWAIT - start Zipf plot but don't wait
      generateZipfPlotServer(rowsForCharts, includeStopwords);
    }
  }

  window.rerender = () => { 
    console.log("🔄 Starting ALL visualizations in parallel");
    renderAll(); // This now starts all without waiting
  };
  
  window.rerenderNetworkOnly = async () => {
    if (!window.lastCSVData) { await renderAll(); return; }
    const includeStopwords = !!document.getElementById("includeStopwords").checked;
    const topN  = parseInt(document.getElementById("topKeywordsInput").value, 10);
    const minCo = parseInt(document.getElementById("minCooccurrenceInput").value, 10);
    
    // ✅ FIXED: Get the network-specific active tab
    const activeTab = document.querySelector('#networkContainer .class-tab.active');
    if (activeTab) {
      // ✅ Use dataset.class which has the exact class name
      const className = activeTab.dataset.class;
      console.log("🔍 Update Network - Active tab class from dataset:", className);
      
      let classData;
      if (className === 'all') {
        classData = window.lastCSVData;
      } else {
        // ✅ Filter using labelNames array
        classData = window.lastCSVData.filter(row => {
          if (row.labelNames && Array.isArray(row.labelNames)) {
            return row.labelNames.includes(className);
          }
          // Handle single label format
          const targetClassNum = className.replace('label', '');
          const rowClass = row.class !== undefined ? row.class : row.label;
          return String(rowClass || 'Unlabeled') === targetClassNum;
        });
      }
      
      const rows = classData.map(r => (r.text || "").toString());
      console.log("🔍 Update Network - Filtered data:", {
        className,
        totalRows: window.lastCSVData.length,
        filteredRows: classData.length,
        textRows: rows.length
      });
      
      await fetchAndRenderCooccurrence(rows, includeStopwords, topN, minCo, className);
    } else {
      const rows = window.lastCSVData.map(r => (r.text || "").toString());
      console.log("⚠️ No active network tab found, using all data");
      await fetchAndRenderCooccurrence(rows, includeStopwords, topN, minCo, 'all');
    }
  };

  document.getElementById("updateNetworkBtn")?.addEventListener("click", rerenderNetworkOnly);
  wordLimitSelector.addEventListener("change", rerender);
  stopwordCheckbox.addEventListener("change", function () {
    console.log("🔄 Stopwords changed, clearing word cloud caches");
    
    // Clear word cloud caches
    if (window.wordCloudCache) {
      window.wordCloudCache.clear();
    }
    
    // Get current active word cloud tab
    const activeTab = document.querySelector('#wordCloud .class-tab.active');
    if (activeTab && window.lastCSVData) {
      const className = activeTab.dataset.class;
      console.log(`🔄 Re-rendering word cloud for "${className}" with new stopwords setting`);
      
      // Re-render the current tab
      if (typeof renderWordCloudForClass === "function") {
        renderWordCloudForClass(window.lastCSVData, className);
      }
    }
    
    // Continue with your existing stopwords change logic...
    // ... [your existing code for other visualizations] ...
  });

  rerender();
}

  

// === FILE UPLOAD LOGIC ===
if (fileInput && textArea) {
  fileInput.addEventListener("change", function (event) {
    // ✅ SINGLE CLEANUP SECTION - Remove duplicates
    Object.defineProperty(window, 'lastCSVData', {
      value: undefined,
      writable: true,
      configurable: true
    });
    console.log("🔓 window.lastCSVData unlocked for new upload");
    
    // Clear ALL client-side sessionStorage in ONE place
    sessionStorage.removeItem("uploadedCSV");
    sessionStorage.removeItem("labeledData");
    sessionStorage.removeItem("isLabeled");
    sessionStorage.removeItem("textData");
    sessionStorage.removeItem("preprocessingComplete");
    sessionStorage.removeItem("labelColumns");
    sessionStorage.removeItem("labelColumnCount");
    sessionStorage.removeItem("lastCSVData");
    sessionStorage.removeItem("lastCSVTextRows");
    sessionStorage.removeItem("uniqueLabels");
    sessionStorage.removeItem("detectedTextCol");
    sessionStorage.removeItem("detectedLabelCol");
    
    // ✅ Clear preprocessing data
    sessionStorage.removeItem("preprocessingSettings");
    sessionStorage.removeItem("preprocessingApplied");
    sessionStorage.removeItem("preprocessingInfo");
    sessionStorage.removeItem("preprocessedData");
    
    // Clear server-side Flask session
    fetch('/api/clear_preprocessing', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'}
    }).catch(err => console.log("Note: Clear preprocessing endpoint not available"));
    
    const clearAdvancedSections = () => {
      const ids = ["nerResults", "sentimentResults", "topicModelingResults", "classificationResults"];
      ids.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
      });
    };
    clearAdvancedSections();
    
    const file = event.target.files[0];
    if (!file) return;
    
    const maxSize = 500 * 1024 * 1024; 
    if (file.size > maxSize) {
      alert("❌ File is too large. Please upload a file under 100 MB.");
      event.target.value = "";
      return;
    }
      
    const ext = file.name.split(".").pop().toLowerCase();
    
    if (ext === "txt") {
      const reader = new FileReader();
      reader.onload = function (e) {
        const text = e.target.result.trim();
        const lines = text.split("\n").filter(line => line.trim());
        
        if (lines.length === 0) {
          alert("❌ File is empty.");
          return;
        }
        
        // Try parsing as TSV/CSV first
        let isLabeledFormat = false;
        let parsedData = null;
        let labelColumnCount = 0;
        let labelColumns = [];
        
        const firstLine = lines[0];
        const tabParts = firstLine.split("\t");
        const commaParts = firstLine.split(",");
        let separator = null;
        let parts = null;
        
        // Determine separator (prefer tabs if both exist)
        if (tabParts.length > 1) {
          separator = "\t";
          parts = tabParts;
        } else if (commaParts.length > 1) {
          separator = ",";
          parts = commaParts;
        }
        
        if (separator && parts) {
          // Check if first columns are binary (0/1) indicators or label names
          for (let i = 0; i < parts.length - 1; i++) {
            const val = parts[i].trim();
            const cleanVal = val.replace(/^["']|["']$/g, '');
            
            // Check if this is a binary value OR a short label name
            const isBinaryValue = cleanVal === '0' || cleanVal === '1';
            const looksLikeLabelName = !isBinaryValue && cleanVal.length < 20 && !cleanVal.includes(' ');
            
            if (isBinaryValue || looksLikeLabelName) {
              labelColumnCount++;
              labelColumns.push(cleanVal);
            } else {
              break;
            }
          }
          
          // Check if first line is a header
          const secondLine = lines.length > 1 ? lines[1] : null;
          let hasHeader = false;
          
          if (secondLine && labelColumnCount > 0) {
            const secondParts = secondLine.split(separator);
            const firstColSecondRow = secondParts[0]?.trim().replace(/^["']|["']$/g, '');
            // If first row values are NOT 0/1 but second row values ARE, it's a header
            if (labelColumns.every(v => v !== '0' && v !== '1') && 
                (firstColSecondRow === '0' || firstColSecondRow === '1')) {
              hasHeader = true;
            }
          }
          
          const lastColumn = parts[parts.length - 1].trim();
          const hasTextColumn = lastColumn.length > 20 || lastColumn.startsWith('"');
          
          if (labelColumnCount >= 1 && hasTextColumn) {
            isLabeledFormat = true;
            
            // Parse all lines (skip header if present)
            const startIdx = hasHeader ? 1 : 0;
            
            // If no header, create default label names
            if (!hasHeader) {
              labelColumns = Array.from({length: labelColumnCount}, (_, i) => `label${i}`);
            }
            
            // ✅ Convert multi-label format - create separate row for each active label
            parsedData = [];
            lines.slice(startIdx).forEach(line => {
              const columns = line.split(separator);
              // Extract binary labels (first N columns)
              const labels = columns.slice(0, labelColumnCount).map(l => 
                l.trim().replace(/^["']|["']$/g, '')
              );
              // Extract text (remaining columns joined)
              let textContent = columns.slice(labelColumnCount).join(separator).trim();
              textContent = textContent.replace(/^["']|["']$/g, '');
              
              if (!textContent || textContent.length === 0) return;
              
              // Find which label column(s) have '1'
              const activeLabels = [];
              labels.forEach((val, idx) => {
                if (val === '1') {
                  activeLabels.push(idx);
                }
              });
              
              // If no labels are active, assign to "-1"
              if (activeLabels.length === 0) {
                parsedData.push({
                  label: "-1",
                  text: textContent,
                  originalLabels: labels,
                  activeIndices: [],
                  labelNames: [],
                  isMultiLabel: false
                });
                return;
              }
              
              // ✅ CREATE SEPARATE ROW FOR EACH ACTIVE LABEL
              activeLabels.forEach(idx => {
                parsedData.push({
                  label: idx.toString(),
                  text: textContent,
                  originalLabels: labels,
                  activeIndices: [idx],
                  labelNames: [labelColumns[idx]],
                  isMultiLabel: activeLabels.length > 1
                });
              });
            });

            // Filter is no longer needed since we're using forEach with return
            if (parsedData.length === 0) {
              isLabeledFormat = false;
            }
            
            if (parsedData.length === 0) {
              isLabeledFormat = false;
            }
          }
        }
        
        // If detected as labeled format, process like CSV
        if (isLabeledFormat && parsedData) {
          // Store label column names
          sessionStorage.setItem("labelColumns", JSON.stringify(labelColumns));
          sessionStorage.setItem("labelColumnCount", labelColumnCount.toString());
          
          // Create CSV string representation
          const csvHeader = labelColumns.join(',') + ',text\n';
          const csvRows = parsedData.map(row => {
            const labelCols = row.originalLabels.map(l => `"${l}"`).join(',');
            const textCol = `"${row.text.replace(/"/g, '""')}"`;
            return `${labelCols},${textCol}`;
          });
          const csvText = csvHeader + csvRows.join('\n');
          
          sessionStorage.setItem("uploadedCSV", csvText);
          
          // Create display format with label names
          const labeledData = parsedData.map(row => {
            const labelDisplay = row.labelNames.length > 0 
              ? row.labelNames.join('+') 
              : row.label;
            return `[${labelDisplay}] ${row.text}`;
          });
          
          sessionStorage.setItem("textData", JSON.stringify({ text: labeledData.join("\n") }));
          sessionStorage.setItem("detectedTextCol", "text");
          sessionStorage.setItem("detectedLabelCol", labelColumns[0]);
          
          const rowsText = parsedData.map(row => row.text);
          sessionStorage.setItem("lastCSVTextRows", JSON.stringify(rowsText));
          
          // ✅ CRITICAL FIX: For multi-label data, store ALL label indices, not just the first one
          const processedData = [];
          
          // Group by text content to combine multiple labels for the same text
          const textToLabels = {};
          parsedData.forEach(row => {
            const text = row.text;
            if (!textToLabels[text]) {
              textToLabels[text] = {
                text: text,
                labelNames: new Set(),
                originalLabels: row.originalLabels,
                activeIndices: new Set()
              };
            }
            
            // Add all active labels for this row
            row.activeIndices.forEach(idx => {
              textToLabels[text].labelNames.add(labelColumns[idx]);
              textToLabels[text].activeIndices.add(idx);
            });
          });
          
          // Convert back to array format with combined labels
          Object.values(textToLabels).forEach(item => {
            if (item.activeIndices.size > 0) {
              // For multi-label data, we need to represent ALL classes this document belongs to
              const allLabels = Array.from(item.activeIndices).map(idx => labelColumns[idx]);
              
              processedData.push({
                // Use the first label as primary for compatibility, but store all
                label: Array.from(item.activeIndices)[0].toString(),
                text: item.text,
                labelNames: Array.from(item.labelNames),
                originalLabels: item.originalLabels,
                activeIndices: Array.from(item.activeIndices),
                isMultiLabel: item.activeIndices.size > 1,
                // ✅ NEW: Store ALL label values for proper class detection
                allLabels: allLabels,
                allLabelIndices: Array.from(item.activeIndices)
              });
            }
          });
          
          // Set window.lastCSVData for visualizations
          window.lastCSVData = processedData;
        
          // ✅ FIXED: Extract ALL unique class labels from labelColumns (not from row.label)
          const allUniqueLabels = labelColumns.filter((_, index) => {
            // A label column exists if any row has it active
            return processedData.some(row => row.activeIndices.includes(index));
          });
          
          sessionStorage.setItem("uniqueLabels", JSON.stringify(allUniqueLabels));
          console.log("✅ Multi-label format detected - Unique labels:", allUniqueLabels);
          console.log("✅ Processed data sample:", processedData.slice(0, 3));
          
          // ✅ Store in sessionStorage
          sessionStorage.setItem("lastCSVData", JSON.stringify(processedData));
          
          console.log(`✅ Detected multi-label TXT file with ${labelColumnCount} label columns:`, labelColumns);
          console.log(`✅ Found ${allUniqueLabels.length} active labels:`, allUniqueLabels);
          window.location.href = "/overview";
        } else {
          // UNLABELED TXT - Original behavior
          textArea.value = text;
          sessionStorage.setItem("textData", JSON.stringify({ text }));
          sessionStorage.removeItem("detectedTextCol");
          sessionStorage.removeItem("detectedLabelCol");
          sessionStorage.removeItem("lastCSVTextRows");
          sessionStorage.removeItem("labelColumns");
          sessionStorage.removeItem("labelColumnCount");
          sessionStorage.setItem("mode", "unlabeled");
          sessionStorage.removeItem("isLabeled");
          updateLiveWordCount();
        }
      };
      reader.readAsText(file);
      
    } else if (ext === "docx") {
      const reader = new FileReader();
      reader.onload = function (e) {
        const arrayBuffer = e.target.result;
        mammoth.extractRawText({ arrayBuffer }).then(function (result) {
          const text = result.value.trim();
          textArea.value = text;
          sessionStorage.setItem("textData", JSON.stringify({ text }));
          sessionStorage.removeItem("detectedTextCol");
          sessionStorage.removeItem("detectedLabelCol");
          sessionStorage.removeItem("lastCSVTextRows");
          sessionStorage.removeItem("labelColumns");
          sessionStorage.removeItem("labelColumnCount");
          sessionStorage.setItem("mode", "unlabeled");
          sessionStorage.removeItem("isLabeled");
          updateLiveWordCount();
        }).catch(function (err) {
          alert("Failed to extract text from DOCX.");
          console.error(err);
        });
      };
      reader.readAsArrayBuffer(file);
      
    } else if (ext === "pdf") {
      const reader = new FileReader();
      reader.onload = function (e) {
        const typedarray = new Uint8Array(e.target.result);
        pdfjsLib.getDocument({ data: typedarray }).promise.then(pdf => {
          let textPromises = [];
          for (let i = 1; i <= pdf.numPages; i++) {
            textPromises.push(
              pdf.getPage(i).then(page =>
                page.getTextContent().then(tc =>
                  tc.items.map(item => item.str).join(" ")
                )
              )
            );
          }
          Promise.all(textPromises).then(texts => {
            const text = texts.join("\n\n");
            textArea.value = text;
            sessionStorage.setItem("textData", JSON.stringify({ text }));
            sessionStorage.removeItem("detectedTextCol");
            sessionStorage.removeItem("detectedLabelCol");
            sessionStorage.removeItem("lastCSVTextRows");
            sessionStorage.removeItem("labelColumns");
            sessionStorage.removeItem("labelColumnCount");
            sessionStorage.setItem("mode", "unlabeled");
            sessionStorage.removeItem("isLabeled");
            updateLiveWordCount();
          });
        }).catch(err => alert("Error reading PDF: " + err.message));
      };
      reader.readAsArrayBuffer(file);
      
    } else if (ext === "csv") {
      file.text().then(csvText => {
        sessionStorage.setItem("uploadedCSV", csvText);
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: function (results) {
            const data = results.data;
            if (!data.length) {
              alert("CSV is empty or invalid.");
              return;
            }
            
            // Normalize all column names
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
            
            // Check for multi-label binary format
            let labelColumnCount = 0;
            let textCol = null;
            
            // Check if first N columns are binary (0/1) indicators
            for (let i = 0; i < allColumns.length - 1; i++) {
              const col = allColumns[i];
              const values = data.map(row => row[col]).filter(Boolean);
              const isBinary = values.every(v => v === '0' || v === '1' || v === 0 || v === 1);
              
              if (isBinary) {
                labelColumnCount++;
              } else {
                break;
              }
            }
            
            // Multi-label format detected
            if (labelColumnCount > 0) {
              textCol = allColumns[allColumns.length - 1];
              
              // Store label column names
              const labelColumns = allColumns.slice(0, labelColumnCount);
              sessionStorage.setItem("labelColumns", JSON.stringify(labelColumns));
              sessionStorage.setItem("labelColumnCount", labelColumnCount.toString());
              
              // ✅ Convert multi-label format - create separate row for each active label
              const processedData = [];
              data.forEach(row => {
                const text = row[textCol]?.toString().trim();
                if (!text) return;
                
                // Find which label columns have '1'
                const activeLabels = labelColumns.filter((col, idx) => {
                  const val = row[col];
                  return val === '1' || val === 1;
                });
                
                // If no labels are active, skip this row or assign to "-1"
                if (activeLabels.length === 0) {
                  processedData.push({
                    label: labelIndex.toString(),
                    text: text,
                    originalLabels: labelColumns.map(col => row[col]),
                    labelNames: []
                  });
                  return;
                }
                
                // ✅ CREATE SEPARATE ROW FOR EACH ACTIVE LABEL
                activeLabels.forEach(labelName => {
                  const labelIndex = labelColumns.indexOf(labelName);
                  processedData.push({
                    label: labelIndex.toString(),
                    text: text,
                    originalLabels: labelColumns.map(col => row[col]),
                    labelNames: [labelName],
                    isMultiLabel: activeLabels.length > 1
                  });
                });
              });
              
              // Store processed data for visualizations
              window.lastCSVData = processedData;

              // ✅ Store ALL unique class labels for visualizations
              const allUniqueLabels = [...new Set(processedData.map(row => row.label))].filter(l => l !== "-1").sort();
              sessionStorage.setItem("uniqueLabels", JSON.stringify(allUniqueLabels));
              console.log("✅ Unique labels detected:", allUniqueLabels);

              sessionStorage.setItem("lastCSVData", JSON.stringify(processedData));
              console.log("✅ Saved processedData to sessionStorage");
              
              // Create display format with label names
              const labeledData = processedData.map(row => {
                const labelDisplay = row.labelNames.length > 0 
                  ? row.labelNames.join('+') 
                  : row.label;
                return `[${labelDisplay}] ${row.text}`;
              });
              
              sessionStorage.setItem("textData", JSON.stringify({ text: labeledData.join("\n") }));
              sessionStorage.setItem("detectedTextCol", textCol);
              sessionStorage.setItem("detectedLabelCol", labelColumns[0]);
              
              const rowsText = processedData.map(row => row.text);
              sessionStorage.setItem("lastCSVTextRows", JSON.stringify(rowsText));
              
              console.log(`✅ Detected multi-label CSV with ${labelColumnCount} label columns`);
              console.log(`Label columns: ${labelColumns.join(', ')}`);
              
              window.location.href = "/overview";
              
            } else {
              // FALLBACK: Single-label format detection
              let labelCol = null;
              
              for (let i = 0; i < allColumns.length; i++) {
                const col = allColumns[i];
                const values = data.map(row => row[col]);
                const unique = [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
                const isText = values.some(v => typeof v === "string" && v.length > 20);
                const isLabel = unique.length > 0 && unique.every(v =>
                  !isNaN(v) || ["spam", "ham", "not spam"].includes(v.toLowerCase())
                );
                
                if (!textCol && isText) textCol = col;
                if (!labelCol && isLabel) labelCol = col;
              }
              
              if (!textCol || !labelCol) {
                console.log("Auto-detection failed. Columns:", Object.keys(data[0]));
                console.log("Data sample:", data[0]);
                alert("Could not auto-detect text and label columns.");
                return;
              }
              
              // Normalize labels to numeric indices
              const labelMap = {};
              let labelIndex = 0;

              // Create structured data
              const singleLabelData = data.map(row => {
                const rawLabel = row[labelCol]?.toString().trim();
                const text = row[textCol]?.toString().trim();
                if (!rawLabel || !text) return null;
                
                const label = !isNaN(rawLabel) ? rawLabel : (
                  labelMap[rawLabel] ?? (labelMap[rawLabel] = labelIndex++)
                );
                
                return {
                  label: String(label),
                  text: text
                };
              }).filter(Boolean);

              // Save structured data
              sessionStorage.setItem("lastCSVData", JSON.stringify(singleLabelData));

              // Create display format
              const labeledData = singleLabelData.map(row => `[${row.label}] ${row.text}`);
              sessionStorage.setItem("textData", JSON.stringify({ text: labeledData.join("\n") }));
              sessionStorage.setItem("detectedTextCol", textCol);
              sessionStorage.setItem("detectedLabelCol", labelCol);

              const rowsText = singleLabelData.map(row => row.text);
              sessionStorage.setItem("lastCSVTextRows", JSON.stringify(rowsText));

              window.location.href = "/overview";
            }
          }
        });
      });
      
    } else if (ext === "xlsx") {
      const reader = new FileReader();
      reader.onload = function (e) {
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: "array" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const parsed = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        
        const labeledData = parsed
          .filter((row, i) => i > 0 && row[0] && row[1] !== undefined)
          .map(row => ({ text: row[0].toString().trim(), label: row[1].toString().trim() }));
        
        const displayText = labeledData.map(entry => `[${entry.label}] ${entry.text}`).join("\n");
        textArea.value = displayText;
        sessionStorage.setItem("textData", JSON.stringify({ text: displayText }));
        sessionStorage.setItem("isLabeled", "true");
        updateLiveWordCount();
      };
      reader.readAsArrayBuffer(file);
      
    } else {
      alert("Unsupported file format. Please upload a .txt, .docx, .pdf, .csv, or .xlsx file.");
    }
  });
}

// === ANALYZE BUTTON ===
if (analyzeBtn && textArea) {
  analyzeBtn.addEventListener("click", function () {
    const userText = textArea.value.trim();
    if (!userText) {
      alert("Please enter or upload text before analyzing.");
      return;
    }
    sessionStorage.setItem("textData", JSON.stringify({ text: userText }));
    // ✅ CHANGE: Redirect to processing instead of overview
    window.location.href = "/overview";
  });
}

  // === LIVE WORD COUNT ===
  function updateLiveWordCount() {
    if (!textArea || !wordCountDisplay) return;
    const text = textArea.value.trim();
    const wordCount = text ? text.split(/\s+/).length : 0;
    wordCountDisplay.textContent = `Words: ${wordCount} / 1,000,000`;
  }

  if (textArea && wordCountDisplay) {
    textArea.addEventListener("input", updateLiveWordCount);
  }

  // === FETCH FROM URL ===
  if (fetchFromUrlBtn && fileUrlInput) {
    fetchFromUrlBtn.addEventListener("click", async () => {
      const url = fileUrlInput.value.trim();
      if (!url) {
        alert("Please enter a valid URL.");
        return;
      }
      const ext = url.split(".").pop().toLowerCase();
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Network response was not ok");

        if (ext === "txt") {
          const text = await response.text();
          textArea.value = text;
          sessionStorage.setItem("textData", JSON.stringify({ text }));
          sessionStorage.removeItem("detectedTextCol");
      sessionStorage.removeItem("detectedLabelCol");
      sessionStorage.removeItem("lastCSVTextRows");
      sessionStorage.setItem("mode","unlabeled");
updateLiveWordCount();
        } else if (ext === "docx") {
          const arrayBuffer = await response.arrayBuffer();
          const doc = await window.docx.parseDocx(arrayBuffer);
          const text = (doc.children || []).map(p => (p.children || []).map(run => run.text).join('')).join('\n');
          textArea.value = text;
          sessionStorage.setItem("textData", JSON.stringify({ text }));
          sessionStorage.removeItem("detectedTextCol");
      sessionStorage.removeItem("detectedLabelCol");
      sessionStorage.removeItem("lastCSVTextRows");
      sessionStorage.setItem("mode","unlabeled");
updateLiveWordCount();
        } else {
          alert("Unsupported file format. Only .txt or .docx URLs are allowed.");
        }
      } catch (err) {
        console.error("Error fetching file:", err);
        alert("Failed to fetch and read the file. Check the URL or file type.");
      }
    });
  }
  // === ADVANCED PAGE LOGIC ===
  if (window.location.pathname.includes("/advanced")) {
    const saved = sessionStorage.getItem("textData");
    if (!saved) return;
    
    const { text } = JSON.parse(saved);
    if (!text) return;
    
    // ✅ RESTORE window.lastCSVData from sessionStorage if needed
    if (!window.lastCSVData) {
      const storedCSVData = sessionStorage.getItem("lastCSVData");
      if (storedCSVData) {
        try {
          window.lastCSVData = JSON.parse(storedCSVData);
          console.log("✅ Restored window.lastCSVData for advanced analysis:", window.lastCSVData.length, "rows");
        } catch (e) {
          console.error("Failed to parse lastCSVData from sessionStorage:", e);
        }
      }
    }
    
    // ✅ If still no lastCSVData, reconstruct it from textData (for multi-label TXT files)
    if (!window.lastCSVData) {
      const words = text.split(/\n/).filter(Boolean);
      const isLabeled = /^\[([^\]]+)\]/.test(words[0] || "");
      
      if (isLabeled) {
        const labelColumns = JSON.parse(sessionStorage.getItem("labelColumns") || "null");
        
        window.lastCSVData = words.map(line => {
          const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
          if (!match) return null;
          
          const labelPart = match[1];
          const textContent = match[2];
          
          // Handle multi-label format (label0+label1)
          let labelNames = [];
          if (labelPart.includes('+')) {
            labelNames = labelPart.split('+').map(l => l.trim());
          } else {
            labelNames = [labelPart];
          }
          
          // For backward compatibility
          const label = labelNames[0];
          
          return {
            label: label,
            text: textContent,
            labelNames: labelNames,
            class: label
          };
        }).filter(Boolean);
        
        console.log("✅ Reconstructed window.lastCSVData for advanced analysis:", window.lastCSVData.length, "rows");
      }
    }
    
    displayNER(text);
    displayTopics(text);
    displayClassification(text);
    
    // ✅ Load AFINN lexicon before displaying sentiment
    fetch("/static/js/afinn.json")
      .then(res => res.json())
      .then(data => {
        afinnLexicon = data;
        displaySentenceLevelSentiment(text);
      })
      .catch(err => {
        console.error("AFINN lexicon load failed", err);
        document.getElementById("sentimentResults").innerHTML = "<i>Sentiment lexicon failed to load.</i>";
      });
  }

});

async function displayTopics(text) {
  const escapeHTML = (s) =>
    String(s).replace(/[&<>"']/g, (m) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[m]));
  
  const container = document.getElementById("topicModeling");
  container.innerHTML = "<em>Analyzing topics...</em>";
  
  try {
    // 1) Same-page memory
    let rows = (window.lastCSVData || [])
      .map(r => (r.text || r.Message || r.body || r.content || "").toString())
      .filter(s => s.trim());
    
    // 2) Cached upload
    if (!rows.length) {
      try {
        const cached = JSON.parse(sessionStorage.getItem("lastCSVTextRows") || "[]");
        rows = Array.isArray(cached) ? cached.filter(s => s && s.trim()) : [];
      } catch (_) { rows = []; }
    }
    
    // 3) Textarea fallback
    if (!rows.length && text) {
      rows = text.split(/\r?\n\r?\n|\r?\n/).map(s => s.trim()).filter(Boolean);
    }
    
    if (!rows.length) {
      container.innerHTML = "<em>No text found. Upload a file on the Input tab first.</em>";
      return;
    }
    
    // Detect if labeled
    let isLabeled = false;
    const detectedLabelCol = sessionStorage.getItem('detectedLabelCol');
    if (detectedLabelCol && detectedLabelCol !== 'null' && detectedLabelCol !== '') {
      isLabeled = true;
      console.log("✅ Labeled dataset detected. Label column:", detectedLabelCol);
    } else if (window.lastCSVData && window.lastCSVData.length > 0) {
      const firstRow = window.lastCSVData[0];
      isLabeled = firstRow.hasOwnProperty('label') || 
                  firstRow.hasOwnProperty('Label') || 
                  firstRow.hasOwnProperty('class') || 
                  firstRow.hasOwnProperty('Class');
      console.log("✅ Label detection from data keys:", isLabeled);
    }
    
    console.log("✅ Final isLabeled:", isLabeled);
    
    const MAX_CHARS = 2000;
    let safeRows = [];
    if (!isLabeled && rows.length > 1) {
      const mergedText = rows.join(" ");
      safeRows = [mergedText.length > MAX_CHARS ? mergedText.slice(0, MAX_CHARS) : mergedText];
    } else {
      safeRows = rows.map(s => s.length > MAX_CHARS ? s.slice(0, MAX_CHARS) : s);
    }
    
    const data = await fetchJSON("/api/topic_modeling", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        rows: safeRows, 
        topN: 10, 
        includeStopwords: false,
        isLabeled: isLabeled
      })
    });
    
    const topics  = Array.isArray(data.topics)  ? data.topics  : [];
    const mapping = Array.isArray(data.mapping) ? data.mapping : [];
    
    if (!topics.length) {
      container.innerHTML = "<em>No topics found.</em>";
      return;
    }
    
    console.log("📊 Topics received:", topics);
    console.log("📊 Rendering as labeled:", isLabeled);
    
    // ✅ LABELED FILES: Pie chart + scrollable doc list
    if (isLabeled) {
      const groupedMap = {};
      topics.forEach((t, idx) => {
        const id    = (t.id != null) ? t.id : (idx + 1);
        const pct   = Number(t.percent ?? 0);
        const label = (t.label && String(t.label).trim()) ? t.label : `Topic ${id}`;
        const key   = label.toLowerCase();
        if (!groupedMap[key]) groupedMap[key] = { label, percent: 0 };
        groupedMap[key].percent += pct;
      });
      
      let grouped = Object.values(groupedMap);
      let total = grouped.reduce((s, g) => s + g.percent, 0) || 1;
      grouped.forEach(g => g.percent = g.percent * (100 / total));
      
      let rounded = grouped.map(g => ({
        ...g,
        percent: Number(g.percent.toFixed(2))
      }));
      
      let drift = 100 - rounded.reduce((s, g) => s + g.percent, 0);
      if (rounded.length) {
        let iMax = rounded.reduce((i, g, j) => g.percent > rounded[i].percent ? j : i, 0);
        rounded[iMax].percent = Number((rounded[iMax].percent + drift).toFixed(2));
      }
      
      grouped = rounded.sort((a, b) => b.percent - a.percent);
      
      // ✅ Create pie chart
      const pieChartHTML = createPieChart(grouped);
      
      // ✅ Build scrollable document list with filter
      let docListHTML = '';
      if (mapping.length > 1) {
        // Get unique topics for filter dropdown
        const uniqueTopics = [...new Set(mapping.map(m => 
          (m.label && String(m.label).trim()) ? m.label : `Topic ${m.topic}`
        ))].sort();
        
        // Count documents per topic
        const topicCounts = {};
        mapping.forEach(m => {
          const topicLabel = (m.label && String(m.label).trim()) ? m.label : `Topic ${m.topic}`;
          topicCounts[topicLabel] = (topicCounts[topicLabel] || 0) + 1;
        });
        
        const filterHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: 12px; background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); border-radius: 8px; border: 1px solid #bae6fd;">
            <div style="display: flex; gap: 20px; font-size: 14px;">
              <span style="background: white; padding: 4px 12px; border-radius: 6px; box-shadow: 0 1px 2px rgba(0,0,0,0.05);">
                <strong>Total Documents:</strong> <span style="color: #1e40af; font-weight: 600;">${mapping.length}</span>
              </span>
            </div>
            <div style="position: relative;">
              <select id="topic-filter" style="
                padding: 8px 36px 8px 14px; 
                border: 2px solid #2563eb; 
                border-radius: 8px; 
                font-size: 14px; 
                font-weight: 600;
                cursor: pointer; 
                background: linear-gradient(to bottom, #ffffff 0%, #f8fafc 100%);
                color: #1e40af;
                box-shadow: 0 2px 4px rgba(37, 99, 235, 0.1);
                appearance: none;
                -webkit-appearance: none;
                -moz-appearance: none;
                transition: all 0.2s ease;
                min-width: 200px;
              " onmouseover="this.style.borderColor='#1d4ed8'; this.style.boxShadow='0 4px 6px rgba(37, 99, 235, 0.2)'" onmouseout="this.style.borderColor='#2563eb'; this.style.boxShadow='0 2px 4px rgba(37, 99, 235, 0.1)'">
                <option value="all">All Topics</option>
                ${uniqueTopics.map(topic => 
                  `<option value="${escapeHTML(topic)}">${escapeHTML(topic)} (${topicCounts[topic]})</option>`
                ).join('')}
              </select>
              <svg style="position: absolute; right: 12px; top: 50%; transform: translateY(-50%); pointer-events: none; width: 16px; height: 16px;" fill="none" stroke="#2563eb" stroke-width="2" viewBox="0 0 24 24">
                <path d="M19 9l-7 7-7-7"/>
              </svg>
            </div>
          </div>`;
        
        docListHTML = `
          <div class="doc-topic-list" style="margin-top: 1.5rem; border-top: 1px solid #e0e0e0; padding-top: 1rem;">
            <h4 style="margin-bottom: 1rem; font-weight: 600; font-size: 1.1rem;">Document-Topic Mapping</h4>
            ${filterHTML}
            <div style="max-height: 400px; overflow-y: auto; padding-right: 10px; border: 1px solid #e0e0e0; border-radius: 8px; padding: 15px; background: #fafafa;">
              <ul id="topic-mapping-list" style="list-style: none; padding: 0; margin: 0;">`;
        
        mapping.forEach(m => {
          const label = (m.label && String(m.label).trim()) ? m.label : `Topic ${m.topic}`;
          const conf  = Number.isFinite(Number(m.confidence)) ? Number(m.confidence).toFixed(1) : String(m.confidence || "");
          docListHTML += `
            <li class="topic-mapping-item" data-topic="${escapeHTML(label)}" style="padding: 10px 0; border-bottom: 1px solid #e8e8e8; display: flex; justify-content: space-between; align-items: center;">
              <span><strong style="color: #1e40af;">Doc ${m.doc_id}</strong> → ${escapeHTML(label)}</span>
              <span style="color: #666; font-size: 0.9rem; background: #e0e7ff; padding: 2px 8px; border-radius: 4px;">${conf}%</span>
            </li>`;
        });
        
        docListHTML += `
              </ul>
            </div>
          </div>`;
      }
      
      container.innerHTML = `
        <details class="topic-section">
          <summary style="font-weight:bold; color:#0074cc; font-size: 1.1em; cursor: pointer; padding: 10px; background: #f9f9f9; border-radius: 6px;">             Topic Modeling - ${grouped.length} topics identified</summary>
          <div style="max-height: 700px; overflow-y: auto; padding: 1.5rem; margin-top: 10px;">
            <h3 style="margin-bottom: 1.5rem; text-align: center;">Topic Distribution</h3>
            ${pieChartHTML}
            ${docListHTML}
          </div>
        </details>`;
      
      // Add filter event listener for topic mapping
      if (mapping.length > 1) {
        const filterSelect = document.getElementById('topic-filter');
        if (filterSelect) {
          filterSelect.addEventListener('change', (e) => {
            const selectedTopic = e.target.value;
            const mappingItems = document.querySelectorAll('.topic-mapping-item');
            
            mappingItems.forEach(item => {
              if (selectedTopic === 'all' || item.dataset.topic === selectedTopic) {
                item.style.display = 'flex';
              } else {
                item.style.display = 'none';
              }
            });
            
            // Update visible count
            const visibleCount = Array.from(mappingItems).filter(item => item.style.display !== 'none').length;
            console.log(`Showing ${visibleCount} of ${mappingItems.length} documents for topic: ${selectedTopic}`);
          });
        }
      }
      
    } else {
      // ✅ UNLABELED FILES: Multiple topics with percentages + pie chart
      const UNLABELED_THRESHOLD = 5.0;
      
      const isValidTopic = (label) => {
        if (!label || typeof label !== 'string') return false;
        const words = label.replace(/[•·]/g, ' ').trim().split(/\s+/).filter(Boolean);
        
        const loremIpsumWords = new Set([
          'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 
          'elit', 'sed', 'eiusmod', 'tempor', 'incididunt', 'labore', 'dolore',
          'magna', 'aliqua', 'ut', 'enim', 'ad', 'minim', 'veniam', 'quis',
          'nostrud', 'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip',
          'commodo', 'consequat', 'duis', 'aute', 'irure', 'reprehenderit',
          'voluptate', 'velit', 'esse', 'cillum', 'fugiat', 'nulla', 'pariatur',
          'excepteur', 'sint', 'occaecat', 'cupidatat', 'non', 'proident', 'sunt',
          'culpa', 'qui', 'officia', 'deserunt', 'mollit', 'anim', 'id', 'est'
        ]);
        
        const meaningfulWords = words.filter(w => {
          const cleanWord = w.toLowerCase();
          return cleanWord.length > 2 && 
                 !stopwords.has(cleanWord) && 
                 !loremIpsumWords.has(cleanWord);
        });
        
        return meaningfulWords.length > 0;
      };
      
      const relevantTopics = topics.filter(t => {
        const meetsThreshold = (t.percent || 0) >= UNLABELED_THRESHOLD;
        const isValid = isValidTopic(t.label);
        return meetsThreshold && isValid;
      });
      
      if (!relevantTopics.length) {
        container.innerHTML = `
          <details class="topic-section">
            <summary style="font-weight: bold; font-size: 1.2em; cursor: pointer; padding: 12px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; color: #1e40af;">
              Topic Modeling - No topics identified
            </summary>
            <div style="padding: 1.5rem; margin-top: 10px;">
              <h3 style="margin-bottom: 1rem;">Topic Modeling</h3>
              <p style="color:#666; font-size:15px; text-align:center; padding:40px; background:#f9fafb; border-radius:8px;">
                This document could not be mapped to any category.
              </p>
            </div>
          </details>`;
        return;
      }
      
      relevantTopics.sort((a, b) => (b.percent || 0) - (a.percent || 0));
      
      // Prepare data for pie chart
      const topicData = relevantTopics.map(t => ({
        label: (t.label && String(t.label).trim()) ? t.label : `Topic ${t.id}`,
        percent: Number.isFinite(t.percent) ? Number(t.percent.toFixed(2)) : 0
      }));
      
      const pieChartHTML = createPieChart(topicData);
      
      container.innerHTML = `
        <details class="topic-section">
          <summary style="font-weight: bold; font-size: 1.2em; cursor: pointer; padding: 12px; background: #f8fafc; border-radius: 8px; border: 1px solid #e2e8f0; color: #1e40af;">
            Topic Modeling - ${relevantTopics.length} topics identified
          </summary>
          <div style="max-height: 700px; overflow-y: auto; padding: 1.5rem; margin-top: 10px;">
            <h3 style="margin-bottom: 1.5rem; text-align: center;">Topic Distribution</h3>
            ${pieChartHTML}
          </div>
        </details>`;
    }
    
  } catch (err) {
    console.error("Topic modeling error:", err);
    let msg = err?.message || String(err);
    if (msg.includes("max_df")) {
      msg = "The uploaded file has too few valid documents or unique words. Please upload a file with more text content.";
    } else if (msg.includes("400")) {
      msg = "There was a problem analyzing the text. Please check your file format or try again.";
    }
    document.getElementById("topicModeling").innerHTML =
      `<span style="color:red;">${escapeHTML(msg)}</span>`;
  }
}

// ✅ Create professional pie chart visualization
// ✅ Create professional pie chart visualization with multi-column layout
function createPieChart(topics) {
  const colors = [
    '#2563eb', '#7c3aed', '#db2777', '#dc2626', '#ea580c',
    '#d97706', '#65a30d', '#059669', '#0891b2', '#4f46e5'
  ];
  
  const total = topics.reduce((sum, t) => sum + t.percent, 0);
  let currentAngle = -90; // Start at top
  
  const segments = topics.map((topic, idx) => {
    const percent = (topic.percent / total) * 100;
    const angle = (percent / 100) * 360;
    const endAngle = currentAngle + angle;
    
    const largeArc = angle > 180 ? 1 : 0;
    const startX = 50 + 40 * Math.cos((currentAngle * Math.PI) / 180);
    const startY = 50 + 40 * Math.sin((currentAngle * Math.PI) / 180);
    const endX = 50 + 40 * Math.cos((endAngle * Math.PI) / 180);
    const endY = 50 + 40 * Math.sin((endAngle * Math.PI) / 180);
    
    const pathData = [
      `M 50 50`,
      `L ${startX} ${startY}`,
      `A 40 40 0 ${largeArc} 1 ${endX} ${endY}`,
      `Z`
    ].join(' ');
    
    const result = {
      path: pathData,
      color: colors[idx % colors.length],
      label: topic.label,
      percent: topic.percent,
      index: idx
    };
    
    currentAngle = endAngle;
    return result;
  });
  
  // Function to handle pie slice hover
  const handlePieHover = (hoveredIndex) => {
    const paths = document.querySelectorAll('.pie-segment');
    const legendItems = document.querySelectorAll('.legend-item');
    
    paths.forEach((path, index) => {
      if (index === hoveredIndex) {
        path.style.opacity = '0.9';
        path.style.transform = 'scale(1.02)';
      } else {
        path.style.opacity = '0.6';
        path.style.transform = 'scale(1)';
      }
    });
    
    legendItems.forEach((item, index) => {
      if (index === hoveredIndex) {
        item.style.background = '#e0e7ff';
        item.style.border = '1px solid #3b82f6';
      } else {
        item.style.background = '#f8fafc';
        item.style.border = '1px solid transparent';
      }
    });
  };
  
  // Function to handle pie slice mouse leave
  const handlePieLeave = () => {
    const paths = document.querySelectorAll('.pie-segment');
    const legendItems = document.querySelectorAll('.legend-item');
    
    paths.forEach((path) => {
      path.style.opacity = '1';
      path.style.transform = 'scale(1)';
    });
    
    legendItems.forEach((item) => {
      item.style.background = '#f8fafc';
      item.style.border = '1px solid transparent';
    });
  };
  
  // Function to handle legend item hover
  const handleLegendHover = (hoveredIndex) => {
    const paths = document.querySelectorAll('.pie-segment');
    const legendItems = document.querySelectorAll('.legend-item');
    
    paths.forEach((path, index) => {
      if (index === hoveredIndex) {
        path.style.opacity = '0.9';
        path.style.transform = 'scale(1.02)';
      } else {
        path.style.opacity = '0.6';
        path.style.transform = 'scale(1)';
      }
    });
    
    legendItems.forEach((item, index) => {
      if (index === hoveredIndex) {
        item.style.background = '#e0e7ff';
        item.style.border = '1px solid #3b82f6';
      } else {
        item.style.background = '#f8fafc';
        item.style.border = '1px solid transparent';
      }
    });
  };
  
  // Function to handle legend mouse leave
  const handleLegendLeave = () => {
    const paths = document.querySelectorAll('.pie-segment');
    const legendItems = document.querySelectorAll('.legend-item');
    
    paths.forEach((path) => {
      path.style.opacity = '1';
      path.style.transform = 'scale(1)';
    });
    
    legendItems.forEach((item) => {
      item.style.background = '#f8fafc';
      item.style.border = '1px solid transparent';
    });
  };
  
  // Create multi-column layout for topics
  const createLegendColumns = () => {
    const itemsPerColumn = 10;
    const columns = [];
    
    for (let i = 0; i < segments.length; i += itemsPerColumn) {
      const columnItems = segments.slice(i, i + itemsPerColumn);
      const columnHTML = columnItems.map((seg, localIndex) => {
        const globalIndex = i + localIndex;
        return `
          <div class="legend-item" 
               style="display: flex; align-items: center; margin-bottom: 8px; padding: 6px 8px; border-radius: 6px; background: #f8fafc; transition: all 0.2s; cursor: pointer; border: 1px solid transparent;" 
               onmouseover="handleLegendHover(${globalIndex})" 
               onmouseout="handleLegendLeave()">
            <div style="width: 16px; height: 16px; background-color: ${seg.color}; border-radius: 4px; margin-right: 10px; flex-shrink: 0; box-shadow: 0 1px 2px rgba(0,0,0,0.1);"></div>
            <span style="font-size: 13px; flex: 1; line-height: 1.3;"><strong>${seg.label}</strong></span>
            <span style="font-size: 13px; color: #6366f1; font-weight: 600; margin-left: 6px; white-space: nowrap;">${seg.percent}%</span>
          </div>
        `;
      }).join('');
      
      columns.push(`
        <div style="flex: 1; min-width: 200px; margin-right: 1rem;">
          ${columnHTML}
        </div>
      `);
    }
    
    return columns.join('');
  };
  
  const svgPaths = segments.map((seg, idx) => `
    <path 
      class="pie-segment"
      data-index="${idx}"
      d="${seg.path}" 
      fill="${seg.color}" 
      stroke="white" 
      stroke-width="1" 
      style="transition: all 0.2s; cursor: pointer;"
      onmouseover="handlePieHover(${idx})"
      onmouseout="handlePieLeave()"
    />
  `).join('');
  
  // Add the helper functions to the global scope so they can be called from inline handlers
  if (typeof window.handlePieHover === 'undefined') {
    window.handlePieHover = handlePieHover;
    window.handlePieLeave = handlePieLeave;
    window.handleLegendHover = handleLegendHover;
    window.handleLegendLeave = handleLegendLeave;
  }
  
  return `
    <div style="display: flex; gap: 3rem; align-items: flex-start; justify-content: center; flex-wrap: wrap; margin: 2rem 0; padding: 2rem; background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
      <div style="position: relative; flex-shrink: 0;">
        <svg viewBox="0 0 100 100" style="width: 320px; height: 320px; filter: drop-shadow(0 4px 6px rgba(0,0,0,0.1));">
          ${svgPaths}
        </svg>
      </div>
      <div style="flex: 1; min-width: 300px; max-width: 800px;">
        <h4 style="margin-bottom: 1rem; font-size: 1.1rem; color: #1e293b;">Topics</h4>
        <div style="display: flex; flex-wrap: wrap; gap: 1rem; max-height: 400px; overflow-y: auto; padding-right: 10px;">
          ${createLegendColumns()}
        </div>
      </div>
    </div>`;
}



// Helper function to create distribution chart
function createDistributionChart(distribution, total) {
  const classes = Object.keys(distribution).sort();
  const maxCount = Math.max(...Object.values(distribution));
  
  return `
    <div class="distribution-chart">
      ${classes.map(className => {
        const count = distribution[className];
        const percentage = ((count / total) * 100).toFixed(1);
        const width = (count / maxCount) * 100;
        
        return `
          <div class="distribution-item">
            <div class="distribution-label">
              <span class="class-name">Class ${className}</span>
              <span class="class-stats">${count} (${percentage}%)</span>
            </div>
            <div class="distribution-bar">
              <div class="bar-fill" style="width: ${width}%"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}


// LABELED: Draw one class cloud into a canvas (with fallback to d3-cloud)
function drawWordCloud(canvasId, wordFreq) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const container = canvas.parentElement || document.getElementById("wordCloud") || document.body;

  // Normalize -> [["word", freq], ...]
  let pairs = [];
  if (Array.isArray(wordFreq)) {
    pairs = wordFreq.map(d =>
      Array.isArray(d) ? [String(d[0]), Number(d[1])]
                       : [String(d.term ?? d.word ?? ""), Number(d.frequency ?? d.count ?? 0)]
    );
  } else if (wordFreq && typeof wordFreq === "object") {
    pairs = Object.entries(wordFreq).map(([w, f]) => [String(w), Number(f)]);
  }
  pairs = pairs.filter(([w,f]) => w && Number.isFinite(f) && f > 0);

  const w = container.clientWidth || 900;
  const h = 500;
  canvas.width = w; canvas.height = h;
  const isDark = document.body.classList.contains("dark-mode");

  // Prefer wordcloud2.js
  if (typeof window.WordCloud === "function") {
    try {
      WordCloud(canvas, {
        list: pairs,
        gridSize: 10,
        shrinkToFit: true,
        drawOutOfBound: false,
        rotateRatio: 0.15,
        weightFactor: v => 8 + 2*Math.log(1+v),   // <-- size by frequency
        fontFamily: "Times, serif",
        color: "random-dark",
        backgroundColor: isDark ? "#121212" : "#ffffff"
      });
      return;
    } catch (e) {
      console.warn("wordcloud2 failed; falling back to d3-cloud", e);
    }
  }

  // Fallback to d3-cloud (SVG written next to the canvas)
  if (window.d3 && d3.layout && typeof d3.layout.cloud === "function") {
    const old = container.querySelector("svg.__d3_cloud_fallback");
    if (old) old.remove();

    const words = pairs.map(([text, freq]) => ({ text, size: 10 + 4*Math.log(1+freq) }));
    const color = (d3.schemeCategory10 || []).length ? d3.scaleOrdinal(d3.schemeCategory10) : () => (isDark ? "#f0f0f0" : "#333");

    const svg = d3.select(container)
      .append("svg").classed("__d3_cloud_fallback", true)
      .attr("width", w).attr("height", h)
      .append("g").attr("transform", `translate(${w/2},${h/2})`);

    function draw(placed) {
      svg.selectAll("text")
        .data(placed)
        .enter().append("text")
        .attr("text-anchor","middle")
        .style("font-family","Times, serif")
        .style("font-size", d => d.size + "px")
        .style("fill", d => color(d.text))
        .attr("transform", d => `translate(${d.x},${d.y}) rotate(${d.rotate})`)
        .text(d => d.text);
    }

    d3.layout.cloud()
      .size([w,h])
      .words(words)
      .padding(5)
      .rotate(() => (Math.random() < 0.15 ? 90 : 0))
      .font("Times, serif")
      .fontSize(d => d.size)
      .on("end", draw)
      .start();
    return;
  }

  // Last resort: message
  const msg = document.createElement("div");
  msg.style.color = "crimson";
  msg.style.margin = "8px 0";
  msg.textContent = "Word Cloud unavailable: library not loaded.";
  container.appendChild(msg);
}

document.addEventListener("DOMContentLoaded", function () {
  const csvRaw = sessionStorage.getItem("uploadedCSV");
  
  // ✅ ONLY parse if we don't already have processed data
  if (csvRaw && (!window.lastCSVData || window.lastCSVData.length === 0)) {
    console.log("🔄 No existing data found, parsing CSV...");
    
    Papa.parse(csvRaw, {
      header: true,
      skipEmptyLines: true,
      complete: function (results) {
        const row = results.data[0];
        const headers = Object.keys(row);

        let labelCol = null;
        let textCol = null;

        for (const h of headers) {
          const values = results.data.map(row => row[h]).filter(Boolean).map(v => v.toString().trim());
          const unique = [...new Set(values)];

          const isText = values.some(v => v.length > 20);
          const isLabel = unique.length > 0 && unique.every(v =>
            !isNaN(v) || ["spam", "ham", "not spam"].includes(v.toLowerCase())
          );

          if (!textCol && isText) textCol = h;
          if (!labelCol && isLabel) labelCol = h;
        }

        if (!textCol || !labelCol) {
          alert("❌ Could not detect text and label columns in CSV.");
          return;
        }

        const labeledData = results.data
          .map(row => {
            const label = row[labelCol]?.toString().trim();
            const text = row[textCol]?.toString().trim();
            return (label && text) ? { class: label, text } : null;
          })
          .filter(Boolean);

        // 👇 THIS is what your network chart needs
        window.lastCSVData = labeledData;

        const rowsText = labeledData.map(d => d.text); 
        sessionStorage.setItem("lastCSVTextRows", JSON.stringify(rowsText));

        // Re-render all visualizations
        rerender();
      }
    });
  } else if (csvRaw && window.lastCSVData && window.lastCSVData.length > 0) {
    console.log("✅ Using existing processed data, skipping re-parse");
    console.log(`📊 Data already has ${window.lastCSVData.length} rows with ${[...new Set(window.lastCSVData.map(r => r.class))].length} classes`);
  }
});

// === Coverage chart: re-render when "Top N Words" changes ===
window.addEventListener("DOMContentLoaded", () => {
  const wordLimitEl = document.getElementById("wordLimit");
  if (wordLimitEl) {
    wordLimitEl.addEventListener("change", () => {
      const rows = (window.lastCSVData || []).map(r => (r.text || "").toString());
      const includeStop = !!document.getElementById("includeStopwords")?.checked;
      generateCoverageChartServer(rows, includeStop);
    });
  }
});


async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  const raw = await r.text(); // read as text first (handles HTML error pages)
  let data = {};
  try {
    if ((r.headers.get('content-type') || '').includes('application/json')) {
      data = JSON.parse(raw);
    } else {
      data = JSON.parse(raw); // will throw if non-JSON; caught below
    }
  } catch (_) { /* keep data = {} and surface raw snippet on error */ }

  if (!r.ok) {
    const snippet = (data.detail || data.error || raw || '').slice(0, 300);
    throw new Error(`${url} ${r.status}: ${snippet}`);
  }
  return data;
}


function initializeClassSpecificPlots(data, visualizationType = 'all', activeClass = null) {
  console.log("📊 initializeClassSpecificPlots called with:", { 
    visualizationType, 
    activeClass,
    dataLength: data?.length || 0 
  });
  
  // ✅ FIXED: Better class detection that handles both formats
  let classesArray = [];
  
  // Debug: Check what's actually in the data
  console.log("🔍 Data sample:", data.slice(0, 3));
  
  // Check if we have multi-label data with labelNames
  const hasLabelNames = data.some(row => row.labelNames && Array.isArray(row.labelNames) && row.labelNames.length > 0);
  
  if (hasLabelNames) {
    // Multi-label format: get ALL unique labelNames across all rows
    const allLabelNames = new Set();
    data.forEach(row => {
      if (row.labelNames && Array.isArray(row.labelNames)) {
        row.labelNames.forEach(name => allLabelNames.add(name));
      }
    });
    classesArray = [...allLabelNames].sort();
    console.log("🏷️ Multi-label format detected - labelNames:", classesArray);
  } 
  // Check if we have labelColumns in sessionStorage
  else if (sessionStorage.getItem("labelColumns")) {
    try {
      const labelColumns = JSON.parse(sessionStorage.getItem("labelColumns"));
      console.log("🏷️ Using labelColumns from sessionStorage:", labelColumns);
      classesArray = labelColumns;
    } catch (e) {
      console.error("Failed to parse labelColumns:", e);
    }
  }
  // Fallback: single-label format
  else {
    const allClasses = new Set();
    data.forEach(row => {
      const classValue = row.class !== undefined ? row.class : row.label;
      if (classValue !== undefined && classValue !== null && classValue !== "-1") {
        allClasses.add(String(classValue));
      }
    });
    classesArray = [...allClasses].sort();
    console.log("🏷️ Single-label format detected - classes:", classesArray);
  }
  
  // Convert numeric classes to label format for tabs (0 -> "label0", 1 -> "label1")
  classesArray = classesArray.map(cls => {
    // If it's already in label format (label0, label1), keep it
    if (cls.startsWith('label')) return cls;
    // If it's numeric, convert to label format
    if (!isNaN(cls)) return `label${cls}`;
    // Otherwise keep as is
    return cls;
  });
  
  console.log("🏷️ Final classes for visualizations:", classesArray);
  

  if (classesArray.length === 0) {
    console.error("❌ No classes found in data!");
    return;
  }

  const shouldInitWordCloud = visualizationType === 'all' || visualizationType === 'wordcloud';
  const shouldInitNetwork = visualizationType === 'all' || visualizationType === 'network';
  const shouldInitCoverage = visualizationType === 'all' || visualizationType === 'coverage';
  const shouldInitZipf = visualizationType === 'all' || visualizationType === 'zipf';

  const defaultActiveClass = "all";

  // ========================================
  // WORD CLOUD - UPDATED with "All Data" tab
  // ========================================
  /*if (shouldInitWordCloud) {
    let initialWordCloudClass = activeClass || defaultActiveClass;
    console.log("🔍 Word Cloud initial class:", initialWordCloudClass);
    
    const wordCloudTabInfo = createClassTabs(
      classesArray,
      (className) => {
        console.log("🔍 Word Cloud tab clicked:", className);
        window.activeClass = className;
        renderWordCloudForClass(data, className);
      },
      'wordcloud',
      initialWordCloudClass
    );
    
    if (wordCloudTabInfo) {
      console.log("✅ Word Cloud tabs created with active:", wordCloudTabInfo.effectiveActiveClass);
      renderWordCloudForClass(data, wordCloudTabInfo.effectiveActiveClass);
    }
  }*/

  // ========================================
  // KEYWORD NETWORK - UPDATED with "All Data" tab
  // ========================================
  if (shouldInitNetwork) {
    let initialNetworkClass = activeClass || defaultActiveClass;
    
    const networkTabInfo = createClassTabs(classesArray, (className) => {
      console.log("🔍 Network tab clicked:", className);
      let textData;
      
      // In NETWORK section - replace the filtering
      if (className === "all") {
        textData = data.map(row => row.text || row.email || "");
      } else {
        // ✅ FIXED: Proper class filtering
        const targetClassNum = className.replace('label', '');
        const classData = data.filter(row => {
          // Handle multi-label format
          if (row.labelNames && Array.isArray(row.labelNames)) {
            return row.labelNames.includes(className);
          }
          // Handle single label format
          const rowClass = row.class !== undefined ? row.class : row.label;
          return String(rowClass || 'Unlabeled') === targetClassNum;
        });
        textData = classData.map(row => row.text || row.email || "");
      }
      
      const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
      const topN = parseInt(document.getElementById("topKeywordsInput")?.value, 10) || 100;
      const minCo = parseInt(document.getElementById("minCooccurrenceInput")?.value, 10) || 2;
      window.fetchAndRenderCooccurrence(textData, includeStopwords, topN, minCo, className);
    }, 'network', initialNetworkClass);
    
    if (networkTabInfo) {
      console.log("✅ Network tabs created");
      const firstClass = initialNetworkClass;
      let firstTextData;
      
      if (firstClass === "all") {
        firstTextData = data.map(row => row.text || row.email || "");
      } else {
        // ✅ FIXED: Proper class filtering for initial render
        const targetClassNum = firstClass.replace('label', '');
        const firstClassData = data.filter(row => {
          // Handle multi-label format
          if (row.labelNames && Array.isArray(row.labelNames)) {
            return row.labelNames.includes(firstClass);
          }
          // Handle single label format
          const rowClass = row.class !== undefined ? row.class : row.label;
          return String(rowClass || 'Unlabeled') === targetClassNum;
        });
        firstTextData = firstClassData.map(row => row.text || row.email || "");
      }
      
      const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
      const topN = parseInt(document.getElementById("topKeywordsInput")?.value, 10) || 100;
      const minCo = parseInt(document.getElementById("minCooccurrenceInput")?.value, 10) || 2;
      window.fetchAndRenderCooccurrence(firstTextData, includeStopwords, topN, minCo, firstClass);
    }
  }

  // ========================================
  // VOCABULARY COVERAGE - UPDATED with "All Data" tab
  // ========================================
  if (shouldInitCoverage) {
    let initialCoverageClass = activeClass || defaultActiveClass;
    
    const coverageTabInfo = createClassTabs(classesArray, (className) => {
      console.log("🔍 Coverage tab clicked:", className);
      let textData;
      
      // In COVERAGE section - replace the filtering
      if (className === "all") {
        textData = data.map(row => row.text || row.email || "");
      } else {
        // ✅ FIXED: Proper class filtering
        const targetClassNum = className.replace('label', '');
        const classData = data.filter(row => {
          // Handle multi-label format
          if (row.labelNames && Array.isArray(row.labelNames)) {
            return row.labelNames.includes(className);
          }
          // Handle single label format
          const rowClass = row.class !== undefined ? row.class : row.label;
          return String(rowClass || 'Unlabeled') === targetClassNum;
        });
        textData = classData.map(row => row.text || row.email || "");
      }
      
      const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
      const minRank = parseInt(document.getElementById("minRank")?.value, 10) || 1;
      const maxRank = parseInt(document.getElementById("maxRank")?.value, 10) || 10000;
      renderCoverageForClass(textData, includeStopwords, minRank, maxRank, className);
    }, 'coverage', initialCoverageClass);
    
    if (coverageTabInfo) {
      console.log("✅ Coverage tabs created");
      const initialClass = initialCoverageClass;
      let textData;
      
      if (initialClass === "all") {
        textData = data.map(row => row.text || row.email || "");
      } else {
        // ✅ FIXED: Filter by labelNames for multi-label format
        // Filter by label (works with expanded multi-label format)
        const classData = data.filter(row => {
          const labelValue = row.label !== undefined ? row.label : row.class;
          return String(labelValue || 'Unlabeled') === className;
        });
        textData = classData.map(row => row.text || row.email || "");
      }
      
      const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
      const minRank = parseInt(document.getElementById("minRank")?.value, 10) || 1;
      const maxRank = parseInt(document.getElementById("maxRank")?.value, 10) || 10000;
      renderCoverageForClass(textData, includeStopwords, minRank, maxRank, initialClass);
    }
  }

  // ========================================
  // ZIPF'S LAW - UPDATED with "All Data" tab
  // ========================================
  if (shouldInitZipf) {
    let initialZipfClass = activeClass || defaultActiveClass;
    
    const zipfTabInfo = createClassTabs(classesArray, (className) => {
      console.log("🔍 Zipf tab clicked:", className);
      let textData;
      
      // In ZIPF section - replace the filtering
      if (className === "all") {
        textData = data.map(row => row.text || row.email || "");
      } else {
        // ✅ FIXED: Proper class filtering
        const targetClassNum = className.replace('label', '');
        const classData = data.filter(row => {
          // Handle multi-label format
          if (row.labelNames && Array.isArray(row.labelNames)) {
            return row.labelNames.includes(className);
          }
          // Handle single label format
          const rowClass = row.class !== undefined ? row.class : row.label;
          return String(rowClass || 'Unlabeled') === targetClassNum;
        });
        textData = classData.map(row => row.text || row.email || "");
      }
      
      const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
      renderZipfForClass(textData, includeStopwords, className);
    }, 'zipf', initialZipfClass);
    
    if (zipfTabInfo) {
      console.log("✅ Zipf tabs created");
      const initialClass = initialZipfClass;
      let textData;
      
      if (initialClass === "all") {
        textData = data.map(row => row.text || row.email || "");
      } else {
        // ✅ FIXED: Filter by labelNames for multi-label format
        const classData = data.filter(row => {
          const labelValue = row.label !== undefined ? row.label : row.class;
          return String(labelValue || 'Unlabeled') === className;
        });
        textData = classData.map(row => row.text || row.email || "");
      }
      
      const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
      renderZipfForClass(textData, includeStopwords, initialClass);
    }
  }
}

function debugDataStructure(data) {
  console.log("🔍 DEBUG: Data structure analysis");
  if (!data || !data.length) {
    console.log("❌ No data available");
    return;
  }
  
  const sample = data[0];
  console.log("📋 Sample row structure:", Object.keys(sample));
  console.log("🏷️ Sample row content:", {
    label: sample.label,
    labelNames: sample.labelNames,
    text: sample.text ? sample.text.substring(0, 50) + "..." : "No text",
    activeIndices: sample.activeIndices,
    isMultiLabel: sample.isMultiLabel
  });
  
  // Check all unique labelNames across data
  const allLabelNames = new Set();
  data.forEach(row => {
    if (row.labelNames && Array.isArray(row.labelNames)) {
      row.labelNames.forEach(name => allLabelNames.add(name));
    }
  });
  console.log("🏷️ All unique labelNames in data:", Array.from(allLabelNames));
}

// Call this when you initialize
// debugDataStructure(window.lastCSVData);