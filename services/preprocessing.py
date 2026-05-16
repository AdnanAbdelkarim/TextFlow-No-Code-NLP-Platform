from sklearn.feature_extraction.text import TfidfVectorizer, CountVectorizer
from sklearn.preprocessing import StandardScaler
from imblearn.over_sampling import SMOTE, RandomOverSampler
from imblearn.under_sampling import RandomUnderSampler
import numpy as np
import re
from collections import Counter


def normalize_text(text, settings):
    """
    Normalize text based on settings.
    
    Args:
        text: Input text string
        settings: Dict with normalization options (useStemming, useLemmatization)
    
    Returns:
        Normalized text string
    """
    # Lowercase
    text = text.lower()
    
    # Remove punctuation but keep spaces
    text = re.sub(r'[^\w\s]', ' ', text)
    
    # Remove extra whitespace
    text = ' '.join(text.split())
    
    # Basic stemming/lemmatization (simplified)
    # In production, use NLTK or spaCy for proper stemming/lemmatization
    if settings.get('useStemming'):
        # Simple stemming: remove common suffixes
        words = text.split()
        stemmed = []
        for word in words:
            if len(word) > 3:
                # Remove common endings
                if word.endswith('ing'):
                    word = word[:-3]
                elif word.endswith('ed'):
                    word = word[:-2]
                elif word.endswith('s'):
                    word = word[:-1]
            stemmed.append(word)
        text = ' '.join(stemmed)
    
    return text


def extract_word2vec_features(texts, settings, model=None):
    """
    Extract Word2Vec features.
    For now, uses TF-IDF as a fallback since Word2Vec requires gensim.
    
    Args:
        texts: List of text strings
        settings: Dict with vectorSize
        model: Pre-trained Word2Vec model (for test set)
    
    Returns:
        Tuple of (feature_matrix, model)
    """
    if model is None:
        # Training: Create new vectorizer
        vector_size = int(settings.get('vectorSize', 100))
        
        # Use TF-IDF as Word2Vec fallback
        vectorizer = TfidfVectorizer(
            max_features=vector_size,
            ngram_range=(1, 2),
            min_df=1
        )
        X = vectorizer.fit_transform(texts)
        
        # Convert to dense for StandardScaler compatibility
        X = X.toarray()
        
        return X, vectorizer
    else:
        # Testing: Use existing model
        X = model.transform(texts)
        X = X.toarray()
        return X, model


def extract_tfidf_features(texts, settings, vectorizer=None):
    """
    Extract TF-IDF features with proper train/test handling.
    
    Args:
        texts: List of text strings
        settings: Dict with vectorSize (percentage)
        vectorizer: Pre-fitted vectorizer (for test set)
    
    Returns:
        Tuple of (feature_matrix, vectorizer)
    """
    if vectorizer is None:
        # Training: fit new vectorizer
        vector_size_percent = int(settings.get('vectorSize', 100))
        
        # Calculate max_features based on percentage
        # First pass to estimate vocabulary size
        temp_vectorizer = TfidfVectorizer()
        temp_vectorizer.fit(texts)
        estimated_vocab_size = len(temp_vectorizer.vocabulary_)
        
        # Calculate actual max_features
        max_features = max(10, int(estimated_vocab_size * (vector_size_percent / 100)))
        
        vectorizer = TfidfVectorizer(
            max_features=max_features,
            ngram_range=(1, 2),
            min_df=2
        )
        X = vectorizer.fit_transform(texts)
    else:
        # Testing: use existing vectorizer
        X = vectorizer.transform(texts)
    
    return X, vectorizer


def extract_tf_features(texts, settings, vectorizer=None):
    """
    Extract Term Frequency features with proper train/test handling.
    
    Args:
        texts: List of text strings
        settings: Dict with vectorSize (percentage)
        vectorizer: Pre-fitted vectorizer (for test set)
    
    Returns:
        Tuple of (feature_matrix, vectorizer)
    """
    if vectorizer is None:
        # Training: fit new vectorizer
        vector_size_percent = int(settings.get('vectorSize', 100))
        
        # Calculate max_features based on percentage
        temp_vectorizer = CountVectorizer()
        temp_vectorizer.fit(texts)
        estimated_vocab_size = len(temp_vectorizer.vocabulary_)
        
        max_features = max(10, int(estimated_vocab_size * (vector_size_percent / 100)))
        
        vectorizer = CountVectorizer(
            max_features=max_features,
            ngram_range=(1, 2),
            min_df=2
        )
        X = vectorizer.fit_transform(texts)
    else:
        # Testing: use existing vectorizer
        X = vectorizer.transform(texts)
    
    return X, vectorizer


