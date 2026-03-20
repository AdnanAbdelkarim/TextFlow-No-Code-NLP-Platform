# --- minimal, safe top of main.py ---
import string
import os
import re
import logging
from collections import Counter, defaultdict
from flask import Flask, Response, request, jsonify, render_template, stream_with_context

from datetime import datetime
import spacy
from nltk import word_tokenize, pos_tag, ne_chunk
import nltk

print("👋 Flask app is starting...")
app = Flask(__name__, static_folder="static", template_folder="templates")
print("✅ Flask app created.")

# Download ALL required NLTK data
nltk.download('punkt', quiet=True)
nltk.download('averaged_perceptron_tagger', quiet=True)
nltk.download('maxent_ne_chunker', quiet=True)
nltk.download('words', quiet=True)
print("NLTK data downloaded successfully")

# --- ADD near your imports ---
from typing import List, Dict, Any

# Add near the top with other imports
from functools import lru_cache
import json
from typing import Dict, List, Any

import ssl

try:
    _create_unverified_https_context = ssl._create_unverified_context
except AttributeError:
    pass
else:
    ssl._create_default_https_context = _create_unverified_https_context




# --- ADD this helper (safe: only normalizes inputs) ---
def coerce_docs(payload: Dict[str, Any]) -> List[Dict[str, str]]:
    """
    Returns a list of {id, text}. Supports:
      - {"docs": [{id, text}, ...]}                      # preferred
      - {"rows":[{...}], "detectedTextCol": "email"}     # existing CSV
      - {"textData":{"text":"..."}}, or {"text":"..."}   # unlabeled fallback
    """
    # Preferred
    if isinstance(payload.get("docs"), list):
        docs = []
        for i, d in enumerate(payload["docs"]):
            if isinstance(d, dict) and "text" in d:
                docs.append({"id": d.get("id", f"doc-{i}"), "text": str(d["text"])})
            else:
                docs.append({"id": f"doc-{i}", "text": str(d)})
        return docs

    # Existing CSV (keep untouched)
    rows = payload.get("rows")
    text_col = payload.get("textCol") or payload.get("detectedTextCol")
    if isinstance(rows, list) and text_col:
        return [{"id": f"row-{i}", "text": str(r.get(text_col, ""))}
                for i, r in enumerate(rows) if isinstance(r, dict)]

    # Unlabeled fallbacks
    if isinstance(payload.get("textData"), dict) and "text" in payload["textData"]:
        return [{"id": "doc-0", "text": str(payload["textData"]["text"]).strip()}]
    if "text" in payload:
        return [{"id": "doc-0", "text": str(payload["text"]).strip()}]

    return []

def run_unlabeled_pipeline(docs: List[Dict[str, str]]) -> Dict[str, Any]:
    per_doc = []
    for d in docs:
        t = d["text"]
        per_doc.append({
            "id": d["id"],
            "length": len(t),
            "sentiment": analyze_sentiment(t),   # your existing funcs
            "entities": ner(t),
            "keywords": extract_keywords(t),
            "topics": lda_or_zeroshot_topics([t])  # returns 1-item result
        })
    # Optional: provide an aggregate for charts that expect a single series
    return {
        "mode": "unlabeled",
        "docs": per_doc,
        "aggregate": aggregate_across_docs(per_doc)  # implement if needed
    }

# --- safe caps (these DO NOT limit number of rows) ---
MAX_CHARS_PER_ROW   = 2000   # set to None to disable per-row truncation
MAX_TOKENS_PER_LINE = 80     # bounds per-line work for cooccurrence/zipf
MAX_TOPN            = 1000   # clamps only the "topN" param, not rows
ZIPF_MAX_RANK       = 50000  # bounds JSON size returned by zipf/frequency

TOPIC_MAX_CHARS_PER_DOC = 2000      # keep docs reasonable
TOPIC_MAX_FEATURES      = 3000      # bound vocabulary size
TOPIC_MIN_TOPICS        = 3
TOPIC_MAX_TOPICS        = 8


logging.basicConfig(level=logging.INFO)

# simple tokenizer
TOKEN_RE = re.compile(r"[A-Za-z0-9]+")

# stopwords (keep yours)
STOPWORDS = set([
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
])

'''
try:
    import spacy
    try:
        nlp = spacy.load("en_core_web_trf")
    except Exception:
        # Fallback so the route doesn't crash; this won't produce good NER,
        # but prevents a 500 if the model isn’t present.
        nlp = spacy.blank("en")
except Exception:
    nlp = None  # last-resort; guard routes below
'''

TOKEN_RE = re.compile(r"[A-Za-z0-9]+")

def _tokenize_rows(rows, include_stop):
    toks_all = []
    for line in rows:
        toks = [t.lower() for t in TOKEN_RE.findall(line or "")]
        if not include_stop:
            # very small stoplist; replace with your STOPWORDS if you prefer
            toks = [t for t in toks if len(t) > 1 and t not in STOPWORDS]
        toks_all.extend(toks)
    return toks_all


@lru_cache(maxsize=1)
def get_afinn():
    from afinn import Afinn
    return Afinn()

WORD_RE = re.compile(r"[A-Za-z]+")
def simple_tokenize(text: str):
    return [w for w in WORD_RE.findall((text or "").lower())
            if len(w) > 1 and w not in STOPWORDS]



@app.route("/api/preprocess_all_frequencies", methods=["POST"])
def preprocess_all_frequencies():
    """Pre-process frequency data for ALL classes upfront"""
    try:
        data = request.get_json(force=True) or {}
        rows = data.get("rows", [])
        include_stopwords = bool(data.get("includeStopwords", False))
        
        if not rows:
            return jsonify({"error": "No data provided"}), 400
        
        # Process all classes
        classes = list(set(row.get("label", "Unlabeled") for row in rows))
        results = {}
        
        for class_name in classes:
            # Filter data for this class
            if class_name == "all":
                class_data = rows
            else:
                class_data = [row for row in rows if str(row.get("label", "Unlabeled")) == class_name]
            
            # Extract text data
            text_data = [row.get("text", row.get("email", "")) for row in class_data]
            
            # Get frequency data
            freq_response = api_word_frequency_internal(text_data, include_stopwords)
            results[class_name] = freq_response
        
        # Also process "All Data"
        all_text_data = [row.get("text", row.get("email", "")) for row in rows]
        results["all"] = api_word_frequency_internal(all_text_data, include_stopwords)
        
        return jsonify({
            "status": "completed",
            "classes_processed": len(results),
            "results": results
        })
        
    except Exception as e:
        print("ERROR /api/preprocess_all_frequencies:", repr(e))
        return jsonify({"error": "preprocessing-failed", "detail": str(e)}), 500

# --- In your /api/analyze route, at the top ---
@app.post("/api/analyze")
def analyze():
    data = request.get_json(force=True)

    # If this is clearly labeled CSV, keep your current path:
    if ("rows" in data and (data.get("detectedTextCol") or data.get("textCol"))):
        return run_labeled_pipeline(data)  # <-- your existing function

    # Otherwise treat as unlabeled (DOCX/PDF or manual text)
    docs = coerce_docs(data)
    if not docs or all(not d["text"] for d in docs):
        return jsonify({"error": "No text to analyze"}), 400

    results = run_unlabeled_pipeline(docs)  # <-- add this thin wrapper (below)
    return jsonify(results), 200


@app.route('/')
def index():
    return render_template('index.html')


@app.route('/overview')
def overview():
    return render_template('overview.html')

@app.route('/advanced')
def advanced():
    return render_template('advanced.html')

@app.route('/visualizations')
def visualizations():
    return render_template('visualizations.html')

@app.route("/preprocessing")
def preprocessing():
    return render_template("preprocessing.html")

@app.route('/predictive')
def predictive():
    return render_template('predictive.html')

# Add this class for word cloud caching
class WordCloudCache:
    def __init__(self):
        self._cache = {}
    
    def get_cache_key(self, rows: List, include_stopwords: bool, className: str = "all") -> str:
        """Generate a unique cache key based on the input data and class"""
        text_content = "|".join(str(row) for row in rows[:100])  # Sample of text
        include_flag = "stop" if include_stopwords else "nostop"
        return f"wordcloud_{className}_{hash(text_content)}_{include_flag}"
    
    def store_frequency_data(self, rows: List, include_stopwords: bool, className: str, freq_data: List[Dict]):
        """Store frequency data for a specific class"""
        cache_key = self.get_cache_key(rows, include_stopwords, className)
        self._cache[cache_key] = {
            "freq_data": freq_data,
            "timestamp": datetime.now().isoformat(),
            "className": className,
            "row_count": len(rows)
        }
        print(f"✅ Python cache stored: {className} ({len(rows)} rows)")
    
    def get_frequency_data(self, rows: List, include_stopwords: bool, className: str):
        """Get cached frequency data for a specific class"""
        cache_key = self.get_cache_key(rows, include_stopwords, className)
        cached = self._cache.get(cache_key)
        if cached:
            print(f"✅ Python cache hit: {className}")
        return cached["freq_data"] if cached else None
    
    def clear_old(self, max_hours=24):
        """Clear cache entries older than max_hours"""
        now = datetime.now()
        cleared = 0
        for key in list(self._cache.keys()):
            cached_time = datetime.fromisoformat(self._cache[key]["timestamp"])
            if (now - cached_time).total_seconds() > max_hours * 3600:
                del self._cache[key]
                cleared += 1
        if cleared:
            print(f"🧹 Cleared {cleared} old Python cache entries")

wordcloud_cache = WordCloudCache()

# Add a route to get cached word frequencies
@app.route("/api/wordcloud_frequencies", methods=["POST"])
def get_wordcloud_frequencies():
    try:
        data = request.get_json(force=True) or {}
        rows = data.get("rows", [])
        include_stopwords = data.get("includeStopwords", False)
        className = data.get("className", "all")
        
        # Check cache first
        cached = wordcloud_cache.get_frequency_data(rows, include_stopwords, className)
        if cached:
            print(f"✅ Python cache hit for {className}")
            return jsonify({
                "frequencies": cached,
                "cached": True,
                "className": className
            })
        
        print(f"⏳ Computing word frequencies for {className} ({len(rows)} rows)")
        
        # Combine all text
        text = " ".join(str(row) for row in rows if row)
        
        # Tokenize and count frequencies
        words = []
        for word in TOKEN_RE.findall(text.lower()):
            if len(word) > 2:
                if not include_stopwords and word in STOPWORDS:
                    continue
                words.append(word)
        
        from collections import Counter
        freq_counter = Counter(words)
        
        # Convert to list of [word, frequency] sorted by frequency
        freq_data = [[word, freq] for word, freq in freq_counter.most_common()]
        
        # Cache the result (cache ALL classes, not just "all")
        wordcloud_cache.store_frequency_data(rows, include_stopwords, className, freq_data)
        
        return jsonify({
            "frequencies": freq_data,
            "cached": False,
            "className": className
        })
        
    except Exception as e:
        print(f"Word cloud frequencies error: {e}")
        return jsonify({"error": str(e)}), 500
def api_word_frequency_internal(rows, include_stop):
    """Internal version of word_frequency that returns data directly (no JSON response)"""
    tokens = []
    for r in rows:
        if isinstance(r, str):
            s = r
        else:
            s = str(r or "")
        if MAX_CHARS_PER_ROW:
            s = s[:MAX_CHARS_PER_ROW]

        t = _tok(s, include_stop)
        if len(t) > MAX_TOKENS_PER_LINE:
            t = t[:MAX_TOKENS_PER_LINE]
        tokens.extend(t)

    counts = Counter(tokens)
    result = [
        {"word": w, "frequency": int(c)}
        for w, c in counts.most_common(ZIPF_MAX_RANK)
    ]
    return result



@app.post("/api/extract_entities")
def extract_entities():
    data = request.get_json(force=True) or {}
    text = data.get("text", "")
    
    if not text:
        return jsonify({"entities": []})
    
    try:
        # Tokenize and tag
        tokens = word_tokenize(text[:10000])  # Limit text length
        tagged = pos_tag(tokens)
        
        # Named Entity Recognition
        chunked = ne_chunk(tagged, binary=False)
        
        entities = []
        for subtree in chunked:
            if isinstance(subtree, Tree):
                entity_text = " ".join([token for token, pos in subtree.leaves()])
                entity_label = subtree.label()
                entities.append({
                    "text": entity_text,
                    "label": entity_label
                })
        
        return jsonify({"entities": entities})
    except Exception as e:
        print(f"NER error: {e}")
        return jsonify({"entities": []})

