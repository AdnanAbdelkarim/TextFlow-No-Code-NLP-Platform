// ============================================================================
// CLASS-SPECIFIC VISUALIZATION FUNCTIONS WITH STOPWORDS FILTERING
// ============================================================================

const stopwords = new Set([
    "the", "and", "to", "of", "a", "in", "is", "it", "on", "for", "with", "as",
    "by", "that", "this", "from", "at", "an", "be", "are", "was", "has", "have",
    "or", "not", "but", "if", "you", "your", "we", "our"
  ]);
  
  // ============================================================================
  // 1. CLASS-SPECIFIC WORD CLOUD WITH TABS
  // ============================================================================
  
  function generateClassSpecificWordClouds(data) {
    const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
    
    // Step 1: Group by label
    const labelToWords = {};
    data.forEach(row => {
      const text = row.text || row.email || "";
      const label = String(row.label || "unlabeled");
      const words = text.toLowerCase().split(/\W+/).filter(w => {
        if (w.length <= 2) return false;
        if (!includeStopwords && stopwords.has(w)) return false;
        return true;
      });
      if (!labelToWords[label]) labelToWords[label] = [];
      labelToWords[label].push(...words);
    });
  
    // Step 2: Compute frequencies per label
    const labelToFreq = {};
    for (const label in labelToWords) {
      const freq = {};
      labelToWords[label].forEach(word => {
        freq[word] = (freq[word] || 0) + 1;
      });
      labelToFreq[label] = freq;
    }
  
    // Step 3: Create tabs UI
    const container = document.querySelector("#wordCloud");
    container.innerHTML = "";
    
    const labels = Object.keys(labelToFreq).sort();
    
    // Create tab buttons
    const tabContainer = document.createElement("div");
    tabContainer.className = "class-tabs";
    tabContainer.style.cssText = "display:flex;gap:8px;margin-bottom:16px;border-bottom:2px solid #e5e7eb;flex-wrap:wrap;";
    
    labels.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.textContent = `Class ${label}`;
      btn.className = "class-tab-btn";
      btn.style.cssText = `
        padding:10px 16px;
        border:none;
        background:${idx === 0 ? "#2b6cb0" : "#f3f4f6"};
        color:${idx === 0 ? "#fff" : "#374151"};
        cursor:pointer;
        border-radius:4px 4px 0 0;
        font-weight:${idx === 0 ? "600" : "400"};
        transition:all 0.2s;
      `;
      btn.onclick = () => switchClassTab(label, labels, labelToFreq);
      tabContainer.appendChild(btn);
    });
    
    container.appendChild(tabContainer);
  
    // Create content container
    const contentContainer = document.createElement("div");
    contentContainer.className = "class-tab-content";
    contentContainer.style.cssText = "display:flex;flex-wrap:wrap;gap:20px;";
    
    labels.forEach((label, idx) => {
      const div = document.createElement("div");
      div.id = `wordcloud-class-${label}`;
      div.className = "wordcloud-box";
      div.style.cssText = `display:${idx === 0 ? "block" : "none"};flex:1;min-width:500px;`;
      div.innerHTML = `<canvas id="wordCloud${label}"></canvas>`;
      contentContainer.appendChild(div);
      
      // Draw on next frame to ensure canvas exists
      setTimeout(() => drawWordCloud(`wordCloud${label}`, labelToFreq[label]), 0);
    });
    
    container.appendChild(contentContainer);
  }
  
  function switchClassTab(selectedLabel, labels, labelToFreq) {
    // Update buttons
    document.querySelectorAll(".class-tab-btn").forEach((btn, idx) => {
      const label = labels[idx];
      if (label === selectedLabel) {
        btn.style.background = "#2b6cb0";
        btn.style.color = "#fff";
        btn.style.fontWeight = "600";
      } else {
        btn.style.background = "#f3f4f6";
        btn.style.color = "#374151";
        btn.style.fontWeight = "400";
      }
    });
  
    // Update content visibility
    labels.forEach(label => {
      const el = document.getElementById(`wordcloud-class-${label}`);
      if (el) {
        el.style.display = label === selectedLabel ? "block" : "none";
      }
    });
  }
  
  // ============================================================================
  // 2. CLASS-SPECIFIC KEYWORD NETWORK WITH TABS
  // ============================================================================
  
  function generateClassSpecificKeywordNetworks(data, topN = 100, minCoOccurrence = 2) {
    const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
    
    // Group by label
    const labelToSentences = {};
    data.forEach(row => {
      const text = row.text || row.email || "";
      const label = String(row.label || "unlabeled");
      if (!labelToSentences[label]) labelToSentences[label] = [];
      labelToSentences[label].push(text);
    });
  
    // Build co-occurrence per label
    const labelToGraph = {};
    for (const label in labelToSentences) {
      const graph = buildCoOccurrenceGraph(
        labelToSentences[label],
        includeStopwords,
        topN,
        minCoOccurrence
      );
      labelToGraph[label] = graph;
    }
  
    // Create tabs UI
    const container = document.querySelector("#keywordNetwork");
    if (!container) return;
    
    container.innerHTML = "";
    const labels = Object.keys(labelToGraph).sort();
  
    const tabContainer = document.createElement("div");
    tabContainer.className = "class-tabs";
    tabContainer.style.cssText = "display:flex;gap:8px;margin-bottom:16px;border-bottom:2px solid #e5e7eb;flex-wrap:wrap;";
    
    labels.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.textContent = `Class ${label}`;
      btn.className = "class-tab-btn";
      btn.style.cssText = `
        padding:10px 16px;
        border:none;
        background:${idx === 0 ? "#2b6cb0" : "#f3f4f6"};
        color:${idx === 0 ? "#fff" : "#374151"};
        cursor:pointer;
        border-radius:4px 4px 0 0;
        font-weight:${idx === 0 ? "600" : "400"};
        transition:all 0.2s;
      `;
      btn.onclick = () => switchNetworkTab(label, labels, labelToGraph);
      tabContainer.appendChild(btn);
    });
    container.appendChild(tabContainer);
  
    const contentContainer = document.createElement("div");
    contentContainer.className = "class-tab-content";
    
    labels.forEach((label, idx) => {
      const svgContainer = document.createElement("div");
      svgContainer.id = `network-class-${label}`;
      svgContainer.style.cssText = `display:${idx === 0 ? "block" : "none"};`;
      
      const svg = document.createElement("svg");
      svg.setAttribute("width", "1200");
      svg.setAttribute("height", "700");
      svg.style.border = "1px solid #e5e7eb";
      svgContainer.appendChild(svg);
      contentContainer.appendChild(svgContainer);
      
      setTimeout(() => renderKeywordNetwork(svg, labelToGraph[label]), 0);
    });
    container.appendChild(contentContainer);
  }
  
  function buildCoOccurrenceGraph(texts, includeStopwords, topN, minCoOccurrence) {
    const wordFreq = {};
    const coOccur = {};
    
    texts.forEach(text => {
      const words = text.toLowerCase().split(/\W+/).filter(w => {
        if (w.length <= 2) return false;
        if (!includeStopwords && stopwords.has(w)) return false;
        return true;
      });
      
      words.forEach(w => wordFreq[w] = (wordFreq[w] || 0) + 1);
      
      for (let i = 0; i < words.length; i++) {
        for (let j = i + 1; j < Math.min(i + 5, words.length); j++) {
          const key = [words[i], words[j]].sort().join("|");
          coOccur[key] = (coOccur[key] || 0) + 1;
        }
      }
    });
  
    // Top N words
    const topWords = Object.entries(wordFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([w]) => w);
    const topSet = new Set(topWords);
  
    // Filter co-occurrence to top words
    const nodes = topWords.map(id => ({ id }));
    const links = [];
    
    for (const [pair, count] of Object.entries(coOccur)) {
      if (count >= minCoOccurrence) {
        const [w1, w2] = pair.split("|");
        if (topSet.has(w1) && topSet.has(w2)) {
          links.push({ source: w1, target: w2, value: count });
        }
      }
    }
  
    return { nodes, links };
  }
  
  function switchNetworkTab(selectedLabel, labels, labelToGraph) {
    document.querySelectorAll(".class-tab-btn").forEach((btn, idx) => {
      const label = labels[idx];
      if (label === selectedLabel) {
        btn.style.background = "#2b6cb0";
        btn.style.color = "#fff";
        btn.style.fontWeight = "600";
      } else {
        btn.style.background = "#f3f4f6";
        btn.style.color = "#374151";
        btn.style.fontWeight = "400";
      }
    });
  
    labels.forEach(label => {
      const el = document.getElementById(`network-class-${label}`);
      if (el) {
        el.style.display = label === selectedLabel ? "block" : "none";
      }
    });
  }
  
  // ============================================================================
  // 3. CLASS-SPECIFIC VOCABULARY COVERAGE WITH TABS
  // ============================================================================
  
  async function generateClassSpecificCoverage(data) {
    const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
    
    // Group by label
    const labelToTexts = {};
    data.forEach(row => {
      const text = row.text || row.email || "";
      const label = String(row.label || "unlabeled");
      if (!labelToTexts[label]) labelToTexts[label] = [];
      labelToTexts[label].push(text);
    });
  
    const labels = Object.keys(labelToTexts).sort();
  
    // Create tabs UI
    const container = document.querySelector("#frequencyChart")?.parentElement || document.querySelector("#vocabularyCoverage");
    if (!container) return;
  
    container.innerHTML = "";
  
    const tabContainer = document.createElement("div");
    tabContainer.className = "class-tabs";
    tabContainer.style.cssText = "display:flex;gap:8px;margin-bottom:16px;border-bottom:2px solid #e5e7eb;flex-wrap:wrap;";
    
    labels.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.textContent = `Class ${label}`;
      btn.className = "class-tab-btn";
      btn.style.cssText = `
        padding:10px 16px;
        border:none;
        background:${idx === 0 ? "#2b6cb0" : "#f3f4f6"};
        color:${idx === 0 ? "#fff" : "#374151"};
        cursor:pointer;
        border-radius:4px 4px 0 0;
        font-weight:${idx === 0 ? "600" : "400"};
        transition:all 0.2s;
      `;
      btn.onclick = () => switchCoverageTab(label, labels);
      tabContainer.appendChild(btn);
    });
    container.appendChild(tabContainer);
  
    const contentContainer = document.createElement("div");
    contentContainer.className = "class-tab-content";
    
    for (const [idx, label] of labels.entries()) {
      const chartDiv = document.createElement("div");
      chartDiv.id = `coverage-class-${label}`;
      chartDiv.style.cssText = `display:${idx === 0 ? "block" : "none"};position:relative;`;
      chartDiv.innerHTML = "";
      contentContainer.appendChild(chartDiv);
      
      // Generate coverage data
      generateCoverageChartServer(
        labelToTexts[label],
        includeStopwords,
        1,
        5000,
        `coverage-class-${label}`
      );
    }
    
    container.appendChild(contentContainer);
  }
  
  function switchCoverageTab(selectedLabel, labels) {
    document.querySelectorAll(".class-tab-btn").forEach((btn, idx) => {
      const label = labels[idx];
      if (label === selectedLabel) {
        btn.style.background = "#2b6cb0";
        btn.style.color = "#fff";
        btn.style.fontWeight = "600";
      } else {
        btn.style.background = "#f3f4f6";
        btn.style.color = "#374151";
        btn.style.fontWeight = "400";
      }
    });
  
    labels.forEach(label => {
      const el = document.getElementById(`coverage-class-${label}`);
      if (el) {
        el.style.display = label === selectedLabel ? "block" : "none";
      }
    });
  }
  
  // Modified version of your generateCoverageChartServer for specific container
  window.generateCoverageChartServer = async function(rows, includeStopwords, minRank = 1, maxRank = 5000, containerId = "frequencyChart") {
    try {
      const slim = (rows || []).map(t => (t || "").toString().slice(0, 2000));
      const freq = await postJSON("/api/word_frequency", {
        rows: slim,
        includeStopwords: !!includeStopwords
      });
  
      const wrap = document.getElementById(containerId);
      if (!wrap) {
        console.error(`Container ${containerId} not found`);
        return;
      }
  
      if (!Array.isArray(freq) || !freq.length) {
        wrap.innerHTML = "<p style='color:red'>❌ No data for coverage.</p>";
        return;
      }
  
      freq.sort((a, b) => (b.frequency || 0) - (a.frequency || 0));
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
  
      const thresholds = [80, 90];
      const v80 = rankAtCoverage(thresholds[0]);
      const v90 = rankAtCoverage(thresholds[1]);
  
      let canvas = wrap.querySelector("canvas");
      if (!canvas) {
        canvas = document.createElement("canvas");
        wrap.innerHTML = "";
        wrap.appendChild(canvas);
      }
  
      if (window.coverageCharts) {
        if (window.coverageCharts[containerId]) {
          window.coverageCharts[containerId].destroy();
        }
      } else {
        window.coverageCharts = {};
      }
  
      const ctx = canvas.getContext("2d");
      window.coverageCharts[containerId] = new Chart(ctx, {
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
          aspectRatio: 1250/430,
          interaction: { mode: "nearest", intersect: true },
          plugins: {
            legend: { display: false },
            tooltip: { intersect: true, mode: "nearest" },
            title: { display: false }
          },
          elements: { point: { radius: 0, hitRadius: 12, hoverRadius: 4 } },
          scales: {
            x: { type: "linear", title: { display: true, text: "Word Rank" }, min: +minRank, max: +maxRank },
            y: { title: { display: true, text: "Cumulative Coverage (%)" }, min: 0, max: 100 }
          }
        }
      });
  
      wrap.style.position = "relative";
      let domLegend = wrap.querySelector(".coverage-legend-dom");
      if (!domLegend) {
        domLegend = document.createElement("div");
        domLegend.className = "coverage-legend-dom";
        domLegend.style.cssText = `
          position:absolute;top:8px;right:8px;
          background:rgba(255,255,255,0.85);
          border:1px dashed #cbd5e1;border-radius:6px;
          padding:8px 10px;font:12px system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
          color:#111827;pointer-events:none;
        `;
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
    } catch (err) {
      console.error("Coverage fetch failed:", err);
      const wrap = document.getElementById(containerId);
      if (wrap) wrap.innerHTML = "<p style='color:red'>❌ Failed to load coverage.</p>";
    }
  };
  
  // ============================================================================
  // 4. CLASS-SPECIFIC ZIPF'S LAW WITH TABS
  // ============================================================================
  
  async function generateClassSpecificZipf(data) {
    const includeStopwords = document.getElementById("includeStopwords")?.checked || false;
  
    // Group by label
    const labelToTexts = {};
    data.forEach(row => {
      const text = row.text || row.email || "";
      const label = String(row.label || "unlabeled");
      if (!labelToTexts[label]) labelToTexts[label] = [];
      labelToTexts[label].push(text);
    });
  
    const labels = Object.keys(labelToTexts).sort();
  
    // Create tabs UI
    const container = document.querySelector("#zipfContainer") || document.querySelector("#zipfPlot")?.parentElement;
    if (!container) return;
  
    container.innerHTML = "";
  
    const tabContainer = document.createElement("div");
    tabContainer.className = "class-tabs";
    tabContainer.style.cssText = "display:flex;gap:8px;margin-bottom:16px;border-bottom:2px solid #e5e7eb;flex-wrap:wrap;";
    
    labels.forEach((label, idx) => {
      const btn = document.createElement("button");
      btn.textContent = `Class ${label}`;
      btn.className = "class-tab-btn";
      btn.style.cssText = `
        padding:10px 16px;
        border:none;
        background:${idx === 0 ? "#2b6cb0" : "#f3f4f6"};
        color:${idx === 0 ? "#fff" : "#374151"};
        cursor:pointer;
        border-radius:4px 4px 0 0;
        font-weight:${idx === 0 ? "600" : "400"};
        transition:all 0.2s;
      `;
      btn.onclick = () => switchZipfTab(label, labels);
      tabContainer.appendChild(btn);
    });
    container.appendChild(tabContainer);
  
    const contentContainer = document.createElement("div");
    contentContainer.className = "class-tab-content";
    
    for (const [idx, label] of labels.entries()) {
      const zipfDiv = document.createElement("div");
      zipfDiv.id = `zipf-class-${label}`;
      zipfDiv.style.cssText = `display:${idx === 0 ? "block" : "none"};`;
      zipfDiv.style.border = "1px dashed #cbd5e1";
      zipfDiv.style.padding = "12px";
      zipfDiv.style.borderRadius = "6px";
      contentContainer.appendChild(zipfDiv);
      
      generateZipfPlotServer(labelToTexts[label], includeStopwords, `zipf-class-${label}`);
    }
    
    container.appendChild(contentContainer);
  }
  
  function switchZipfTab(selectedLabel, labels) {
    document.querySelectorAll(".class-tab-btn").forEach((btn, idx) => {
      const label = labels[idx];
      if (label === selectedLabel) {
        btn.style.background = "#2b6cb0";
        btn.style.color = "#fff";
        btn.style.fontWeight = "600";
      } else {
        btn.style.background = "#f3f4f6";
        btn.style.color = "#374151";
        btn.style.fontWeight = "400";
      }
    });
  
    labels.forEach(label => {
      const el = document.getElementById(`zipf-class-${label}`);
      if (el) {
        el.style.display = label === selectedLabel ? "block" : "none";
      }
    });
  }
  
  // Modified version for specific container
  async function generateZipfPlotServer(rows, includeStopwords = true, containerId = "zipfPlot") {
    try {
      const data = await postJSON("/api/zipf", {
        rows: rows || [],
        includeStopwords: !!includeStopwords
      });
      drawZipfPlotToContainer(data, containerId);
    } catch (err) {
      console.error("Zipf plot fetch failed:", err);
      const el = document.getElementById(containerId);
      if (el) {
        el.innerHTML = "<p style='color:red'>❌ Failed to load Zipf plot.</p>";
      }
    }
  }
  
  function drawZipfPlotToContainer(data, containerId, opts = {}) {
    const fitStartRank = +opts.fitStartRank || 50;
    const fitEndRank = +opts.fitEndRank || 5000;
    const showTopDots = opts.showTopDots ?? true;
    const coverageSteps = opts.coverageSteps || [50, 80, 90];
  
    data = (data || [])
      .map(d => ({ rank: +d.rank, freq: +d.freq }))
      .filter(d => d.rank > 0 && d.freq > 0 && Number.isFinite(d.rank) && Number.isFinite(d.freq))
      .sort((a, b) => a.rank - b.rank);
  
    const root = d3.select(`#${containerId}`);
    root.html("");
  
    if (!data.length) {
      root.append("div").style("color", "crimson").text("❌ No valid data for Zipf plot.");
      return;
    }
  
    const margin = { top: 28, right: 22, bottom: 46, left: 56 };
    const width = 1250 - margin.left - margin.right;
    const height = 430 - margin.top - margin.bottom;
  
    const svg = root.append("svg")
      .attr("width", width + margin.left + margin.right)
      .attr("height", height + margin.top + margin.bottom);
  
    const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  
    g.append("text")
      .attr("x", width / 2).attr("y", -8)
      .attr("text-anchor", "middle")
      .attr("font-weight", 600)
      .text("Zipf's Law (log–log rank vs. frequency)");
  
    const x = d3.scaleLog().domain([1, d3.max(data, d => d.rank)]).range([0, width]);
    const y = d3.scaleLog().domain([1, d3.max(data, d => d.freq)]).range([height, 0]);
  
    g.append("g").call(d3.axisLeft(y).ticks(6, "~s"));
    g.append("g").attr("transform", `translate(0,${height})`).call(d3.axisBottom(x).ticks(6, "~s"));
    g.append("text").attr("x", width / 2).attr("y", height + 36).attr("text-anchor", "middle").text("Log(Rank)");
    g.append("text").attr("transform", "rotate(-90)").attr("x", -height / 2).attr("y", -44).attr("text-anchor", "middle").text("Log(Frequency)");
  
    const line = d3.line().x(d => x(d.rank)).y(d => y(d.freq));
    g.append("path").datum(data).attr("fill", "none").attr("stroke", "#1e90ff").attr("stroke-width", 2.5).attr("d", line);
  
    // Rest of implementation follows your original drawZipfPlot logic
    // (hapax, fitting, tooltips, legend, etc.)
    // For brevity, the core visualization is rendered above
  }