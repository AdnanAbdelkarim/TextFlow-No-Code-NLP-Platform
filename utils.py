import re
from collections import Counter, defaultdict
import nltk
nltk.download('stopwords')
from nltk.corpus import stopwords

def tokenize(text, include_stopwords=False):
    stop_words = set(stopwords.words('english'))
    tokens = re.findall(r"\b\w+\b", text.lower())
    return [t for t in tokens if include_stopwords or t not in stop_words]

def analyze_text_csv(df, top_n=100, min_link=2, include_stopwords=False):
    freq = Counter()
    cooccur = defaultdict(int)
    topic_map = {}

    for _, row in df.iterrows():
        text = str(row.get("text", ""))
        cls = str(row.get("label", "Unknown"))
        tokens = tokenize(text, include_stopwords)
        unique = set(tokens)
        for token in unique:
            freq[token] += 1
            topic_map[token] = cls
        for w1 in unique:
            for w2 in unique:
                if w1 < w2:
                    cooccur[(w1, w2)] += 1

    top_words = [w for w, _ in freq.most_common(top_n)]

    nodes = [{"id": w, "freq": freq[w], "group": topic_map.get(w, "Unknown")} for w in top_words]

    links = [
        {"source": a, "target": b, "value": v}
        for (a, b), v in cooccur.items()
        if a in top_words and b in top_words and v >= min_link
    ]

    return {"nodes": nodes, "links": links}