wordcloud_cache = WordCloudCache()

# Modify your existing word_frequency endpoint to support caching
@app.route("/api/word_frequency", methods=["POST"])
def api_word_frequency():
    try:
        data = request.get_json(force=True) or {}
        rows = data.get("rows", []) or []
        include_stop = bool(data.get("includeStopwords", False))
        
        # Check if this is a cache preload request
        is_cache_request = data.get("preload_cache", False)

        print(f"🔍 word_frequency: include_stop={include_stop}, rows={len(rows)}, cache_preload={is_cache_request}")

        tokens = []
        for r in rows:
            if isinstance(r, str):
                s = r
            elif isinstance(r, dict):
                s = str(r.get("text") or r.get("Message") or "")
            else:
                s = str(r or "")
            if MAX_CHARS_PER_ROW:
                s = s[:MAX_CHARS_PER_ROW]

            t = _tok(s, include_stop)
            if len(t) > MAX_TOKENS_PER_LINE:
                t = t[:MAX_TOKENS_PER_LINE]
            tokens.extend(t)

        counts = Counter(tokens)
        result = [
            {"word": w, "frequency": int(c)}
            for w, c in counts.most_common(ZIPF_MAX_RANK)
        ]
        
        # Store in cache if this is a preload request
        if is_cache_request:
            wordcloud_cache.store_frequency_data(rows, include_stop, result)
            print(f"✅ Pre-cached word frequency data: {len(result)} words")
        
        print(f"✅ word_frequency: {len(result)} unique words")
        
        return jsonify(result)
    except Exception as e:
        print("ERROR /api/word_frequency:", repr(e))
        return jsonify({"error": "word_frequency-failed", "detail": str(e)}), 500

@app.route('/api/label_distribution', methods=['POST'])
def label_distribution():
    data = request.get_json()
    rows = data.get("lines", [])  # FIXED from 'data' to 'lines'

    #print("🚀 Received lines:", rows)  # ←✅ Add this here

    label_counts = Counter()
    for row in rows:
        match = re.match(r"^\[(.+?)\]", row)
        if match:
            label = match.group(1)
            label_counts[label] += 1

    return jsonify(dict(label_counts))

# keep your existing imports and STOPWORDS definition above



TOKEN_RE = re.compile(r"[A-Za-z0-9]+")

try:
    STOPWORDS
except NameError:
    STOPWORDS = set((
        "a an and are as at be but by for if in into is it no not of on or such "
        "that the their then there these they this to was will with you your our we"
    ).split())

def _tok(text, include_stop):
    """Tokenize text and optionally filter stopwords."""
    tokens = [t.lower() for t in TOKEN_RE.findall(text or "")]
    
    # CONSISTENT: Always filter short words (2 characters or less)
    min_length = 2  # Or 3 if you want to be more strict
    tokens = [t for t in tokens if len(t) > min_length]
    
    if not include_stop:
        # Only filter stopwords when include_stop is False
        tokens = [t for t in tokens if t not in STOPWORDS]
    
    return tokens

@app.route("/api/cooccurrence", methods=["POST"])
def api_cooccurrence():
    try:
        data = request.get_json(force=True) or {}
        rows = data.get("rows", []) or []
        include_stop = bool(data.get("includeStopwords", True))  # Default True to match old behavior
        top_n = int(data.get("topN", 100))
        min_co = int(data.get("minCooccurrence", 2))

        top_n = max(1, min(MAX_TOPN, top_n))
        min_co = max(1, min(1000, min_co))

        # Normalize rows to strings
        texts = []
        for r in rows:
            if isinstance(r, str):
                s = r
            elif isinstance(r, dict):
                s = str(r.get("text") or r.get("Message") or "")
            else:
                s = str(r or "")
            if MAX_CHARS_PER_ROW:
                s = s[:MAX_CHARS_PER_ROW]
            texts.append(s)

        # FIXED: Pass 1 - Document Frequency for vocabulary (with stopword filtering)
        term_df = Counter()
        for line in texts:
            toks = _tok(line, include_stop)  # ← Use include_stop here
            if len(toks) > MAX_TOKENS_PER_LINE:
                toks = toks[:MAX_TOKENS_PER_LINE]
            if toks:
                term_df.update(set(toks))  # Unique tokens per document

        pad = max(top_n * 3, 30)
        vocab = [w for w, _ in term_df.most_common(max(top_n, pad))]
        vset = set(vocab)

        print(f"🔍 Cooccurrence: include_stop={include_stop}, vocab_size={len(vocab)}, top_n={top_n}")
        print(f"📝 Sample vocab (first 20): {vocab[:20]}")

        # FIXED: Pass 2 - Count pairs (already filtered by vocab which respects stopwords)
        pair_counts = Counter()
        for line in texts:
            toks = _tok(line, include_stop)  # ← Use include_stop here too
            if len(toks) > MAX_TOKENS_PER_LINE:
                toks = toks[:MAX_TOKENS_PER_LINE]
            uniq = sorted({w for w in toks if w in vset})  # Only use words in vocab
            n = len(uniq)
            for i in range(n):
                a = uniq[i]
                for j in range(i + 1, n):
                    b = uniq[j]
                    pair_counts[(a, b)] += 1

        # Filter edges by min co-occurrence
        edges = [(a, b, c) for (a, b), c in pair_counts.items() if c >= min_co]
        if not edges:
            return jsonify({"nodes": [], "links": []})

        # Node strength on the filtered graph
        strength = defaultdict(int)
        for a, b, c in edges:
            strength[a] += c
            strength[b] += c

        # Top-N nodes by strength
        ordered = sorted(strength.items(), key=lambda kv: (-kv[1], kv[0]))
        keep = {w for w, _ in ordered[:top_n]}

        # Keep only edges among kept nodes
        edges = [(a, b, c) for (a, b, c) in edges if a in keep and b in keep]
        if not edges:
            return jsonify({"nodes": [], "links": []})

        node_ids = sorted({w for a, b, _ in edges for w in (a, b)})
        
        print(f"✅ Final network: {len(node_ids)} nodes, {len(edges)} edges")
        print(f"📝 Sample nodes: {node_ids[:20]}")
        
        nodes_out = [{"id": w} for w in node_ids]
        links_out = [{"source": a, "target": b, "value": int(c)} for (a, b, c) in edges]

        return jsonify({"nodes": nodes_out, "links": links_out})
    except Exception as e:
        print("ERROR /api/cooccurrence:", repr(e))
        import traceback
        traceback.print_exc()
        return jsonify({"error": "cooccurrence-failed", "detail": str(e)}), 500

def compute_coverage(text, include_stopwords):
    # Normalize and tokenize
    words = text.lower().translate(str.maketrans("", "", string.punctuation)).split()
    
    if not include_stopwords:
        words = [w for w in words if w not in STOPWORDS and len(w) > 2]
    else:
        words = [w for w in words if len(w) > 2]
    
    total = len(words)
    counter = Counter(words)
    sorted_words = counter.most_common()
    
    cumulative = 0
    coverage_data = []
    
    for i, (word, freq) in enumerate(sorted_words):
        cumulative += freq
        coverage = round((cumulative / total) * 100, 2)
        coverage_data.append({
            "rank": i + 1,
            "word": word,
            "frequency": freq,
            "coverage": coverage
        })

    return coverage_data

@app.route("/api/coverage", methods=["POST"])
def api_coverage():
    data = request.get_json(force=True) or {}
    rows = data.get("rows", []) or []
    include_stop = bool(data.get("includeStopwords", False))
    min_rank = int(data.get("minRank", 1))
    max_rank = int(data.get("maxRank", 10000))

    tokens = _tokenize_rows(rows, include_stop)
    counts = Counter(tokens)
    if not counts:
        return jsonify({"ranks": [], "coverage": []})

    # ranks by frequency
    vocab = [w for w, _ in counts.most_common()]
    start = max(1, min_rank) - 1
    end = min(max_rank, len(vocab))

    total_tokens = sum(counts.values())
    seen = 0
    ranks = []
    covs = []
    for rank in range(start, end):
        w = vocab[rank]
        seen += counts[w]
        ranks.append(rank + 1)
        covs.append(seen / total_tokens)

    return jsonify({"ranks": ranks, "coverage": covs})

@app.route('/api/zipf', methods=['POST'])
def zipf():
    try:
        data = request.get_json(force=True) or {}
        rows = data.get("rows", []) or []
        include_stopwords = bool(data.get("includeStopwords", True))

        words = []
        for r in rows:
            if isinstance(r, str):
                s = r
            elif isinstance(r, dict):
                s = str(r.get("text") or r.get("Message") or "")
            else:
                s = str(r or "")
            if MAX_CHARS_PER_ROW:
                s = s[:MAX_CHARS_PER_ROW]

            toks = _tok(s, include_stopwords)
            if len(toks) > MAX_TOKENS_PER_LINE:
                toks = toks[:MAX_TOKENS_PER_LINE]
            words.extend(toks)

        if not words:
            return jsonify([])

        counter = Counter(words)
        sorted_items = counter.most_common(ZIPF_MAX_RANK)

        zipf_data = [
            {"rank": i + 1, "word": word, "freq": int(freq)}
            for i, (word, freq) in enumerate(sorted_items)
        ]
        return jsonify(zipf_data)
    except Exception as e:
        print("ERROR /api/zipf:", repr(e))
        return jsonify({"error": "zipf-failed", "detail": str(e)}), 500

#ADVANCED PAGE
@lru_cache(maxsize=1)
def get_nlp():
    try:
        # Try to load the transformer model first
        nlp = spacy.load("en_core_web_trf", disable=["parser", "lemmatizer", "textcat"])
    except Exception as e:
        print(f"Failed to load en_core_web_trf: {e}. Trying en_core_web_sm...")
        try:
            # Fallback to the small model
            nlp = spacy.load("en_core_web_sm", disable=["parser", "lemmatizer", "textcat"])
        except Exception as e2:
            print(f"Both spaCy models failed: {e2}. Using blank model...")
            # Last resort
            nlp = spacy.blank("en")
    
    # Keep memory in check
    nlp.max_length = int(os.getenv("SPACY_MAX_LENGTH", 1_000_000))
    return nlp



def get_nltk_ner(text):
    """
    Extract named entities using NLTK's built-in NE chunker.
    Returns a list of dictionaries with text, label, and source.
    """
    try:
        if not text or len(text.strip()) == 0:
            return []

        # Limit text size for performance
        text = text[:5000]

        # Tokenize and POS tag
        tokens = word_tokenize(text)
        tagged_tokens = pos_tag(tokens)

        # Named Entity Chunking
        tree = ne_chunk(tagged_tokens)

        entities = []

        for subtree in tree:
            if hasattr(subtree, 'label'):
                ent_text = ' '.join(c[0] for c in subtree.leaves())
                entities.append({
                    "text": ent_text,
                    "label": subtree.label(),  # e.g., PERSON, ORGANIZATION, GPE
                    "source": "nltk"
                })

        # Optional: remove duplicates
        unique_entities = []
        seen = set()
        for ent in entities:
            key = (ent["text"].lower(), ent["label"])
            if key not in seen:
                seen.add(key)
                unique_entities.append(ent)

        print(f"NLTK found {len(unique_entities)} entities")
        return unique_entities

    except Exception as e:
        print(f"NLTK NER error: {e}")
        import traceback
        traceback.print_exc()
        return []

def clean_spacy_entities(entities):
    """
    Deduplicate spaCy entities and apply label preferences for ambiguous cases.
    """
    seen_texts = {}
    cleaned_entities = []

    # Define preferred labels for specific words
    preferred_labels = {
        "number": "CARDINAL",  # "NUMBER" should be CARDINAL, not ORG/PRODUCT
        # Add more if needed
    }

    for e in entities:
        text_lower = e['text'].lower()

        # Apply preferred label if exists
        if text_lower in preferred_labels:
            e['label'] = preferred_labels[text_lower]

        # Skip if we already added this text
        if text_lower in seen_texts:
            continue

        seen_texts[text_lower] = e['label']
        cleaned_entities.append(e)

    return cleaned_entities


# Temporary cache for entities
ner_cache = {
    "spacy": [],
    "nltk": [],
    "text_length": 0
}

