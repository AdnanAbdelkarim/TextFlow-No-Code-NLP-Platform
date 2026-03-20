# 🧠 Text Analysis Dashboard

An interactive and modular web application built using **Flask** for performing comprehensive **text analysis** on labeled datasets. The dashboard supports core Natural Language Processing (NLP) tasks such as frequency analysis, word clouds, sentiment scoring, keyword extraction, and predictive modeling.

> 👨‍🔬 This project was developed as part of an academic research initiative under the supervision of **Dr. Uzair Ahmed**, with implementation and development led by **Adnan Abdelkarim** as a **Research Assistant**. It is currently under consideration for **publication** and potential **productization**.


---

## 🚀 Features

- 📂 Upload `.csv` or `.txt` files with labeled text data  
- 📊 Word frequency, Zipf's Law plot, and word co-occurrence network  
- 🔍 Named Entity Recognition (NER)  
- ☁️ Word cloud generation with stopword removal  
- 📈 Sentiment analysis using AFINN  
- 🧠 Predictive modeling using Naive Bayes, Logistic Regression, and KNN  
- 📉 Confusion matrix, classification report, and ROC curve visualization  
- 🧪 Type I and Type II error breakdown (binary classification only)  
- 💡 TF-IDF vectorization support *(available for Logistic Regression and KNN models only)*
- 🛠️ Modular Flask backend and clearly separated utilities  

---

## 🗂️ Project Structure

```
├── .vscode/
├── static/
│   ├── css/
│   │   └── all.css
│   └── js/
│       ├── 1.js
│       ├── afinn.json
│       ├── predictive.js
│       ├── preprocessing.js
│       └── script.js
├── templates/
│   ├── advanced.html
│   ├── index.html
│   ├── overview.html
│   ├── predictive.html
│   ├── preprocessing.html
│   └── visualizations.html
├── .python-version
├── main.py
├── requirements.txt
└── utils.py
```

---

## ⚙️ Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/AdnanAbdelkarim/Text_Analysis_Dashboard.git
cd Text_Analysis_Dashboard
```

### 2. Set up and activate a Python 3.11 virtual environment

```bash
python3.11 -m venv venv311
source venv311/bin/activate  # Mac/Linux
venv311\Scripts\activate    # Windows
```

### 3. Install dependencies

```bash
pip install -r requirements.txt
pip install spacy
```

### 4. Run the application

```bash
python main.py
```

---

## 📦 Requirements

```
Flask>=2.2,<3.0
flask-cors
gunicorn>=21.2
spacy==3.7.5
en-core-web-sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.7.1/en_core_web_sm-3.7.1-py3-none-any.whl
numpy<2
scikit-learn>=1.3,<1.6
scipy>=1.10,<1.12
gensim>=4.3
nltk>=3.8
afinn>=0.1
```

---

## 📚 Academic Context & Research Value

This project is part of an independent academic research initiative collaboratively developed by:

- **Dr. Uzair Ahmed** *(Supervisor)*
- **Adnan Abdelkarim** *(Research Assistant)*

It aims to demonstrate practical, scalable NLP capabilities through a modular text analysis dashboard and may be included in a future peer-reviewed publication.

---

## 📜 License & Attribution

**Authors:** Adnan Abdelkarim and Dr. Uzair Ahmed  
This project is part of an academic research collaboration. If you reference or build upon this work, please cite the forthcoming publication when available.

---

## 🙌 Acknowledgements

Special thanks to **Dr. Uzair Ahmed** for his supervision, guidance, and continuous support throughout the development of this project.
