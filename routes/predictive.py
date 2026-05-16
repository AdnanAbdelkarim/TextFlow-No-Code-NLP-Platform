from flask import Blueprint, request, jsonify
from sklearn.model_selection import train_test_split
from services.preprocessing import preprocess_pipeline 

"""
Predictive modeling endpoints — preprocessing preview, prediction with traditional
ML models (NB, LR, SVM, KNN, GDA), and transformer-based prediction (BERT variants).

NOTE: torch and transformers are imported inside the transformer routes only,
to avoid adding 5-8 seconds to server startup time for a feature most users
never access.
"""
import json
import logging
from collections import Counter

import numpy as np
from flask import Blueprint, Response, request, jsonify, stream_with_context
from sklearn.feature_extraction.text import CountVectorizer
from sklearn.model_selection import train_test_split
from sklearn.naive_bayes import MultinomialNB
from sklearn.discriminant_analysis import (
    LinearDiscriminantAnalysis,
    QuadraticDiscriminantAnalysis
)
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.svm import SVC
from sklearn.metrics import (
    accuracy_score, precision_score, recall_score,
    f1_score, classification_report
)
from sklearn.preprocessing import StandardScaler



pred_bp = Blueprint('predictive', __name__)


@pred_bp.route('/api/preprocess', methods=['POST'])
def preprocess():
    """Apply text preprocessing pipeline."""
    try:
        data = request.get_json(force=True) or {}
        settings = data.get('settings', {})
        rows = data.get('rows', [])
        text_col = data.get('textCol', 'text')

        if not rows:
            return jsonify({'error': 'No data available for preprocessing'}), 400

        texts, labels = [], []
        for row in rows:
            text = row.get(text_col, row.get('text', row.get('email', '')))
            if text:
                texts.append(str(text))
                labels.append(row.get('label', 'Unlabeled'))

        if not texts:
            return jsonify({'error': 'No text data found'}), 400

        results = apply_preprocessing(texts, labels, settings)

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
        logging.exception("preprocess failed")
        return jsonify({'error': 'Preprocessing failed', 'detail': str(e)}), 500