@app.post("/ner")
def ner_alias():
    global ner_cache
    data = request.get_json(force=True) or {}
    text = (data.get("text") or "").strip()
    ner_method = data.get("ner_method", "both")  # 'spacy', 'nltk', or 'both'

    # If text is empty
    if not text:
        return jsonify({"entities": []})

    # Check if we already processed this text
    if ner_cache["text_length"] != len(text):
        print("Processing text for the first time...")
        ner_cache["text_length"] = len(text)
        ner_cache["spacy"] = []
        ner_cache["nltk"] = []

        # spaCy NER
        try:
            chunk_size = 5000
            spacy_ents = []
            for i in range(0, len(text), chunk_size):
                doc = get_nlp()(text[i:i+chunk_size])
                spacy_ents.extend([{
                    "text": e.text,
                    "label": e.label_,
                    "start_char": int(e.start_char) + i,
                    "end_char": int(e.end_char) + i,
                    "source": "spacy"
                } for e in doc.ents])
            ner_cache["spacy"] = clean_spacy_entities(spacy_ents)
            print(f"spaCy processed: {len(ner_cache['spacy'])} entities")
        except Exception as e:
            print(f"spaCy NER error: {e}")

        # NLTK NER
        try:
            nltk_ents = get_nltk_ner(text)
            ner_cache["nltk"] = nltk_ents
            print(f"NLTK processed: {len(nltk_ents)} entities")
        except Exception as e:
            print(f"NLTK NER error: {e}")

    # Return only requested method
    result_entities = []
    if ner_method == "spacy":
        result_entities = ner_cache["spacy"]
    elif ner_method == "nltk":
        result_entities = ner_cache["nltk"]
    elif ner_method == "both":
        # merge both, remove duplicates
        combined = ner_cache["spacy"] + ner_cache["nltk"]
        seen = set()
        unique_entities = []
        for ent in combined:
            key = (ent["text"].lower(), ent["label"])
            if key not in seen:
                seen.add(key)
                unique_entities.append(ent)
        result_entities = unique_entities

    return jsonify({"entities": result_entities})


@app.post("/api/ner")
def ner_api_alias():
    return ner_alias()



@app.route('/sentiment', methods=['POST'])
def sentiment():
    data = request.json
    text = data.get('text', '')

    if not text.strip():
        return jsonify({'error': 'Empty text received.'}), 400

    try:
        afinn = get_afinn()  # ← lazy-load here

        is_labeled = bool(re.match(r"^\[\d+\]", text.strip()))
        results = []
        sentence_counter = 1

        if is_labeled:
            lines = text.strip().splitlines()
            for line in lines:
                match = re.match(r"^\[(\d+)\]\s*(.*)", line)
                if not match:
                    continue
                label = int(match[1])
                content = match[2]
                sentences = re.split(r"[.?!]\s+", content)
                for sentence in sentences:
                    if sentence.strip():
                        score = afinn.score(sentence)
                        if score > 0:
                            sentiment = "Positive"; color = "green"
                        elif score < 0:
                            sentiment = "Negative"; color = "red"
                        else:
                            sentiment = "Neutral";  color = "#999"
                        results.append({
                            "sentence_id": sentence_counter,
                            "label": label,
                            "text": sentence.strip(),
                            "score": score,
                            "sentiment": sentiment,
                            "color": color
                        })
                        sentence_counter += 1
        else:
            sentences = re.split(r"[.?!]\s+", text)
            for sentence in sentences:
                if sentence.strip():
                    score = afinn.score(sentence)
                    if score > 0:
                        sentiment = "Positive"; color = "green"
                    elif score < 0:
                        sentiment = "Negative"; color = "red"
                    else:
                        sentiment = "Neutral";  color = "#999"
                    results.append({
                        "sentence_id": sentence_counter,
                        "label": None,
                        "text": sentence.strip(),
                        "score": score,
                        "sentiment": sentiment,
                        "color": color
                    })
                    sentence_counter += 1

        return jsonify({"results": results})

    except Exception as e:
        return jsonify({"error": str(e)}), 500




@lru_cache(maxsize=1)
def get_kw_model():
    from keybert import KeyBERT
    return KeyBERT()