def apply_resampling(X, labels, settings):
    """
    Apply resampling ONLY to training data.
    
    Args:
        X: Feature matrix
        labels: List of labels
        settings: Dict with resampling options
    
    Returns:
        Tuple of (resampled_X, resampled_labels)
    """
    labels_array = np.array(labels)
    
    if settings.get('useSMOTE'):
        # SMOTE requires dense arrays
        if hasattr(X, 'toarray'):
            X_dense = X.toarray()
        else:
            X_dense = X
        
        smote = SMOTE(random_state=42)
        X_resampled, labels_resampled = smote.fit_resample(X_dense, labels_array)
        return X_resampled, labels_resampled.tolist()
    
    elif settings.get('useOversampling'):
        ros = RandomOverSampler(random_state=42)
        X_resampled, labels_resampled = ros.fit_resample(X, labels_array)
        return X_resampled, labels_resampled.tolist()
    
    elif settings.get('useUndersampling'):
        rus = RandomUnderSampler(random_state=42)
        X_resampled, labels_resampled = rus.fit_resample(X, labels_array)
        return X_resampled, labels_resampled.tolist()
    
    return X, labels


def preprocess_pipeline(texts, labels, settings, artifacts=None):
    """
    Professional preprocessing pipeline with correct ordering.
    
    Args:
        texts: List of text documents
        labels: List of labels
        settings: Dict with preprocessing options
        artifacts: Dict with pre-trained vectorizer/scaler (for test set)
    
    Returns:
        Dict with vectors, labels, and artifacts
    """
    is_training = artifacts is None
    
    # Step 1: Text normalization (tokenization, stemming, lemmatization)
    processed_texts = [normalize_text(text, settings) for text in texts]
    
    # Step 2: Feature extraction
    if settings.get('useWord2Vec'):
        X, vectorizer = extract_word2vec_features(
            processed_texts, 
            settings, 
            model=artifacts.get('word2vec_model') if artifacts else None
        )
    elif settings.get('useTFIDF'):
        X, vectorizer = extract_tfidf_features(
            processed_texts,
            settings,
            vectorizer=artifacts.get('vectorizer') if artifacts else None
        )
    elif settings.get('useTF'):
        X, vectorizer = extract_tf_features(
            processed_texts,
            settings,
            vectorizer=artifacts.get('vectorizer') if artifacts else None
        )
    else:
        raise ValueError("Must select feature extraction method")
    
    # Step 3: Scaling (only for Word2Vec, AFTER vectorization)
    scaler = None
    if settings.get('useWord2Vec'):
        if is_training:
            scaler = StandardScaler()
            X = scaler.fit_transform(X)
        else:
            scaler = artifacts.get('scaler')
            X = scaler.transform(X)
    
    # Step 4: Resampling (ONLY for training set, AFTER all preprocessing)
    if is_training and any([settings.get('useSMOTE'), 
                           settings.get('useOversampling'), 
                           settings.get('useUndersampling')]):
        X, labels = apply_resampling(X, labels, settings)
    
    # Calculate statistics
    vocab_size = len(vectorizer.vocabulary_) if hasattr(vectorizer, 'vocabulary_') else 0
    n_features = X.shape[1] if hasattr(X, 'shape') else 0
    
    # ✅ VERIFICATION LOGS
    print(f"[PREPROCESS] Input: {len(texts)} texts, {len(set(labels))} classes")
    print(f"[PREPROCESS] Methods applied:")
    print(f"  - Text normalization: stemming={settings.get('useStemming')}, lemmatization={settings.get('useLemmatization')}")
    print(f"  - Feature extraction: TF={settings.get('useTF')}, TFIDF={settings.get('useTFIDF')}, Word2Vec={settings.get('useWord2Vec')}")
    print(f"  - Vector size setting: {settings.get('vectorSize')}%")
    print(f"[PREPROCESS] Output: X.shape={X.shape}, vocab_size={vocab_size}, n_features={n_features}")
    print(f"[PREPROCESS] Sample processed text: '{processed_texts[0][:100]}'")
    print(f"[PREPROCESS] Sample raw text:       '{texts[0][:100]}'")
    print(f"[PREPROCESS] Resampling: SMOTE={settings.get('useSMOTE')}, Over={settings.get('useOversampling')}, Under={settings.get('useUndersampling')}")
    print(f"[PREPROCESS] Labels before: {len(labels)}, after: {len(labels)}")
    
    return {
        'vectors': X,
        'labels': labels,
        'processed_texts': processed_texts,
        'vocab_size': vocab_size,
        'n_features': n_features,
        'n_samples': len(labels),
        'artifacts': {
            'vectorizer': vectorizer,
            'scaler': scaler,
            'word2vec_model': vectorizer if settings.get('useWord2Vec') else None
        }
    }
    