@pred_bp.route('/api/predict', methods=['POST'])
def predict():
    """
    Refactored prediction endpoint with correct preprocessing order.
    """
    try:
        from sklearn.model_selection import train_test_split
        from sklearn.naive_bayes import MultinomialNB
        from sklearn.linear_model import LogisticRegression
        from sklearn.svm import SVC
        from sklearn.neighbors import KNeighborsClassifier
        from sklearn.discriminant_analysis import QuadraticDiscriminantAnalysis
        from sklearn.metrics import accuracy_score, precision_recall_fscore_support, classification_report
        
        data = request.get_json()
        
        # Extract parameters
        rows = data.get('rows', [])
        model_type = data.get('model', 'lr')
        test_size = data.get('testSize', 0.3)
        random_state = data.get('randomState', 42)
        use_preprocessed = data.get('usePreprocessed', False)
        preprocessing_settings = data.get('preprocessingSettings', {})
        
        print(f"[PREDICT] Received {len(rows)} rows, model={model_type}")
        print(f"[PREDICT] use_preprocessed={use_preprocessed}")
        print(f"[PREDICT] Settings received: {preprocessing_settings}")
        print(f"[PREDICT] useStemming={preprocessing_settings.get('useStemming')}")
        print(f"[PREDICT] useTFIDF={preprocessing_settings.get('useTFIDF')}")
        print(f"[PREDICT] useTF={preprocessing_settings.get('useTF')}")
        print(f"[PREDICT] useWord2Vec={preprocessing_settings.get('useWord2Vec')}")
        print(f"[PREDICT] vectorSize={preprocessing_settings.get('vectorSize')}")
        print(f"[PREDICT] useSMOTE={preprocessing_settings.get('useSMOTE')}")
        
        # Extract texts and labels
        texts = [row['text'] for row in rows]
        labels = [row['label'] for row in rows]
        
        # ✅ FIX #1: Preprocess ALL data first (vectorization only)
        # ✅ FIX #1: Preprocess ALL data WITHOUT resampling first
        settings_no_resample = {
            **preprocessing_settings,
            'useSMOTE': False,
            'useOversampling': False,
            'useUndersampling': False
        }

        # ✅ STEP 1: Split RAW TEXTS first — no vectorizer involved yet
        texts_train_raw, texts_test_raw, y_train, y_test = train_test_split(
            texts, labels,
            test_size=test_size,
            random_state=random_state,
            stratify=labels
        )

        print(f"[PREDICT] Raw text split — Train: {len(texts_train_raw)}, Test: {len(texts_test_raw)}")

        if use_preprocessed and preprocessing_settings:
            # ✅ STEP 2: Fit vectorizer on TRAINING texts only
            train_result = preprocess_pipeline(
                texts=texts_train_raw,
                labels=list(y_train),
                settings=settings_no_resample,
                artifacts=None  # Training mode — fits vectorizer here
            )
            X_train = train_result['vectors']
            y_train = train_result['labels']
            train_artifacts = train_result['artifacts']

            print(f"[PREDICT] Train vectorized (train-only fit): {X_train.shape}")

            # ✅ STEP 3: Transform test using TRAIN vectorizer only
            test_result = preprocess_pipeline(
                texts=texts_test_raw,
                labels=list(y_test),
                settings=settings_no_resample,
                artifacts=train_artifacts  # Test mode — no fitting
            )
            X_test = test_result['vectors']
            y_test = test_result['labels']

            print(f"[PREDICT] Test vectorized (transform only): {X_test.shape}")

        else:
            from sklearn.feature_extraction.text import TfidfVectorizer
            vectorizer = TfidfVectorizer(max_features=1000)
            X_train = vectorizer.fit_transform(texts_train_raw)
            X_test = vectorizer.transform(texts_test_raw)  # transform only

        print(f"[PREDICT] NO LEAKAGE: Vectorizer fit on {len(texts_train_raw)} train texts only")
        
        from collections import Counter
        print(f"[VERIFY] Original distribution: {dict(Counter(labels))}")
        print(f"[VERIFY] Train distribution:    {dict(Counter(y_train))}")
        print(f"[VERIFY] Test distribution:     {dict(Counter(y_test))}")
        print(f"[VERIFY] Train size: {len(y_train)}, Test size: {len(y_test)}")
        print(f"[VERIFY] Test size actual: {len(y_test)/(len(y_train)+len(y_test))*100:.1f}%")
        print(f"[PREDICT] Train: {X_train.shape}, Test: {X_test.shape}")
        
        # ✅ FIX #3: Apply resampling ONLY to training set
        resampling_used = False
        if use_preprocessed and preprocessing_settings:
            if preprocessing_settings.get('useSMOTE'):
                print("[PREDICT] Applying SMOTE to training set")
                from imblearn.over_sampling import SMOTE
                X_train_dense = X_train.toarray() if hasattr(X_train, 'toarray') else X_train
                smote = SMOTE(random_state=random_state)
                X_train, y_train = smote.fit_resample(X_train_dense, y_train)
                resampling_used = True  # ✅ Track that dense conversion happened
            elif preprocessing_settings.get('useOversampling'):
                print("[PREDICT] Applying RandomOverSampler to training set")
                from imblearn.over_sampling import RandomOverSampler
                ros = RandomOverSampler(random_state=random_state)
                X_train, y_train = ros.fit_resample(X_train, y_train)
            elif preprocessing_settings.get('useUndersampling'):
                print("[PREDICT] Applying RandomUnderSampler to training set")
                from imblearn.under_sampling import RandomUnderSampler
                rus = RandomUnderSampler(random_state=random_state)
                X_train, y_train = rus.fit_resample(X_train, y_train)

        # ✅ FIX: Match X_test format to X_train format
        # If SMOTE converted X_train to dense, X_test must also be dense
        if resampling_used and hasattr(X_test, 'toarray'):
            X_test = X_test.toarray()
            print("[PREDICT] Converted X_test to dense to match X_train format")
        
        print(f"[PREDICT] After resampling - Train: {X_train.shape}")
        
        # ✅ FIX #4: Scaling AFTER resampling (if Word2Vec)
        if use_preprocessed and preprocessing_settings.get('useWord2Vec'):
            print("[PREDICT] Applying StandardScaler")
            from sklearn.preprocessing import StandardScaler
            scaler = StandardScaler(with_mean=False)
            X_train = scaler.fit_transform(X_train)
            X_test = scaler.transform(X_test)
        
        # Select and train model
        # ✅ FIX: Use GaussianNB instead of MultinomialNB when SMOTE is used
        # MultinomialNB requires non-negative integers — breaks with SMOTE dense output
        if resampling_used and model_type == 'nb':
            from sklearn.naive_bayes import GaussianNB
            print("[PREDICT] Switching NB → GaussianNB (SMOTE produces continuous values)")
            nb_model = GaussianNB()
        else:
            nb_model = MultinomialNB()

        models = {
            'nb': nb_model,
            'lr': LogisticRegression(max_iter=1000, random_state=random_state),
            'svm': SVC(kernel='linear', probability=True, random_state=random_state),
            'knn': KNeighborsClassifier(n_neighbors=5),
            'gda': QuadraticDiscriminantAnalysis()
        }
        model = models.get(model_type, LogisticRegression())
        
        print(f"[PREDICT] Training {model_type} model")
        model.fit(X_train, y_train)
        
        # Predict
        y_pred = model.predict(X_test)
        
        y_prob = None
        if hasattr(model, 'predict_proba'):
            y_prob_all = model.predict_proba(X_test)

            # ✅ FIX: Check if probabilities are degenerate (all exactly 0.0 or 1.0)
            unique_probs = np.unique(y_prob_all.round(6))
            is_degenerate = all(p in [0.0, 1.0] for p in unique_probs)

            if is_degenerate:
                print(f"[WARN] Degenerate probabilities (only 0s and 1s). ROC suppressed.")
                y_prob = None
            else:
                if y_prob_all.shape[1] == 2:
                    y_prob = y_prob_all[:, 1].tolist()
                else:
                    y_prob = y_prob_all.tolist()
                print(f"[PREDICT] Valid probabilities — range: {y_prob_all.min():.3f} to {y_prob_all.max():.3f}")
        
        # Calculate metrics
        accuracy = accuracy_score(y_test, y_pred)
        precision, recall, f1, _ = precision_recall_fscore_support(
            y_test, y_pred, average='weighted', zero_division=0
        )
        report = classification_report(y_test, y_pred, zero_division=0)
        
        print(f"[PREDICT] Accuracy: {accuracy:.3f}, F1: {f1:.3f}")
        
        return jsonify({
            'metrics': {
                'accuracy': float(accuracy),
                'precision': float(precision),
                'recall': float(recall),
                'f1': float(f1)
            },
            'classification_report': report,
            'y_true': [str(label) for label in y_test],
            'y_pred': [str(pred) for pred in y_pred],
            'y_prob': y_prob,
            'debug_info': {
                'train_size': len(y_train),
                'test_size': len(y_test),
                'resampling_applied': len(y_train) != len(texts) * (1 - test_size)
            }
        })
        
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[ERROR] predict failed: {error_trace}")
        return jsonify({
            'error': str(e),
            'traceback': error_trace
        }), 500