# ✅ Expanded category map
# === RICH CATEGORY MAP (drop-in replacement) ===
category_map = {
    "AI & Machine Learning": {"ai","ml","machine","learning","model","training","inference","classification","regression","clustering","feature","pipeline","autoML","sklearn","tensorflow","pytorch"},
    "Natural Language Processing": {"nlp","text","token","embedding","bert","transformer","topic","ner","sentiment","lemmatization","stemming","language","corpus","chatbot"},
    "Computer Vision": {"vision","image","video","object","detection","segmentation","yolo","opencv","cnn","recognition","ocr","keypoints","bounding"},
    "Data Engineering": {"etl","elt","ingest","pipeline","airflow","prefect","dbt","orchestration","batch","stream","kafka","spark","delta","iceberg"},
    "Databases & Storage": {"sql","nosql","postgres","mysql","sqlite","mongodb","index","query","transaction","warehouse","lake","backup","replication"},
    "Big Data & Analytics": {"spark","hadoop","hive","presto","athena","parquet","olap","bi","dashboard","analytics","cube","snowflake","powerbi","tableau"},
    "Cloud Platforms": {"aws","azure","gcp","bucket","s3","ec2","lambda","cloudrun","functions","iam","vpc","gke","eks","aks"},
    "DevOps & CI/CD": {"devops","ci","cd","gitlab","github","actions","jenkins","docker","container","kubernetes","helm","terraform","ansible","monitoring"},
    "APIs & Integration": {"api","rest","graphql","endpoint","webhook","oauth","jwt","rate","throttle","sdk","contract","swagger","openapi"},
    "Web Development": {"html","css","javascript","typescript","react","vue","angular","next","node","express","flask","django","frontend","backend","fullstack"},
    "Mobile Apps": {"android","ios","swift","kotlin","flutter","reactnative","apk","ipa","play","appstore","push","mobile"},
    "Networking": {"tcp","udp","ip","dns","dhcp","latency","bandwidth","firewall","router","switch","proxy","loadbalancer","tls"},
    "Cybersecurity": {"security","breach","attack","phishing","malware","ransomware","encryption","key","token","zero","siem","soc","vulnerability","patch"},
    "Privacy & Compliance": {"gdpr","hipaa","pci","sox","iso","compliance","policy","consent","retention","dpa","audit"},
    "Identity & Access": {"auth","authentication","authorization","sso","saml","oauth","openid","mfa","password","role","iam"},
    "Logging & Observability": {"log","metrics","tracing","otel","prometheus","grafana","sentry","datadog","alert","dashboard"},
    "Math & Statistics": {"statistics","probability","distribution","bayes","regression","anova","hypothesis","correlation","pvalue","feature","normalization"},
    "Optimization & OR": {"optimization","linear","integer","lp","ilp","solver","heuristic","metaheuristic","constraint","schedule","routing"},
    "Blockchain & Web3": {"blockchain","crypto","ethereum","solidity","smart","contract","wallet","nft","defi","ledger"},
    "IoT & Edge": {"iot","sensor","edge","mqtt","telemetry","firmware","gateway","device","embedded","rtos"},
    "GIS & Mapping": {"map","gis","geospatial","coordinate","latitude","longitude","geocode","leaflet","arcgis","shapefile"},
    "Robotics & Automation": {"robot","ros","autonomous","drone","navigation","actuator","sensor","slam","path"},
    "Finance & FinTech": {"bank","loan","credit","debit","payment","gateway","ledger","account","interest","forex","trading","wallet","fintech"},
    "Accounting": {"invoice","expense","reconciliation","ledger","journal","payable","receivable","audit","closing","statement"},
    "Insurance": {"policy","premium","claim","underwriting","risk","actuary","coverage","broker"},
    "Real Estate": {"property","mortgage","lease","tenant","landlord","valuation","listing","zillow","mls"},
    "Healthcare & Medicine": {"patient","clinical","diagnosis","treatment","hospital","clinic","ehr","radiology","lab","vaccine","symptom"},
    "Pharma & Biotech": {"trial","phase","protocol","drug","compound","assay","molecule","gene","biomarker"},
    "Education & EdTech": {"student","course","curriculum","lesson","exam","lms","mooc","teacher","classroom","university"},
    "Marketing & Growth": {"campaign","advertisement","ad","seo","sem","branding","crm","lead","conversion","funnel","retention"},
    "Sales & CRM": {"deal","pipeline","quote","opportunity","account","contact","crm","territory","forecast"},
    "Customer Support": {"ticket","helpdesk","sla","csat","nps","chat","knowledge","faq","zendesk","freshdesk"},
    "Retail & E-commerce": {"catalog","product","cart","checkout","order","inventory","sku","price","discount","delivery","return"},
    "Logistics & Supply Chain": {"warehouse","shipment","freight","tracking","route","fleet","3pl","inventory","forecasting","procurement"},
    "Automotive & EV": {"vehicle","vin","ecu","can","ev","battery","charging","station","motor","telemetry"},
    "Energy & Utilities": {"grid","power","electricity","gas","oil","renewable","solar","wind","meter","tariff"},
    "Manufacturing & Industry 4.0": {"factory","plc","scada","mes","bom","quality","oee","maintenance","predictive"},
    "Government & Public Sector": {"policy","regulation","permit","tender","procurement","census","public","municipal"},
    "Legal": {"contract","agreement","clause","case","litigation","compliance","privacy","license","ip","dispute"},
    "Human Resources": {"employee","hiring","recruitment","interview","onboarding","payroll","benefits","performance","resignation"},
    "Media & Entertainment": {"content","streaming","video","audio","music","license","ad","rights","broadcast"},
    "Agriculture": {"farm","crop","yield","soil","irrigation","livestock","drone","satellite"},
    "Construction & Engineering": {"project","contractor","bid","tender","blueprint","permit","inspection","compliance","safety"},
    "Sustainability & Environment": {"climate","carbon","emission","offset","recycle","waste","footprint","sustainability","green","energy"},
    "Email & Messaging": {"email","newsletter","unsubscribe","inbox","gmail","outlook","smtp","imap","groups","list","thread","message"},
    "Web & URLs": {"url","link","hyperlink","domain","website","http","https","www","page"},
    "Spam & Promotions": {"spam","promotion","promo","discount","coupon","offer","sale","deal", "lottery","winner","prize","free","click","urgent"},
    "E-commerce & Marketplaces": {"ebay","amazon","aliexpress","marketplace","seller","buyer","auction","bid", "cart","checkout","order","item","price","shipping","return"},
    "Travel & Hospitality": {"booking","reservation","flight","hotel","tour","guest","checkin","loyalty", "airport","airline","flight","hotel","marriott","reservation","booking", "checkin","checkout","luggage","visa","passport"},
    "Sports": {"sports","football","soccer","nfl","nba","match","game","score","league", "tournament","fifa","uefa","chiefs","mariners","lakers","patriots"},
    "Social Media & Communities": {"facebook","twitter","x","instagram","tiktok","reddit","discord","telegram","whatsapp","subreddit","forum","channel","group"},
    "Files & Media": {"pdf","doc","docx","xls","xlsx","ppt","pptx","zip","rar","attachment","image","photo","jpg","jpeg","png","gif","video","audio","mp3","mp4"},
    "Recruiting & Jobs": {"job","jobs","vacancy","opening","position","role","recruiter","hiring","resume","cv","apply","application","interview","salary","offer"},
    "News & Politics": {"news","headline","press","policy","politics","election","vote","minister","president","parliament","senate","congress"},
    "General Chatter": {"hello","hi","thanks","regards","please","contact","reply","forward","dear","mr","mrs","sir","madam"},
    "Tech Support": {"error","issue","problem","bug","fix","install","update","patch","troubleshoot","reset","support","ticket"},
    "Culture & Entertainment": {"movie","film","music","song","concert","festival","tv","series","show","game","gaming","xbox","playstation","nintendo","anime","comic"},
    "Science & Research": {"research","study","experiment","data","analysis","theory","journal","paper","review","publication","science","biology","physics","chemistry"},
    "Shopping & Retail": {"buy","purchase","order","shop","store","brand","retail","fashion","clothes","apparel","electronics","grocery"},
    "Education & Training": {"school","college","university","student","teacher","exam","class","grade","assignment","homework","training","course","certificate","diploma"},
    "Events & Conferences": {"conference","meeting","seminar","workshop","webinar","agenda","schedule","talk","presentation","expo","summit"},
    "Religion & Spirituality": {"church","mosque","temple","bible","quran","prayer","god","faith","spiritual","religion","belief"},
    "Geography & Places": {"northern","southern","eastern","western","city","town","village","capital","region","province","territory","new","old","central", "north", "south", "east", "west", "city","country","state","region","province","capital","usa","europe","asia","africa","middleeast","qatar","doha","jordan","amman"},
    "Programming Languages": {"python","java","c","c++","c#","javascript","typescript","php","ruby","go","rust","swift","kotlin","matlab","r","perl","fortran","haskell"},
    "AI Ethics & Safety": {"ethics","bias","fairness","responsibility","accountability","safety","alignment","explainability","trust","responsible","ai","governance"},
    "Gaming & Esports": {"game","gaming","xbox","playstation","nintendo","steam","tournament","league","esports","gamer","fortnite","minecraft","valorant","dota","lol"},
    "Space & Astronomy": {"nasa","spacex","rocket","launch","mars","moon","satellite","orbit","astronomy","planet","galaxy","star","universe","telescope","hubble"},
    "Human Capital & Workplace": {"employee","employer","salary","benefits","workplace","office","remote","hybrid","team","manager","leader","promotion","fired","hiring"},
    "Banking & Investment": {"bank","credit","debit","loan","mortgage","equity","stock","bond","market","fund","hedge","invest","portfolio","ipo","dividend"},
    "Startups & Entrepreneurship": {"startup","founder","pitch","seed","venture","capital","incubator","accelerator","angel","funding","valuation","scale","exit","unicorn"},
    "Economics": {"economy","inflation","gdp","recession","growth","unemployment","monetary","fiscal","policy","central","bank","currency","trade","tariff"},
    "Food & Cooking": {"food","meal","cook","kitchen","recipe","restaurant","dinner","lunch","breakfast","snack","drink","coffee","tea","beer","wine","bar","menu"},
    "Health & Fitness": {"gym","workout","exercise","training","fitness","run","yoga","diet","nutrition","protein","calories","weight","cardio","muscle","health"},
    "Fashion & Lifestyle": {"clothes","fashion","style","design","brand","shoes","dress","tshirt","jeans","suit","bag","perfume","watch","accessory","luxury"},
    "Movies & TV": {"movie","film","cinema","tv","series","episode","actor","actress","director","oscar","hollywood","bollywood","netflix","disney","hbo"},
    "Music & Audio": {"music","song","album","artist","band","concert","festival","radio","spotify","itunes","sound","guitar","piano","drums","dj","rap","pop","rock"},
    "Crime & Law": {"crime","criminal","murder","robbery","theft","fraud","arrest","court","judge","trial","jury","lawyer","attorney","justice","police"},
    "Military & Defense": {"army","navy","airforce","defense","weapon","gun","missile","tank","war","battle","soldier","military","strategy","nato"},
    "Disasters & Emergencies": {"earthquake","flood","hurricane","storm","tsunami","fire","wildfire","pandemic","epidemic","outbreak","crisis","rescue","emergency","relief"},
    "Climate & Environment": {"climate","globalwarming","warming","co2","carbon","emissions","greenhouse","pollution","renewable","sustainable","biodiversity","wildlife","forest"},
    "Travel & Tourism": {"trip","travel","tourism","vacation","holiday","flight","airport","visa","passport","hotel","hostel","tour","cruise","car","train","bus","ticket"},
    "Household & Family": {"family","home","house","apartment","parent","mother","father","brother","sister","child","kids","baby","marriage","wedding","husband","wife"},
    "Pets & Animals": {"pet","dog","cat","fish","bird","hamster","puppy","kitten","animal","wildlife","zoo","veterinarian","vet"},
    "Shopping & Consumer": {"shop","shopping","buy","sell","store","mall","market","retail","brand","amazon","ebay","walmart","aliexpress","item","product","order","delivery"},
    "Hobbies & Leisure": {"book","read","reading","library","hobby","craft","art","painting","drawing","photo","photography","camera","garden","gardening","outdoor"},
    "Sports & Olympics": {"sport","sports","game","games","tournament","league","match","team","player","score","goal","medal","gold","silver","bronze","athlete","olympic","olympics","worldcup","fifa","uefa","athens","rio","tokyo"},
    "Awards & Competitions": {"award","awards","prize","medal","trophy","contest","competition","open","championship","cup","title","winner","nominee","nomination","festival"},
        "Quantum Computing": {"quantum","qubit","entanglement","superposition","qiskit","quantization","decoherence","quantumcomputer","quantumcircuit"},
    "Augmented & Virtual Reality": {"ar","vr","augmented","virtual","metaverse","headset","oculus","hololens","immersive","simulation"},
    "3D Printing & Manufacturing": {"3dprinting","additivemanufacturing","printer","filament","resin","prototype","cad","stl","modeling"},
    "Smart Cities": {"smartcity","urban","traffic","infrastructure","mobility","sustainability","transport","governance","sensor"},
    "Telecommunications": {"5g","4g","lte","network","carrier","spectrum","tower","antenna","fiber","telecom","broadband"},
    "Human-Computer Interaction": {"interface","interaction","usability","ux","ui","design","accessibility","hci","prototype","wireframe"},
    "Cyber Threat Intelligence": {"threat","mitre","attackmatrix","malware","forensics","cyberattack","threatintel","ransomware","exploit","vulnerability"},
    "Generative AI": {"genai","llm","chatgpt","gpt","diffusion","texttoimage","textgeneration","prompt","stable","midjourney"},
    "SaaS & B2B Platforms": {"saas","b2b","subscription","enterprise","crm","erp","customer","platform","service","dashboard"},
    "Quantum Cryptography": {"quantumkey","qkd","quantumcryptography","entanglement","securecommunication"},
    "Healthcare AI": {"diagnosis","medicalimage","radiology","mlhealth","predictivediagnosis","ehr","patientdata"},
    "Biotechnology": {"genome","crispr","biotech","geneediting","protein","enzyme","cellculture","rna","dna"},
    "Renewable Energy": {"solar","wind","hydro","geothermal","renewable","cleanenergy","sustainability","greenpower"},
    "Smart Home": {"smarthome","iot","alexa","googlehome","automation","lighting","thermostat","device","assistant"},
    "Aerospace & Aviation": {"aircraft","aviation","flight","drone","uav","aerospace","airline","airport","boeing","airbus"},
    "Space Exploration": {"mars","nasa","rocket","mission","launch","satellite","spacecraft","orbital","asteroid"},
    "Transportation & Mobility": {"electricvehicle","autonomouscar","ev","charging","mobility","transportation","ride","fleet"},
    "Digital Twins": {"digitaltwin","simulation","virtualmodel","predictivemaintenance","systemmodeling"},
    "Supply Chain Analytics": {"logistics","warehouse","inventory","demandforecasting","procurement","distribution"},
    "Ethics & Governance": {"ethics","accountability","transparency","regulation","law","policy","bias","responsibility"},
    "Agricultural Technology": {"agritech","precisionfarming","drone","sensor","cropmonitoring","soil","yield"},
    "Medical Imaging": {"radiology","ctscan","mri","xray","ultrasound","imageanalysis","segmentation"},
    "Smart Wearables": {"wearable","smartwatch","fitbit","tracker","sensor","biometric","heartrate","fitnessband"},
    "Climate Tech": {"carboncapture","renewable","greenenergy","climatetech","emissionreduction","sustainability"},
    "Robotic Process Automation": {"rpa","automation","workflow","bot","taskautomation","process","uipath","blueprism"},
    "Defense & Aerospace": {"military","missile","radar","airforce","defense","weapon","drone","satellite","reconnaissance"},
    "Food Technology": {"foodtech","agriculture","nutrition","labgrown","protein","plantbased","sustainability"},
    "Mental Health": {"therapy","psychology","counseling","depression","anxiety","mindfulness","stress","wellbeing"},
    "Public Health": {"vaccine","epidemic","pandemic","disease","healthpolicy","infection","prevention"},
    "Disaster Management": {"crisis","disaster","rescue","emergencyresponse","flood","earthquake","fire"},
    "Sociology & Behavior": {"social","behavior","community","culture","ethnography","society","psychology"},
    "Econometrics": {"regression","modeling","econometrics","forecasting","macro","micro","economy"},
    "Philosophy & Ethics": {"philosophy","morality","ethics","logic","epistemology","reason","metaphysics"},
    "Transportation Systems": {"bus","metro","railway","transit","traffic","route","ticket","station"},
    "Finance Analytics": {"portfolio","trading","investment","risk","forecast","market","return","valuation"},
    "Blockchain Applications": {"token","crypto","wallet","smartcontract","blockchain","nft","defi","dapp"},
    "Data Privacy": {"gdpr","dataprivacy","encryption","consent","userdata","compliance","policy"},
    "Creative Design": {"graphicdesign","illustration","figma","adobe","photoshop","creativity","poster","branding"},
    "Photography & Videography": {"camera","dslr","lens","photography","cinematography","editing","video"},
    "Renewable Infrastructure": {"solarplant","windfarm","battery","grid","energytransition","renewables"},
    "Insurance Tech": {"insurtech","policy","claim","riskmodeling","underwriting","premium"},
    "Legal Tech": {"lawtech","contract","compliance","case","litigation","documentreview"},
    "AI in Education": {"edtech","learningplatform","personalizedlearning","student","teacher","curriculum"},
    "AI in Finance": {"fintech","frauddetection","credit","riskmodel","loan","investment","forecasting"},
    "Cognitive Science": {"neuroscience","perception","memory","learning","decisionmaking","mind"},
    "Knowledge Graphs": {"ontology","graphdb","semantic","triples","linkeddata","rdf","sparql"},
    "Data Visualization": {"dashboard","chart","plot","visualization","analytics","datastory","insight"},
    "Text Mining": {"nlp","sentiment","entityrecognition","topicmodeling","tokenization","textclassification"},
    "Infection Control Facilities": {"Isolation","suite","room","containment","controlled-area","isolation-unit","airlock","clinical-room","restricted-space"},
    "Accessible Movement Areas": {"Ambulant","space","users","mobility","circulation","accessible-route","movement-path","walkway","supports-mobility"},
    "Accessible Sanitary Facilities": {"Used","may","toilet","accessible-toilet","restroom","washroom","WC","hygiene-space","sanitary-cubicle"},
    "Handwashing Fixtures": {"Tap","lever","used","faucet","handle","water-control","sink","basin-fixture","activation-mechanism"},
    "Standing Work Zones": {"Staff","seats","without","standing-area","workstation","non-seated-zone","staff-point","observation-area","duty-station"},
    "External Ventilation Systems": {"Building","outside","fan","exhaust","HVAC","airflow","ventilation-unit","outdoor-equipment","air-extractor"},
    "Air-Pressure Transition Zones": {"Lobby","adjacent","pressure","anteroom","buffer-space","pressure-controlled-area","transition-room","regulated-air","sealed-entry"},
    "Touchdown Workpoints": {"Base","touchdown","standing","quick-stop-area","standing-point","short-stay-zone","counter","brief-workspace","leaning-space"},
    "Patient Interaction Areas": {"Bedside","communication","activity","patient-care","monitoring","clinical-interaction","dialogue","observation","care-activity"}
}



import math
from collections import defaultdict

def _normalize_category_map(cmap: dict) -> dict:
    """lower-case + set-ify all entries once."""
    norm = {}
    for label, words in (cmap or {}).items():
        if not words:
            continue
        norm[label] = set(w.strip().lower() for w in words if w and str(w).strip())
    return norm

_CATEGORY_MAP_NORM = _normalize_category_map(category_map)

def _auto_label_from_terms(top_terms, n=3):
    """
    Build a short readable label from the top terms, e.g. "Loan • bank • payment".
    Skips junky tokens (digits, very short, mostly non-alpha).
    """
    words = []
    for t in top_terms:
        w = t[0] if isinstance(t, (list, tuple)) else t
        w = str(w).strip().lower()
        if not w:
            continue
        if len(w) < 3:
            continue
        if re.search(r"\d", w):              # skip tokens with digits
            continue
        if not re.search(r"[a-z]", w):       # skip tokens without letters
            continue
        w = w.replace("_", " ")[:20]
        words.append(w)
        if len(words) >= n:
            break

    if not words:
        return "Topic"
    words[0] = words[0].capitalize()
    return " • ".join(words)



