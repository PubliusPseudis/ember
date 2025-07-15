/**
 * naive-bayes-classifier.js
 * * A simple Naive Bayes Classifier for text classification.
 * * Includes methods to save and load the trained model from a file.
 * * @version 1.2.0-browser
 */
import PRE_TRAINED_MODEL from './model_weights.json' assert { type: 'json' };


export class NaiveBayesClassifier {
    constructor() {
        this.wordCounts = { safe: {}, not_safe: {} };
        this.docCounts = { safe: 0, not_safe: 0 };
        this.vocab = new Set();
        this.smoothing = 1; // Laplace smoothing
    }

    /**
     * A simple tokenizer to split text into words, lowercase, and remove punctuation.
     * @param {string} text - The input string.
     * @returns {string[]} An array of tokenized words.
     */
    tokenize(text) {
        if (typeof text !== 'string') return [];
        const cleanedText = text.replace(/[^\w\s]/g, '').toLowerCase();
        return cleanedText.split(/\s+/).filter(word => word.length > 0);
    }



    /**
     * Predicts the label for a given text.
     * @param {string} text - The text to classify.
     * @returns {{label: string, probability: number}} The predicted label and its probability score.
     */
    predict(text) {
        console.log("predict called on " + text);
        const tokens = this.tokenize(text);
        const totalDocs = this.docCounts.safe + this.docCounts.not_safe;
        if (totalDocs === 0) return { label: 'safe', probability: 1.0 };

        const priorSafe = Math.log(this.docCounts.safe / totalDocs);
        const priorNotSafe = Math.log(this.docCounts.not_safe / totalDocs);

        let scoreSafe = priorSafe;
        let scoreNotSafe = priorNotSafe;

        const totalWordsSafe = Object.values(this.wordCounts.safe).reduce((a, b) => a + b, 0);
        const totalWordsNotSafe = Object.values(this.wordCounts.not_safe).reduce((a, b) => a + b, 0);
        const vocabSize = this.vocab.size;

        for (const token of tokens) {
            const wordCountSafe = this.wordCounts.safe[token] || 0;
            const probWordSafe = Math.log((wordCountSafe + this.smoothing) / (totalWordsSafe + vocabSize * this.smoothing));
            scoreSafe += probWordSafe;

            const wordCountNotSafe = this.wordCounts.not_safe[token] || 0;
            const probWordNotSafe = Math.log((wordCountNotSafe + this.smoothing) / (totalWordsNotSafe + vocabSize * this.smoothing));
            scoreNotSafe += probWordNotSafe;
        }

        const expScoreSafe = Math.exp(scoreSafe);
        const expScoreNotSafe = Math.exp(scoreNotSafe);
        const totalExpScore = expScoreSafe + expScoreNotSafe;

        const probSafe = expScoreSafe / totalExpScore;
        const probNotSafe = expScoreNotSafe / totalExpScore;

        if (probNotSafe > probSafe) {
            return { label: 'not_safe', probability: probNotSafe };
        } else {
            return { label: 'safe', probability: probSafe };
        }
    }


    /**
     * Loads a pre-trained model from a URL on your server.
     * @param {string} filePath - The path to the model file (e.g., '/services/nbc_model.json').
     */
    loadModel() {
        try {
            this.wordCounts = PRE_TRAINED_MODEL.wordCounts;
            this.docCounts = PRE_TRAINED_MODEL.docCounts;
            this.vocab = new Set(PRE_TRAINED_MODEL.vocab);
            console.log("Embedded model successfully loaded.");
        } catch (err) {
            console.error("Error loading embedded model. Check the PRE_TRAINED_MODEL object.", err);
        }
    }
}