# Shared helpers for transformer routes (consolidates ~100 lines of duplication)
_MODEL_MAP = {
    'bert-tiny': 'prajjwal1/bert-tiny',
    'bert-small': 'prajjwal1/bert-small',
    'distilbert': 'distilbert-base-uncased',
    'bert': 'bert-base-uncased'
}
_MODEL_DISPLAY_NAMES = {
    'bert-tiny': 'BERT-Tiny', 'bert-small': 'BERT-Small',
    'distilbert': 'DistilBERT', 'bert': 'BERT'
}


def _build_text_dataset_class():
    """Lazy-build TextDataset class (avoids torch import at module load)."""
    import torch
    from torch.utils.data import Dataset

    class TextDataset(Dataset):
        def __init__(self, texts, labels, tokenizer, max_length=128):
            self.encodings = tokenizer(
                texts, truncation=True, padding=True,
                max_length=max_length, return_tensors='pt'
            )
            self.labels = torch.tensor(labels)

        def __getitem__(self, idx):
            item = {k: v[idx] for k, v in self.encodings.items()}
            item['labels'] = self.labels[idx]
            return item

        def __len__(self):
            return len(self.labels)

    return TextDataset

@pred_bp.route("/api/predict_transformer_stream", methods=["POST"])
def api_predict_transformer_stream():
    """Stream transformer training progress via Server-Sent Events."""

    data = request.get_json(force=True)
    rows = data.get("rows", [])
    model_type = data.get("model", "bert-tiny")
    test_size = max(0.05, min(0.9, float(data.get("testSize", 0.3))))
    random_state = int(data.get("randomState", 42))
    
    def generate():
        try:
            from transformers import Trainer, TrainingArguments, TrainerCallback
            from transformers import BertForSequenceClassification
            
            # ✅ FIX: Try multiple import paths for tokenizer
            try:
                from transformers import BertTokenizer
            except ImportError:
                from transformers.models.bert import BertTokenizer
            
            try:
                from transformers import DistilBertTokenizer, DistilBertForSequenceClassification
            except ImportError:
                from transformers.models.distilbert import DistilBertTokenizer, DistilBertForSequenceClassification
            from sklearn.model_selection import train_test_split
            from sklearn.metrics import (
                accuracy_score, precision_score, recall_score, f1_score, classification_report
            )

            yield f"data: {json.dumps({'progress': 0, 'status': 'Loading data...'})}\n\n"

            texts, labels = [], []
            for r in rows:
                text = r.get("text", r.get("email", ""))
                label = r.get("label")
                if text and label is not None:
                    texts.append(str(text))
                    labels.append(label)

            yield f"data: {json.dumps({'progress': 5, 'status': 'Preparing model...'})}\n\n"

            model_name = _MODEL_MAP.get(model_type, 'prajjwal1/bert-tiny')
            unique_labels = sorted(set(labels))
            label2id = {l: i for i, l in enumerate(unique_labels)}
            id2label = {i: l for l, i in label2id.items()}
            labels_int = [label2id[l] for l in labels]

            texts_train, texts_test, y_train, y_test = train_test_split(
                texts, labels_int, 
                test_size=test_size, 
                random_state=random_state,
                stratify=labels_int  # ✅ Maintains class distribution
            )

            yield f"data: {json.dumps({'progress': 10, 'status': f'Loading {model_name}...'})}\n\n"

            # ✅ FIX: Use model-specific classes based on model type
            if model_type == 'distilbert':
                tokenizer = DistilBertTokenizer.from_pretrained(model_name)
                model = DistilBertForSequenceClassification.from_pretrained(
                    model_name, num_labels=len(unique_labels),
                    id2label=id2label, label2id=label2id
                )
            else:
                # bert-tiny, bert-small, bert all use BertTokenizer
                tokenizer = BertTokenizer.from_pretrained(model_name)
                model = BertForSequenceClassification.from_pretrained(
                    model_name, num_labels=len(unique_labels),
                    id2label=id2label, label2id=label2id
                )

            yield f"data: {json.dumps({'progress': 20, 'status': 'Tokenizing texts...'})}\n\n"

            TextDataset = _build_text_dataset_class()
            train_dataset = TextDataset(texts_train, y_train, tokenizer)
            test_dataset = TextDataset(texts_test, y_test, tokenizer)

            yield f"data: {json.dumps({'progress': 30, 'status': 'Starting training...'})}\n\n"

            # ✅ FIX: Use a queue to pass progress from callback to generator
            import queue
            progress_queue = queue.Queue()

            class StreamCallback(TrainerCallback):
                def __init__(self, total_steps, q):
                    self.total_steps = max(total_steps, 1)
                    self.q = q

                def on_step_end(self, args, state, control, **kwargs):
                    if state.global_step % 5 == 0:
                        progress = 30 + int((state.global_step / self.total_steps) * 60)
                        # ✅ FIX: Actually send progress via queue
                        self.q.put({'progress': min(progress, 89), 'status': f'Training step {state.global_step}/{self.total_steps}...'})
                    return control

            training_args = TrainingArguments(
                output_dir='./results', num_train_epochs=3,
                per_device_train_batch_size=8, per_device_eval_batch_size=8,
                warmup_steps=100, weight_decay=0.01,
                logging_dir='./logs', logging_steps=10,
                eval_strategy="epoch", save_strategy="no",
                load_best_model_at_end=False, report_to="none"
            )

            total_steps = (len(train_dataset) // 8) * 3

            trainer = Trainer(
                model=model, args=training_args,
                train_dataset=train_dataset, eval_dataset=test_dataset,
                callbacks=[StreamCallback(total_steps, progress_queue)]  # ✅ Pass queue
            )
            
            # ✅ FIX: Run training in thread, drain queue for progress updates
            import threading
            training_done = threading.Event()
            training_error = [None]

            def run_training():
                try:
                    trainer.train()
                except Exception as e:
                    training_error[0] = e
                finally:
                    training_done.set()

            training_thread = threading.Thread(target=run_training)
            training_thread.start()

            # Drain progress queue while training runs
            while not training_done.is_set() or not progress_queue.empty():
                try:
                    msg = progress_queue.get(timeout=0.5)
                    yield f"data: {json.dumps(msg)}\n\n"
                except queue.Empty:
                    continue

            if training_error[0]:
                raise training_error[0]

            yield f"data: {json.dumps({'progress': 90, 'status': 'Evaluating model...'})}\n\n"

            predictions = trainer.predict(test_dataset)
            y_pred = np.argmax(predictions.predictions, axis=1)

            accuracy = round(float(accuracy_score(y_test, y_pred)), 3)
            precision = round(float(precision_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
            recall = round(float(recall_score(y_test, y_pred, average='weighted', zero_division=0)), 3)
            f1 = round(float(f1_score(y_test, y_pred, average='weighted', zero_division=0)), 3)

            y_test_labels = [id2label[i] for i in y_test]
            y_pred_labels = [id2label[i] for i in y_pred]
            report = classification_report(y_test_labels, y_pred_labels, zero_division=0)
            misclassified = [texts_test[i][:100] for i in range(len(y_test)) if y_test[i] != y_pred[i]]

            result = {
                "model": _MODEL_DISPLAY_NAMES.get(model_type, model_type),
                "metrics": {"accuracy": accuracy, "precision": precision, "recall": recall, "f1": f1},
                "classification_report": report,
                "labels": unique_labels,
                "y_true": y_test_labels, "y_pred": y_pred_labels,
                "misclassified": misclassified,
                "preprocessing": None
            }

            yield f"data: {json.dumps({'progress': 100, 'status': 'Complete!', 'result': result})}\n\n"
        except Exception as e:
            logging.exception("api_predict_transformer_stream failed")
            yield f"data: {json.dumps({'error': str(e)})}\n\n"

    # ✅ FIX: Return the generator as a streaming Flask response
    return Response(
        generate(),
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'  # Prevents nginx from buffering the stream
        }
    )
            
@pred_bp.route('/api/preprocess_preview', methods=['POST'])
def preprocess_preview():
    """
    Preview endpoint for preprocessing - used by frontend to show results
    before applying to actual modeling.
    """
    try:
        data = request.get_json()
        
        # Extract data
        rows = data.get('rows', [])
        settings = data.get('settings', {})
        
        # Extract texts and labels
        texts = [row['text'] for row in rows]
        labels = [row['label'] for row in rows]
        
        print(f"[PREVIEW] Processing {len(texts)} texts with settings: {settings}")
        
        # Apply preprocessing (training mode - no artifacts)
        result = preprocess_pipeline(
            texts=texts,
            labels=labels,
            settings=settings,
            artifacts=None  # Training mode
        )
        
        print(f"[PREVIEW] Result: vocab_size={result.get('vocab_size')}, n_features={result.get('n_features')}")
        
        # Calculate class distributions
        from collections import Counter
        original_dist = dict(Counter(labels))
        processed_dist = dict(Counter(result['labels']))
        
        # Return preview data
        return jsonify({
            'vocab_size': result.get('vocab_size', 0),
            'vector_dimensions': result.get('n_features', 0),
            'processed_sample': result['processed_texts'][0] if result['processed_texts'] else '',
            'original_class_distribution': original_dist,
            'processed_class_distribution': processed_dist,
            'n_samples': result.get('n_samples', len(result['labels']))
        })
        
    except Exception as e:
        import traceback
        error_trace = traceback.format_exc()
        print(f"[ERROR] preprocess_preview failed: {error_trace}")
        return jsonify({
            'error': str(e),
            'detail': error_trace
        }), 500