def _best_label_for_terms(top_terms, default_label=None, min_hits=2, min_score=0.0):
    """
    Pick a label from category_map if there is sufficient overlap.
    - min_hits: require at least this many category words present in the topic
    - min_score: optional weight threshold (kept 0.0 by default)
    If nothing qualifies, return default_label (e.g., "Topic 3").
    """
    if not top_terms:
        return default_label or "Topic"

    # normalize {word: weight}
    weights = defaultdict(float)
    for t in top_terms:
        if isinstance(t, (list, tuple)) and len(t) >= 1:
            w = str(t[0]).lower()
            wt = float(t[1]) if len(t) >= 2 and isinstance(t[1], (int, float)) else 1.0
        else:
            w = str(t).lower()
            wt = 1.0
        weights[w] += wt

    best_label, best_score, best_hits = None, 0.0, 0
    for label, vocab in _CATEGORY_MAP_NORM.items():
        hits = 0
        score = 0.0
        for w in vocab:
            if w in weights:
                hits += 1
                score += weights[w]
        if score > best_score:
            best_label, best_score, best_hits = label, score, hits

    if best_label and best_hits >= min_hits and best_score > min_score:
        return best_label

    return default_label or "Topic"

from sklearn.feature_extraction.text import CountVectorizer
from sklearn.decomposition import LatentDirichletAllocation

# ---- topic modeling configuration ----
TOPIC_MAX_CHARS_PER_DOC = int(os.getenv("TOPIC_MAX_CHARS_PER_DOC", 10000))  # allow longer documents
TOPIC_MAX_FEATURES      = int(os.getenv("TOPIC_MAX_FEATURES", 10000))       # more vocabulary variety
TOPIC_MIN_TOPICS        = int(os.getenv("TOPIC_MIN_TOPICS", 5))             # at least 5 topics
TOPIC_MAX_TOPICS        = int(os.getenv("TOPIC_MAX_TOPICS", 20))            # up to 20 topics
TOPIC_MAX_DOCS          = int(os.getenv("TOPIC_MAX_DOCS", 5000))            # handle large labeled datasets


@app.post("/api/topic_modeling")
def api_topic_modeling():
    try:
        data = request.get_json(force=True) or {}
        rows = data.get("rows")
        if rows is None:
            txt = data.get("text") or ""
            rows = [txt] if isinstance(txt, str) else []

        include_stop = bool(data.get("includeStopwords", False))

        # ---- normalize to list[str] and clamp per-doc size
        docs = []
        for r in rows:
            s = r if isinstance(r, str) else str(r or "")
            s = s.strip()
            if not s:
                continue
            if TOPIC_MAX_CHARS_PER_DOC and len(s) > TOPIC_MAX_CHARS_PER_DOC:
                s = s[:TOPIC_MAX_CHARS_PER_DOC]
            docs.append(s)
        # keep things light on Render
        docs = docs[:TOPIC_MAX_DOCS]
        is_labeled = bool(data.get("isLabeled", False))
        # If it's an unlabeled single long document, split it into chunks
        if not is_labeled and len(docs) == 1:
            text = docs[0]
            # Split into roughly 500-word chunks so LDA has multiple documents
            parts = [text[i:i+3000] for i in range(0, len(text), 3000)]
            docs = [p.strip() for p in parts if len(p.strip()) > 100]
        if len(docs) == 0:
            return jsonify({"topics": [], "mapping": [], "warning": "no non-empty documents"}), 200

        # ---- Vectorize. token_pattern avoids 1-char tokens; max_df trims very common words.
        n_docs = len(docs)

        # Adjust min_df & max_df depending on number of docs
        if n_docs == 1:
            min_df = 1
            max_df = 1.0
        elif n_docs < 5:
            min_df = 1
            max_df = 0.95
        else:
            min_df = 2
            max_df = 0.9

        def get_english_stopwords():
            """Extended stopwords list including common function words"""
            base_stopwords = [
                'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and',
                'any', 'are', 'as', 'at', 'be', 'because', 'been', 'before', 'being', 'below',
                'between', 'both', 'but', 'by', 'can', 'cannot', 'could', 'did', 'do', 'does',
                'doing', 'down', 'during', 'each', 'few', 'for', 'from', 'further', 'had', 'has',
                'have', 'having', 'he', 'her', 'here', 'hers', 'herself', 'him', 'himself', 'his',
                'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'itself', 'just', 'me', 'might',
                'more', 'most', 'must', 'my', 'myself', 'no', 'nor', 'not', 'now', 'of', 'off', 'on',
                'once', 'only', 'or', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
                'same', 'she', 'should', 'so', 'some', 'such', 'than', 'that', 'the', 'their',
                'theirs', 'them', 'themselves', 'then', 'there', 'these', 'they', 'this', 'those',
                'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was', 'we', 'were', 'what',
                'when', 'where', 'which', 'while', 'who', 'whom', 'why', 'will', 'with', 'would',
                'you', 'your', 'yours', 'yourself', 'yourselves'
            ]
            return base_stopwords

        # Then update your vectorizer in api_topic_modeling:
        vec = CountVectorizer(
            stop_words=get_english_stopwords(),  # ✅ Use proper stopwords
            token_pattern=r"(?u)\b[a-zA-Z]{3,}\b",  # ✅ Require at least 3 letters
            min_df=min_df,
            max_df=max_df,
            max_features=TOPIC_MAX_FEATURES
        )

        try:
            X = vec.fit_transform(docs)
        except ValueError as e:
            # e.g., "empty vocabulary; perhaps the documents only contain stop words"
            return jsonify({"topics": [], "mapping": [], "error": "empty-vocabulary", "detail": str(e)}), 400

        if X.shape[1] == 0:
            return jsonify({"topics": [], "mapping": [], "error": "no-features", "detail": "vectorizer produced 0 features"}), 400
        print("Docs:", docs)
        print("Number of documents:", len(docs))
        print("Features extracted:", vec.get_feature_names_out())
        print("Number of features:", len(vec.get_feature_names_out()))


        # ---- choose a safe number of topics
        n_docs = X.shape[0]

        # If there are few docs, still allow multiple topics
        if n_docs == 1:
            n_topics = min(TOPIC_MAX_TOPICS, 5)
        else:
            n_topics = max(TOPIC_MIN_TOPICS, min(TOPIC_MAX_TOPICS, n_docs))


        lda = LatentDirichletAllocation(
            n_components=n_topics,
            learning_method="online",
            random_state=0,
            max_iter=10
        )
        lda.fit(X)

        vocab = vec.get_feature_names_out()
        topic_word = lda.components_

        # ---- build topics (top 10 terms)
        topics = []
        for k in range(n_topics):
            comp = topic_word[k]
            top_idx = comp.argsort()[-10:][::-1]
            terms = [[str(vocab[i]), float(comp[i])] for i in top_idx]
            topics.append({
                "id": int(k + 1),
                "terms": terms,
                "weight": float(comp[top_idx].sum())
            })

        # ---- label each topic using the helpers you added (_best_label_for_terms)
        labels_only = []
        for k in range(n_topics):
            terms = topics[k]["terms"]  # [ [word, weight], ... ]
        
            # fallback: short title from top words
            fallback = _auto_label_from_terms(terms, n=3)
        
            # prefer category_map title if *any* match exists
            label = _best_label_for_terms(
                terms,
                default_label=fallback,   # only if no category match
                min_hits=1,               # one matching token is enough
                min_score=0.0
            )
        
            topics[k]["label"] = label
            labels_only.append(label)



        # ---- doc→topic probabilities and normalized percents (sum ~ 100)
        doc_topic = lda.transform(X)                        # shape: [n_docs, n_topics]

        # You can keep your rounding logic, or reuse helper _topic_share_from_theta
        topic_counts = doc_topic.sum(axis=0)
        den = float(topic_counts.sum() or 1.0)
        raw_pcts = (topic_counts / den) * 100.0
        rounded = [round(float(p), 2) for p in raw_pcts]
        drift = round(100.0 - sum(rounded), 2)
        if n_topics > 0:
            max_i = int(max(range(n_topics), key=lambda i: rounded[i]))
            rounded[max_i] = round(rounded[max_i] + drift, 2)
        for k in range(n_topics):
            topics[k]["percent"] = float(rounded[k])

        # ---- doc→topic mapping (include label + confidence + a small snippet)
        mapping = []
        for i in range(n_docs):
            row = doc_topic[i]
            best_k = int(row.argmax())
            confidence = float(round(row[best_k] * 100.0, 2))
            snippet = (docs[i][:160] + "…") if len(docs[i]) > 180 else docs[i]
            mapping.append({
                "doc_id": int(i + 1),
                "topic": int(best_k + 1),
                "label": labels_only[best_k] if 0 <= best_k < len(labels_only) else f"Topic {best_k+1}",
                "confidence": confidence,
                "snippet": snippet
            })

        return jsonify({"topics": topics, "mapping": mapping})

    except Exception as e:
        # Log the exact failure to your server logs and return a JSON error
        print("ERROR /api/topic_modeling:", repr(e))
        return jsonify({"error": "topic-modeling-failed", "detail": str(e)}), 500


