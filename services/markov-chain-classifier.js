/**
 * A simple Markov Chain-based text classifier to detect harmful sequences.
 * It calculates the probability of word sequences against a trained model of harmful phrases.
 */
// ADD THIS IMPORT
import MARKOV_MODEL from './trained_markov_model.json' with { type: 'json' };


export class MarkovChainClassifier {
    constructor() {
        // transitions['word_a']['word_b'] = count of 'word_b' appearing after 'word_a'
        this.transitions = {};
        this.startWords = {};
    }

    /**
     * A simple tokenizer (consistent with NaiveBayesClassifier).
     * @param {string} text - The input string.
     * @returns {string[]} An array of tokenized words.
     */
    tokenize(text) {
        if (typeof text !== 'string') return [];
        const cleanedText = text.replace(/[^\w\s]/g, '').toLowerCase();
        return cleanedText.split(/\s+/).filter(word => word.length > 0);
    }

    /**
     * Loads the pre-trained model.
     */
    // MODIFY THIS METHOD
    loadModel() {
        this.transitions = MARKOV_MODEL.transitions || {};
        this.startWords = MARKOV_MODEL.startWords || {};
        console.log("[MarkovChain] Harmful sequence model loaded.");
    }

    /**
     * Analyzes text for harmful sequences based on the loaded model.
     * @param {string} text - The text to analyze.
     * @returns {object|null} A violation object if a harmful sequence is found, otherwise null.
     */
    analyze(text) {
        const tokens = this.tokenize(text);
        if (tokens.length < 2) return null;

        let totalLogProb = 0;
        let harmfulSequenceCount = 0;
        let matchedSequence = [];

        for (let i = 0; i < tokens.length - 1; i++) {
            const currentWord = tokens[i];
            const nextWord = tokens[i+1];

            const nextWords = this.transitions[currentWord];
            if (nextWords && nextWords[nextWord]) {
                harmfulSequenceCount++;
                matchedSequence.push(currentWord);

                // Calculate probability: P(next|current)
                const totalTransitions = Object.values(nextWords).reduce((a, b) => a + b, 0);
                const prob = nextWords[nextWord] / totalTransitions;
                totalLogProb += Math.log(prob);
            }
        }

        if (harmfulSequenceCount === 0) return null;

        // Calculate a score based on sequence length and probability
        const avgLogProb = totalLogProb / harmfulSequenceCount;
        const confidence = 1 - Math.exp(avgLogProb); // Higher probability -> higher confidence

        // Trigger a violation if we found a sequence of 2 or more harmful words with high confidence
        if (harmfulSequenceCount >= 2 && confidence > 0.85) {
            return {
                type: 'harmful_sequence',
                severity: 'medium',
                confidence: confidence,
                match: matchedSequence.slice(0, 5).join(' ') + '...', // Show a preview
                method: 'markov_chain'
            };
        }

        return null;
    }
}