def apply_preprocessing(texts, labels, settings, vectorizer=None, scaler=None, word2vec_model=None):
    """
    Apply preprocessing based on the provided settings
    
    Args:
        texts: List of text documents
        labels: List of labels
        settings: Preprocessing settings dict
        vectorizer: Pre-trained vectorizer (for TF/TF-IDF)
        scaler: Pre-trained scaler (for Word2Vec)
        word2vec_model: Pre-trained Word2Vec model
    
    Returns:
        Dict with processed_texts, vectors, labels, vocab_size, n_samples, vectorizer, scaler
    """
    import re
    from nltk.stem import PorterStemmer
    from nltk.stem import WordNetLemmatizer
    from sklearn.feature_extraction.text import TfidfVectorizer, CountVectorizer
    from sklearn.preprocessing import StandardScaler, MinMaxScaler
    from imblearn.over_sampling import SMOTE, RandomOverSampler
    from imblearn.under_sampling import RandomUnderSampler
    from gensim.models import Word2Vec
    import nltk
    import numpy as np
    
    
    
    
    # VALIDATE: Only one class imbalance method
    imbalance_methods = [
        settings.get('useSMOTE'),
        settings.get('useOversampling'),
        settings.get('useUndersampling')
    ]
    if sum(bool(x) for x in imbalance_methods) > 1:
        raise ValueError("Only one class imbalance method can be applied at a time")
    
    # Download required NLTK data if not already present
    try:
        nltk.data.find('tokenizers/punkt')
    except LookupError:
        nltk.download('punkt')
    
    try:
        nltk.data.find('corpora/wordnet')
    except LookupError:
        nltk.download('wordnet')
    
    stemmer = PorterStemmer()
    lemmatizer = WordNetLemmatizer()
    
    processed_texts = []
    tokenized_texts = []  # For Word2Vec
    
    # Text processing
    for text in texts:
        processed = text.lower()
        processed = re.sub(r'[^\w\s]', '', processed)
        tokens = processed.split()
        
        if settings.get('useStemming'):
            tokens = [stemmer.stem(token) for token in tokens]
        elif settings.get('useLemmatization'):
            tokens = [lemmatizer.lemmatize(token) for token in tokens]
        
        tokenized_texts.append(tokens)
        processed_texts.append(' '.join(tokens))
    
    # Vectorization
    vector_size_percent = settings.get('vectorSize', 100) / 100.0
    use_word2vec = settings.get('useWord2Vec', False)
    
    # FIXED: Determine if we're training based on ALL provided models
    is_training = vectorizer is None and scaler is None and word2vec_model is None
    
    logging.info(f"Preprocessing mode: {'TRAINING' if is_training else 'INFERENCE'}")
    
    if use_word2vec:
        # Word2Vec vectorization
        logging.info(f"Using Word2Vec for feature extraction (Training: {is_training})")
        
        if is_training:
            # TRAINING: Train Word2Vec model
            w2v_size = int(200 * vector_size_percent)
            w2v_size = max(50, min(300, w2v_size))  # Reasonable range
            
            logging.info(f"Training Word2Vec with {w2v_size} dimensions")
            
            w2v_model = Word2Vec(
                sentences=tokenized_texts,
                vector_size=w2v_size,
                window=5,
                min_count=2,  # FIXED: Increased from 1 to filter rare words
                workers=4,
                sg=0,
                epochs=10  # FIXED: Added epochs for better training
            )
            # FIXED: Use consistent variable name
            word2vec_model = w2v_model  # Store for test data
        else:
            # TEST: Use existing Word2Vec model
            w2v_model = word2vec_model
            if w2v_model is None:
                raise ValueError("Word2Vec model required for inference but not provided")
            w2v_size = w2v_model.wv.vector_size
            logging.info(f"Using pre-trained Word2Vec with {w2v_size} dimensions")
        
        # FIXED: Convert texts to vectors with better handling of OOV words
        X_dense = []
        for tokens in tokenized_texts:
            word_vectors = []
            for token in tokens:
                if token in w2v_model.wv:
                    word_vectors.append(w2v_model.wv[token])
            
            if word_vectors:
                # FIXED: Use multiple aggregation methods for better representation
                doc_vector = np.mean(word_vectors, axis=0)
                # Alternative: doc_vector = np.max(word_vectors, axis=0)  # Max pooling
            else:
                # FIXED: Better handling for empty documents
                doc_vector = np.random.normal(0, 0.1, w2v_size)  # Small random vector
            
            # FIXED: CRITICAL - Actually append the document vector to X_dense
            X_dense.append(doc_vector)
        
        X = np.array(X_dense)
        
        # FIXED: Better scaling strategy for Word2Vec
        if is_training:
            # Use StandardScaler for Word2Vec (better than MinMax for neural features)
            scaler = StandardScaler()
            X = scaler.fit_transform(X)
        else:
            if scaler is None:
                raise ValueError("Scaler required for Word2Vec inference but not provided")
            X = scaler.transform(X)
        
        logging.info(f"Word2Vec shape: {X.shape}, range: [{X.min():.3f}, {X.max():.3f}]")
        
    else:
        # TF-IDF or TF vectorization (sparse)
        if is_training:
            # TRAINING: Create and fit vectorizer
            max_features = int(5000 * vector_size_percent)
            
            if settings.get('useTFIDF'):
                vectorizer = TfidfVectorizer(
                    max_features=max_features,
                    min_df=2,  # FIXED: Filter rare terms
                    max_df=0.8,  # FIXED: Filter too common terms
                    stop_words='english'
                )
            elif settings.get('useTF'):
                vectorizer = CountVectorizer(
                    max_features=max_features,
                    min_df=2,
                    max_df=0.8,
                    stop_words='english'
                )
            else:
                vectorizer = CountVectorizer(
                    max_features=max_features,
                    min_df=1,
                    stop_words='english'
                )
            
            X = vectorizer.fit_transform(processed_texts)
            logging.info(f"Fitted vectorizer with {len(vectorizer.get_feature_names_out())} features")
        else:
            # TEST: Use existing vectorizer
            if vectorizer is None:
                raise ValueError("Vectorizer required for inference but not provided")
            X = vectorizer.transform(processed_texts)
        
        # FIXED: Convert to dense array for consistency with Word2Vec
        # This ensures all models get the same data format
        if hasattr(X, 'toarray'):
            X = X.toarray()
        
        logging.info(f"Vectorization shape: {X.shape}")
    
    # Convert labels to numpy array
    labels_array = np.array(labels)
    
    # FIXED: Class imbalance handling (ONLY for training data)
    final_texts = processed_texts
    final_labels = labels_array
    
    if is_training and len(np.unique(labels_array)) > 1:  # Only if we have multiple classes
        if settings.get('useSMOTE'):
            try:
                # FIXED: SMOTE requires specific conditions
                if X.shape[0] >= 6 and len(np.unique(labels_array)) >= 2:
                    smote = SMOTE(random_state=42, k_neighbors=min(5, X.shape[0]-1))
                    X_resampled, labels_resampled = smote.fit_resample(X, labels_array)
                    
                    # FIXED: Handle text replication for SMOTE
                    if X_resampled.shape[0] > X.shape[0]:
                        # For synthetic samples, we can't replicate texts, so use placeholders
                        additional_samples = X_resampled.shape[0] - X.shape[0]
                        final_texts = processed_texts + [f"synthetic_sample_{i}" for i in range(additional_samples)]
                    else:
                        final_texts = processed_texts
                    
                    X = X_resampled
                    final_labels = labels_resampled
                    logging.info(f"Applied SMOTE: {X.shape[0]} samples")
                else:
                    logging.warning("SMOTE skipped: insufficient samples or classes")
            except ValueError as e:
                logging.warning(f"SMOTE failed: {e}. Skipping class balancing.")
                
        elif settings.get('useOversampling'):
            try:
                oversampler = RandomOverSampler(random_state=42)
                X_resampled, labels_resampled = oversampler.fit_resample(X, labels_array)
                
                # FIXED: Proper text replication for oversampling
                original_indices = list(range(len(processed_texts)))
                resampled_indices = oversampler.sample_indices_
                final_texts = [processed_texts[i] for i in resampled_indices]
                
                X = X_resampled
                final_labels = labels_resampled
                logging.info(f"Applied Oversampling: {X.shape[0]} samples")
            except Exception as e:
                logging.warning(f"Oversampling failed: {e}")
                
        elif settings.get('useUndersampling'):
            try:
                undersampler = RandomUnderSampler(random_state=42)
                X_resampled, labels_resampled = undersampler.fit_resample(X, labels_array)
                
                # FIXED: Get the selected indices for text filtering
                selected_indices = undersampler.sample_indices_
                final_texts = [processed_texts[i] for i in selected_indices]
                
                X = X_resampled
                final_labels = labels_resampled
                logging.info(f"Applied Undersampling: {X.shape[0]} samples")
            except Exception as e:
                logging.warning(f"Undersampling failed: {e}")
    
    logging.info(f"Preprocessing complete: X.shape={X.shape}, labels.shape={final_labels.shape}, texts.length={len(final_texts)}")
    if hasattr(X, 'min'):
        logging.info(f"Feature range: min={X.min():.3f}, max={X.max():.3f}, mean={X.mean():.3f}")
    
    # FIXED: Return all necessary components for consistent inference
    return {
        'processed_texts': final_texts,
        'vectors': X,
        'labels': final_labels,
        'vocab_size': X.shape[1],
        'n_samples': X.shape[0],
        'vectorizer': vectorizer,  # For TF/TF-IDF
        'scaler': scaler,  # For Word2Vec
        'word2vec_model': word2vec_model  # For Word2Vec - FIXED: now properly defined
    }


@app.route('/api/preprocess_preview', methods=['POST'])
def preprocess_preview():
    """Preview preprocessing results including class distribution after balancing"""
    try:
        data = request.get_json(force=True) or {}
        settings = data.get('settings', {})
        rows = data.get('rows', [])
        text_col = data.get('textCol', 'text')
        
        if not rows:
            return jsonify({'error': 'No data available for preprocessing'}), 400
        
        # Extract texts and labels from rows
        texts = []
        labels = []
        for row in rows:
            text = row.get(text_col, row.get('text', row.get('email', '')))
            if text:
                texts.append(str(text))
                labels.append(row.get('label', 'Unlabeled'))
        
        if not texts:
            return jsonify({'error': 'No text data found'}), 400
        
        # Count original distribution
        from collections import Counter
        original_distribution = Counter(labels)
        
        # Apply preprocessing to get balanced distribution
        results = apply_preprocessing(texts, labels, settings)
        
        # Count processed distribution
        processed_distribution = Counter(results['labels'].tolist())
        
        # Return results for display
        return jsonify({
            'success': True,
            'original_sample': texts[0][:300] if texts else '',
            'processed_sample': results['processed_texts'][0][:300] if results['processed_texts'] else '',
            'vocab_size': results['vocab_size'],
            'n_samples': results['n_samples'],
            'vector_dimensions': results['vocab_size'],
            'original_class_distribution': dict(original_distribution),
            'processed_class_distribution': dict(processed_distribution)
        })
        
    except Exception as e:
        logging.exception("Preprocessing preview failed")
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'Preprocessing preview failed', 'detail': str(e)}), 500
    
    
@app.route('/api/preprocess', methods=['POST'])
def preprocess():
    """Apply text preprocessing pipeline"""
    try:
        data = request.get_json(force=True) or {}
        settings = data.get('settings', {})
        rows = data.get('rows', [])
        text_col = data.get('textCol', 'text')
        
        if not rows:
            return jsonify({'error': 'No data available for preprocessing'}), 400
        
        # Extract texts and labels from rows
        texts = []
        labels = []
        for row in rows:
            text = row.get(text_col, row.get('text', row.get('email', '')))
            if text:
                texts.append(str(text))
                labels.append(row.get('label', 'Unlabeled'))
        
        if not texts:
            return jsonify({'error': 'No text data found'}), 400
        
        # Apply preprocessing
        results = apply_preprocessing(texts, labels, settings)
        
        # Return results for display
        return jsonify({
            'success': True,
            'original_sample': texts[0][:300] if texts else '',
            'processed_sample': results['processed_texts'][0][:300] if results['processed_texts'] else '',
            'vocab_size': results['vocab_size'],
            'n_samples': results['n_samples'],
            'vector_dimensions': results['vocab_size'],
            'original_class_distribution': dict(Counter(labels)),
            'new_class_distribution': dict(Counter(results['labels'])) if results['labels'] is not None else {}
        })
        
    except Exception as e:
        logging.exception("Preprocessing failed")
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'Preprocessing failed', 'detail': str(e)}), 500
    
@app.route("/api/predict", methods=["POST"])
def api_predict():
    import numpy as np
    from sklearn.feature_extraction.text import TfidfVectorizer, CountVectorizer
    from sklearn.model_selection import train_test_split
    from sklearn.naive_bayes import MultinomialNB
    from sklearn.discriminant_analysis import LinearDiscriminantAnalysis, QuadraticDiscriminantAnalysis
    from sklearn.linear_model import LogisticRegression
    from sklearn.neighbors import KNeighborsClassifier
    from sklearn.svm import SVC
    from sklearn.metrics import (
        accuracy_score, precision_score, recall_score, f1_score,
        classification_report
    )
    from collections import Counter
    from sklearn.preprocessing import StandardScaler
    
    data = request.get_json(force=True)
    rows = data.get("rows", [])
    model_type = data.get("model", "nb")
    test_size = max(0.05, min(0.9, float(data.get("testSize", 0.3))))
    random_state = int(data.get("randomState", 42))
    use_preprocessed = bool(data.get("usePreprocessed", False))
    preprocessing_settings = data.get("preprocessingSettings", {})
    
    # Check if Word2Vec is being used
    use_word2vec = preprocessing_settings.get('useWord2Vec', False)
    
    # ENHANCED DEBUGGING: Log what we received
    logging.info(f"=== PREDICTION REQUEST ===")
    logging.info(f"Model: {model_type}, Test size: {test_size}, Random state: {random_state}")
    logging.info(f"Use preprocessed: {use_preprocessed}")
    logging.info(f"Use Word2Vec: {use_word2vec}")
    logging.info(f"Preprocessing settings: {preprocessing_settings}")
    logging.info(f"Number of rows: {len(rows)}")
    
    if not rows:
        return jsonify({"error": "No data received"}), 400
    
    # Extract texts and labels
    texts = []
    labels = []
    for r in rows:
        text = r.get("text", r.get("email", ""))
        label = r.get("label")
        if text and label is not None:
            texts.append(str(text))
            labels.append(label)
    
    if not texts or not labels:
        return jsonify({"error": "Missing text or label fields"}), 400
    
    if len(set(labels)) < 2:
        return jsonify({"error": "At least two classes are required."}), 400
    
    # Count original class distribution
    original_distribution = Counter(labels)
    logging.info(f"Original class distribution: {dict(original_distribution)}")
    
    # Store original counts for reporting
    original_sample_count = len(texts)
    
    try:
        # FIXED: Split the data BEFORE any preprocessing to avoid data leakage
        logging.info("SPLITTING DATA BEFORE PREPROCESSING...")
        
        # Split the raw data first
        texts_train, texts_test, y_train, y_test = train_test_split(
            texts, labels, test_size=test_size, random_state=random_state, stratify=labels
        )
        
        logging.info(f"Initial split - Train: {len(texts_train)}, Test: {len(texts_test)}")
        logging.info(f"Train distribution: {Counter(y_train)}, Test distribution: {Counter(y_test)}")
        
        # Apply preprocessing if settings are provided
        if use_preprocessed and preprocessing_settings:
            try:
                logging.info("APPLYING PREPROCESSING TO TRAINING DATA...")
                # Apply preprocessing to training data
                train_result = apply_preprocessing(texts_train, y_train, preprocessing_settings)
                X_train = train_result['vectors']
                y_train = np.array(train_result['labels'])
                texts_train = train_result['processed_texts']
                
                # Get the trained preprocessing objects
                trained_vectorizer = train_result.get('vectorizer')
                trained_scaler = train_result.get('scaler')
                test_result = apply_preprocessing(
                    texts_test, 
                    y_test, 
                    preprocessing_settings,
                    vectorizer=train_result.get('vectorizer'),
                    scaler=train_result.get('scaler'),
                    word2vec_model=train_result.get('word2vec_model')
                )
                X_test = test_result['vectors']
                # Don't update y_test - no balancing on test data
                texts_test = test_result['processed_texts']
                
                logging.info(f"After preprocessing - Train: {X_train.shape}, Test: {X_test.shape}")
                
                # FIXED: Ensure consistent scaling for Word2Vec features
                if use_word2vec:
                    logging.info("Applying consistent scaling for Word2Vec features...")
                    # Re-scale both train and test with the same scaler
                    if trained_scaler is not None:
                        X_train = trained_scaler.transform(X_train)
                        X_test = trained_scaler.transform(X_test)
                    
                    logging.info(f"Word2Vec - Train range: [{X_train.min():.3f}, {X_train.max():.3f}]")
                    logging.info(f"Word2Vec - Test range: [{X_test.min():.3f}, {X_test.max():.3f}]")
                
            except Exception as e:
                logging.exception("Preprocessing failed in prediction")
                return jsonify({"error": f"Preprocessing failed: {str(e)}"}), 400
        else:
            # No preprocessing - create proper feature vectors
            logging.info("NO PREPROCESSING - Creating feature vectors...")
            vectorizer = CountVectorizer(lowercase=True, stop_words="english", max_features=5000)
            X_train = vectorizer.fit_transform(texts_train)
            X_test = vectorizer.transform(texts_test)
            logging.info(f"No preprocessing - Train: {X_train.shape}, Test: {X_test.shape}")
        
        # CRITICAL: Verify train/test separation and feature dimensions
        logging.info("=== DATA SPLIT VERIFICATION ===")
        logging.info(f"Train size: {X_train.shape[0]}, Test size: {X_test.shape[0]}")
        logging.info(f"Train features: {X_train.shape[1]}, Test features: {X_test.shape[1]}")
        logging.info(f"Train labels: {Counter(y_train)}")
        logging.info(f"Test labels: {Counter(y_test)}")
        
        # Verify feature dimensions match
        if X_train.shape[1] != X_test.shape[1]:
            logging.error(f"FEATURE DIMENSION MISMATCH: Train has {X_train.shape[1]} features, Test has {X_test.shape[1]} features")
            return jsonify({"error": f"Feature dimension mismatch: train={X_train.shape[1]}, test={X_test.shape[1]}"}), 400
        
        # Verify no data leakage
                # Verify no data leakage
        train_indices = set([hash(str(text)) for text in texts_train])
        test_indices = set([hash(str(text)) for text in texts_test])
        common = train_indices.intersection(test_indices)
        if common:
            logging.warning(f"DATA LEAKAGE DETECTED: {len(common)} common samples between train and test!")
            logging.warning("Proceeding with training despite data leakage - this may affect model performance")
        else:
            logging.info("✓ No data leakage detected")
            
        # FIXED: Enhanced model selection with better defaults
        if model_type == "nb" and not use_word2vec:
            model = MultinomialNB()
            name = "Naive Bayes"
            logging.info("Using Multinomial Naive Bayes")
        elif model_type == "gda" or (model_type == "nb" and use_word2vec):
            # FIXED: Better GDA configuration for Word2Vec
            if X_train.shape[0] < X_train.shape[1] or len(np.unique(y_train)) > 10:
                model = LinearDiscriminantAnalysis(solver='svd', shrinkage=None)
                name = "Linear Discriminant Analysis"
                logging.info("Using Linear Discriminant Analysis (LDA) for high-dimensional data")
            else:
                # Add regularization to QDA
                model = QuadraticDiscriminantAnalysis(reg_param=0.5)  # Regularization
                name = "Quadratic Discriminant Analysis"
                logging.info("Using Quadratic Discriminant Analysis (QDA) with regularization")
        elif model_type == "lr":
            model = LogisticRegression(max_iter=1000, solver="lbfgs", random_state=random_state, C=1.0)
            name = "Logistic Regression"
            logging.info("Using Logistic Regression")
        elif model_type == "knn":
            n_neighbors = min(5, max(1, X_train.shape[0]//10))
            model = KNeighborsClassifier(n_neighbors=n_neighbors)
            name = "K-Nearest Neighbors"
            logging.info(f"Using KNN with {n_neighbors} neighbors")
        elif model_type == "svm":
            model = SVC(kernel='linear', probability=True, random_state=random_state, C=1.0)
            name = "Support Vector Machine"
            logging.info("Using Linear SVM")
        else:
            return jsonify({"error": f"Unsupported model: {model_type}"}), 400
        
        # Convert sparse to dense if needed for certain models
        if model_type in ["gda"] or (model_type == "nb" and use_word2vec):
            if hasattr(X_train, 'toarray'):
                X_train = X_train.toarray()
                X_test = X_test.toarray()
            logging.info(f"Converted to dense arrays: {X_train.shape}")
        
        # FIXED: Data validation before training
        logging.info("=== DATA VALIDATION ===")
        logging.info(f"X_train shape: {X_train.shape}")
        logging.info(f"X_train stats - Min: {X_train.min():.3f}, Max: {X_train.max():.3f}, Mean: {X_train.mean():.3f}")
        logging.info(f"Unique labels in training: {len(np.unique(y_train))}")
        
        # Check for constant features that might cause issues
        if hasattr(X_train, 'std'):
            feature_std = X_train.std(axis=0)
            constant_features = np.sum(feature_std == 0)
            if constant_features > 0:
                logging.warning(f"Found {constant_features} constant features - this may cause model issues")
        
        # ENHANCED: Model training with validation
        logging.info("=== MODEL TRAINING ===")
        model.fit(X_train, y_train)
        logging.info("✓ Model training completed")
        
        # FIXED: Enhanced prediction and validation
        y_pred = model.predict(X_test)
        
        logging.info("=== PREDICTION RESULTS ===")
        logging.info(f"y_test samples: {y_test[:10]}")
        logging.info(f"y_pred samples: {y_pred[:10]}")
        
        # Calculate metrics
        accuracy = round(float(accuracy_score(y_test, y_pred)), 4)
        precision_weighted = round(float(precision_score(y_test, y_pred, average='weighted', zero_division=0)), 4)
        recall_weighted = round(float(recall_score(y_test, y_pred, average='weighted', zero_division=0)), 4)
        f1_weighted = round(float(f1_score(y_test, y_pred, average='weighted', zero_division=0)), 4)
        
        # Check if model is performing meaningfully
        majority_class = max(Counter(y_test).items(), key=lambda x: x[1])[0]
        majority_baseline = sum(1 for y in y_test if y == majority_class) / len(y_test)
        
        unique_predictions = set(y_pred)
        logging.info(f"Unique predictions: {unique_predictions}")
        logging.info(f"Majority class baseline: {majority_baseline:.4f}")
        
        # If model is only predicting one class, warn and provide debug info
        if len(unique_predictions) == 1:
            logging.warning("⚠️ Model is predicting only one class!")
            # Provide detailed debug info
            logging.info(f"Predicted class: {list(unique_predictions)[0]}")
            logging.info(f"Training data info - Samples: {X_train.shape[0]}, Features: {X_train.shape[1]}")
            logging.info(f"Training label distribution: {dict(Counter(y_train))}")
        
        # Rest of your existing result formatting code remains the same...
        report = classification_report(y_test, y_pred, zero_division=0)
        
        unique_labels = sorted(set(labels))
        misclassified = [txt[:100] for txt, yt, yp in zip(texts_test, y_test, y_pred) if yt != yp]
        
        # Build preprocessing info for display
        preprocessing_info = None
        if use_preprocessed and preprocessing_settings:
            methods = []
            if preprocessing_settings.get('useStemming'):
                methods.append('Stemming')
            if preprocessing_settings.get('useLemmatization'):
                methods.append('Lemmatization')
            if preprocessing_settings.get('useTF'):
                methods.append('TF')
            if preprocessing_settings.get('useTFIDF'):
                methods.append('TF-IDF')
            if preprocessing_settings.get('useWord2Vec'):
                methods.append('Word2Vec')
            if preprocessing_settings.get('useSMOTE'):
                methods.append('SMOTE')
            if preprocessing_settings.get('useOversampling'):
                methods.append('Random Oversampling')
            if preprocessing_settings.get('useUndersampling'):
                methods.append('Random Undersampling')
            
            preprocessing_info = {
                'applied': True,
                'methods': ', '.join(methods) if methods else 'None',
                'vectorSize': preprocessing_settings.get('vectorSize', 100),
                'samplesBefore': original_sample_count,
                'samplesAfter': X_train.shape[0] + X_test.shape[0],
                'originalDistribution': dict(original_distribution),
                'trainDistribution': dict(Counter(y_train)),
                'testDistribution': dict(Counter(y_test))
            }
        
        result = {
            "model": name,
            "metrics": {
                "accuracy": accuracy,
                "precision": precision_weighted,
                "recall": recall_weighted,  
                "f1": f1_weighted,
            },
            "classification_report": report,
            "labels": unique_labels,
            "y_true": y_test,
            "y_pred": y_pred.tolist(),
            "misclassified": misclassified,
            "preprocessing": preprocessing_info,
            "debug_info": {
                "train_size": X_train.shape[0],
                "test_size": X_test.shape[0],
                "feature_count": X_train.shape[1],
                "data_leakage_check": len(common) == 0,
                "train_label_distribution": dict(Counter(y_train)),
                "test_label_distribution": dict(Counter(y_test)),
                "majority_baseline": majority_baseline,
                "prediction_distribution": dict(Counter(y_pred)),
            }
        }
        
        logging.info("=== FINAL RESULT ===")
        logging.info(f"Model: {name}, Accuracy: {accuracy}")
        
        return jsonify(result)
    
    except Exception as e:
        logging.exception("Model training/prediction failed")
        return jsonify({"error": str(e)}), 500


def quick_cross_validation_check(X, y, model, model_name, n_splits=3):
    """Perform quick cross-validation to verify model performance"""
    from sklearn.model_selection import cross_val_score
    import numpy as np
    
    try:
        # Convert sparse to dense if needed
        if hasattr(X, 'toarray'):
            X_dense = X.toarray()
        else:
            X_dense = X
            
        # Perform cross-validation
        cv_scores = cross_val_score(model, X_dense, y, cv=min(n_splits, len(y)), scoring='accuracy')
        
        logging.info(f"=== CROSS-VALIDATION CHECK for {model_name} ===")
        logging.info(f"CV Scores: {[round(score, 4) for score in cv_scores]}")
        logging.info(f"CV Mean: {np.mean(cv_scores):.4f}, Std: {np.std(cv_scores):.4f}")
        
        return cv_scores
    except Exception as e:
        logging.warning(f"Cross-validation failed: {e}")
        return None
    
    
def validate_training_data(X, y, texts):
    """Validate training data for common issues"""
    import numpy as np
    issues = []
    
    # Check for constant features
    if hasattr(X, 'std'):
        try:
            std_dev = X.std(axis=0)
            constant_features = np.sum(std_dev == 0)
            if constant_features > 0:
                issues.append(f"{constant_features} constant features detected")
        except:
            pass
    
    # Check class distribution
    from collections import Counter
    class_counts = Counter(y)
    if len(class_counts) < 2:
        issues.append("Only one class in data")
    
    # Check sample size
    if len(y) < 10:
        issues.append("Very small dataset (<10 samples)")
    
    # Check feature dimensionality
    if hasattr(X, 'shape') and len(X.shape) > 1:
        if X.shape[1] > X.shape[0]:
            issues.append("More features than samples (curse of dimensionality)")
    
    return issues

class ProgressCallback:
    def __init__(self):
        self.progress = 0
        self.status = "Starting..."
        
    def __call__(self, args, state, control, **kwargs):
        if state.max_steps > 0:
            self.progress = int((state.global_step / state.max_steps) * 100)
            self.status = f"Training step {state.global_step}/{state.max_steps}"
        return control
       
@app.route("/api/predict_transformer", methods=["POST"])
def api_predict_transformer():
    """
    Handle transformer model predictions (BERT variants)
    """
    import numpy as np
    from collections import Counter
    import logging
    from sklearn.model_selection import train_test_split
    from sklearn.metrics import (
        accuracy_score, precision_score, recall_score, f1_score,
        classification_report
    )
    
    try:
        # Import transformers - will fail gracefully if not installed
        from transformers import (
            AutoTokenizer, AutoModelForSequenceClassification,
            Trainer, TrainingArguments
        )
        import torch
        from torch.utils.data import Dataset
    except ImportError as e:
        logging.error(f"Transformers library not installed: {e}")
        return jsonify({
            "error": "Transformer models require the 'transformers' library",
            "message": "Please install: pip install transformers torch"
        }), 500
    
    data = request.get_json(force=True)
    rows = data.get("rows", [])
    model_type = data.get("model", "bert-tiny")
    test_size = max(0.05, min(0.9, float(data.get("testSize", 0.3))))
    random_state = int(data.get("randomState", 42))
    
    logging.info(f"=== TRANSFORMER PREDICTION REQUEST ===")
    logging.info(f"Model: {model_type}")
    logging.info(f"Number of rows: {len(rows)}")
    
    if not rows:
        return jsonify({"error": "No data received"}), 400
    
    # Extract texts and labels
    texts = []
    labels = []
    for r in rows:
        text = r.get("text", r.get("email", ""))
        label = r.get("label")
        if text and label is not None:
            texts.append(str(text))
            labels.append(label)
    
    if not texts or not labels:
        return jsonify({"error": "Missing text or label fields"}), 400
    
    if len(set(labels)) < 2:
        return jsonify({"error": "At least two classes are required."}), 400
    
    try:
        # Map model type to HuggingFace model name
        model_map = {
            'bert-tiny': 'prajjwal1/bert-tiny',
            'bert-small': 'prajjwal1/bert-small',
            'distilbert': 'distilbert-base-uncased',
            'bert': 'bert-base-uncased'
        }
        
        model_name = model_map.get(model_type, 'prajjwal1/bert-tiny')
        
        # Create label mapping
        unique_labels = sorted(set(labels))
        label2id = {label: idx for idx, label in enumerate(unique_labels)}
        id2label = {idx: label for label, idx in label2id.items()}
        num_labels = len(unique_labels)
        
        # Convert labels to integers
        labels_int = [label2id[label] for label in labels]
        
        # Train-test split
        texts_train, texts_test, y_train, y_test = train_test_split(
            texts, labels_int, test_size=test_size, random_state=random_state, 
            stratify=labels_int
        )
        
        logging.info(f"Train size: {len(texts_train)}, Test size: {len(texts_test)}")
        logging.info(f"Loading model: {model_name}")
        
        # Load tokenizer and model
        tokenizer = AutoTokenizer.from_pretrained(model_name)
        model = AutoModelForSequenceClassification.from_pretrained(
            model_name,
            num_labels=num_labels,
            id2label=id2label,
            label2id=label2id
        )
        
        # Create custom dataset class
        class TextDataset(Dataset):
            def __init__(self, texts, labels, tokenizer, max_length=128):
                self.encodings = tokenizer(
                    texts, 
                    truncation=True, 
                    padding=True, 
                    max_length=max_length,
                    return_tensors='pt'
                )
                self.labels = torch.tensor(labels)
            
            def __getitem__(self, idx):
                item = {key: val[idx] for key, val in self.encodings.items()}
                item['labels'] = self.labels[idx]
                return item
            
            def __len__(self):
                return len(self.labels)
        
        # Create datasets
        train_dataset = TextDataset(texts_train, y_train, tokenizer)
        test_dataset = TextDataset(texts_test, y_test, tokenizer)
        
        # Training arguments - lightweight for quick training
        training_args = TrainingArguments(
            output_dir='./results',
            num_train_epochs=3,
            per_device_train_batch_size=8,
            per_device_eval_batch_size=8,
            warmup_steps=100,
            weight_decay=0.01,
            logging_dir='./logs',
            logging_steps=10,
            evaluation_strategy="epoch",
            save_strategy="no",
            load_best_model_at_end=False,
            report_to="none"
        )
        
        # Create trainer
        trainer = Trainer(
            model=model,
            args=training_args,
            train_dataset=train_dataset,
            eval_dataset=test_dataset
        )
        
        logging.info("Starting model training...")
        trainer.train()
        
        # Get predictions
        logging.info("Getting predictions...")
        predictions = trainer.predict(test_dataset)
        y_pred = np.argmax(predictions.predictions, axis=1)
        
        # Calculate metrics
        accuracy = round(float(accuracy_score(y_test, y_pred)), 3)
        precision = round(float(precision_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
        recall = round(float(recall_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
        f1 = round(float(f1_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
        
        # Convert back to original labels for classification report
        y_test_labels = [id2label[i] for i in y_test]
        y_pred_labels = [id2label[i] for i in y_pred]
        
        report = classification_report(y_test_labels, y_pred_labels, zero_division=0)
        
        logging.info(f"Accuracy: {accuracy}, Precision: {precision}, Recall: {recall}, F1: {f1}")
        
        # Get misclassified examples
        misclassified = [
            texts_test[i][:100] 
            for i in range(len(y_test)) 
            if y_test[i] != y_pred[i]
        ]
        
        # Map model type to display name
        model_names = {
            'bert-tiny': 'BERT-Tiny',
            'bert-small': 'BERT-Small',
            'distilbert': 'DistilBERT',
            'bert': 'BERT'
        }
        
        return jsonify({
            "model": model_names.get(model_type, model_type),
            "metrics": {
                "accuracy": accuracy,
                "precision": precision,
                "recall": recall,
                "f1": f1
            },
            "classification_report": report,
            "labels": unique_labels,
            "y_true": y_test_labels,
            "y_pred": y_pred_labels,
            "misclassified": misclassified,
            "preprocessing": None
        })
        
    except Exception as e:
        logging.exception("Transformer prediction failed")
        return jsonify({"error": str(e)}), 500
    
@app.route("/api/predict_transformer_stream", methods=["POST"])
def api_predict_transformer_stream():
    """
    Stream transformer model training progress
    """
    def generate():
        try:
            from transformers import (
                AutoTokenizer, AutoModelForSequenceClassification,
                Trainer, TrainingArguments, TrainerCallback
            )
            import torch
            from torch.utils.data import Dataset
            import numpy as np
            from sklearn.model_selection import train_test_split
            from sklearn.metrics import (
                accuracy_score, precision_score, recall_score, f1_score,
                classification_report
            )
            
            data = request.get_json(force=True)
            rows = data.get("rows", [])
            model_type = data.get("model", "bert-tiny")
            test_size = max(0.05, min(0.9, float(data.get("testSize", 0.3))))
            random_state = int(data.get("randomState", 42))
            
            # Send initial progress
            yield f"data: {json.dumps({'progress': 0, 'status': 'Loading data...'})}\n\n"
            
            # Extract texts and labels
            texts = []
            labels = []
            for r in rows:
                text = r.get("text", r.get("email", ""))
                label = r.get("label")
                if text and label is not None:
                    texts.append(str(text))
                    labels.append(label)
            
            yield f"data: {json.dumps({'progress': 5, 'status': 'Preparing model...'})}\n\n"
            
            # Map model type
            model_map = {
                'bert-tiny': 'prajjwal1/bert-tiny',
                'bert-small': 'prajjwal1/bert-small',
                'distilbert': 'distilbert-base-uncased',
                'bert': 'bert-base-uncased'
            }
            
            model_name = model_map.get(model_type, 'prajjwal1/bert-tiny')
            
            # Create label mapping
            unique_labels = sorted(set(labels))
            label2id = {label: idx for idx, label in enumerate(unique_labels)}
            id2label = {idx: label for label, idx in label2id.items()}
            num_labels = len(unique_labels)
            labels_int = [label2id[label] for label in labels]
            
            # Train-test split
            texts_train, texts_test, y_train, y_test = train_test_split(
                texts, labels_int, test_size=test_size, random_state=random_state, 
                stratify=labels_int
            )
            
            yield f"data: {json.dumps({'progress': 10, 'status': f'Loading {model_name}...'})}\n\n"
            
            # Load tokenizer and model
            tokenizer = AutoTokenizer.from_pretrained(model_name)
            model = AutoModelForSequenceClassification.from_pretrained(
                model_name,
                num_labels=num_labels,
                id2label=id2label,
                label2id=label2id
            )
            
            yield f"data: {json.dumps({'progress': 20, 'status': 'Tokenizing texts...'})}\n\n"
            
            # Create dataset
            class TextDataset(Dataset):
                def __init__(self, texts, labels, tokenizer, max_length=128):
                    self.encodings = tokenizer(
                        texts, 
                        truncation=True, 
                        padding=True, 
                        max_length=max_length,
                        return_tensors='pt'
                    )
                    self.labels = torch.tensor(labels)
                
                def __getitem__(self, idx):
                    item = {key: val[idx] for key, val in self.encodings.items()}
                    item['labels'] = self.labels[idx]
                    return item
                
                def __len__(self):
                    return len(self.labels)
            
            train_dataset = TextDataset(texts_train, y_train, tokenizer)
            test_dataset = TextDataset(texts_test, y_test, tokenizer)
            
            yield f"data: {json.dumps({'progress': 30, 'status': 'Starting training...'})}\n\n"
            
            # Custom callback for progress
            class StreamCallback(TrainerCallback):
                def __init__(self, total_steps):
                    self.total_steps = total_steps
                    
                def on_step_end(self, args, state, control, **kwargs):
                    if state.global_step % 5 == 0:  # Update every 5 steps
                        progress = 30 + int((state.global_step / self.total_steps) * 60)
                        epoch = state.epoch if state.epoch else 0
                        msg = f"data: {json.dumps({'progress': progress, 'status': f'Training: Epoch {epoch:.1f}'})}\n\n"
                        # Note: This won't actually stream in real-time due to Trainer limitations
                        # But we'll use it for final progress updates
                    return control
            
            # Training arguments
            training_args = TrainingArguments(
                output_dir='./results',
                num_train_epochs=3,
                per_device_train_batch_size=8,
                per_device_eval_batch_size=8,
                warmup_steps=100,
                weight_decay=0.01,
                logging_dir='./logs',
                logging_steps=10,
                eval_strategy="epoch",
                save_strategy="no",
                load_best_model_at_end=False,
                report_to="none"
            )
            
            # Calculate total steps
            total_steps = (len(train_dataset) // 8) * 3  # batches * epochs
            
            # Create trainer with callback
            trainer = Trainer(
                model=model,
                args=training_args,
                train_dataset=train_dataset,
                eval_dataset=test_dataset,
                callbacks=[StreamCallback(total_steps)]
            )
            
            # Train (this is blocking, progress won't update during training)
            trainer.train()
            
            yield f"data: {json.dumps({'progress': 90, 'status': 'Evaluating model...'})}\n\n"
            
            # Get predictions
            predictions = trainer.predict(test_dataset)
            y_pred = np.argmax(predictions.predictions, axis=1)
            
            # Calculate metrics
            accuracy = round(float(accuracy_score(y_test, y_pred)), 3)
            precision = round(float(precision_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
            recall = round(float(recall_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
            f1 = round(float(f1_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
            
            y_test_labels = [id2label[i] for i in y_test]
            y_pred_labels = [id2label[i] for i in y_pred]
            
            report = classification_report(y_test_labels, y_pred_labels, zero_division=0)
            
            misclassified = [
                texts_test[i][:100] 
                for i in range(len(y_test)) 
                if y_test[i] != y_pred[i]
            ]
            
            model_names = {
                'bert-tiny': 'BERT-Tiny',
                'bert-small': 'BERT-Small',
                'distilbert': 'DistilBERT',
                'bert': 'BERT'
            }
            
            result = {
                "model": model_names.get(model_type, model_type),
                "metrics": {
                    "accuracy": accuracy,
                    "precision": precision,
                    "recall": recall,
                    "f1": f1
                },
                "classification_report": report,
                "labels": unique_labels,
                "y_true": y_test_labels,
                "y_pred": y_pred_labels,
                "misclassified": misclassified,
                "preprocessing": None
            }
            
            yield f"data: {json.dumps({'progress': 100, 'status': 'Complete!', 'result': result})}\n\n"
            
        except Exception as e:
            logging.exception("Transformer prediction failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"
    
    return Response(stream_with_context(generate()), mimetype='text/event-stream')  


@app.route("/healthz")
def healthz():
    return "ok", 200

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)

