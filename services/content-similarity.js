// FILE: services/content-similarity.js

import { getServices } from './instances.js';

/**
 * Manages content similarity calculations using TF-IDF and Cosine Similarity.
 * This allows for finding topically related posts without relying on explicit hashtags.
 */
class ContentSimilarity {
    constructor() {
        // word -> number of documents the word appears in.
        this.documentFrequencies = new Map();
        // postId -> TF-IDF vector (Map<word, score>)
        this.postVectors = new Map();
        // Pre-calculated vector magnitudes for faster cosine similarity
        this.postMagnitudes = new Map();
        // Total number of posts in the corpus
        this.postCount = 0;
        // Common words to ignore during tokenization
        this.stopWords = new Set(['and', 'the', 'is', 'in', 'it', 'a', 'an', 'of', 'to', 'for', 'i', 'you', 'he', 'she', 'they', 'we', 'was', 'were', 'has', 'have', 'with', 'on', 'at', 'by']);
    }

    /**
     * Cleans and tokenizes text, removing stop words.
     * @param {string} text The input text.
     * @returns {string[]} An array of significant words.
     */
    tokenizeAndClean(text) {
        if (!text) return [];
        return text
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '') // Remove punctuation
            .split(/\s+/)
            .filter(word => word && !this.stopWords.has(word));
    }

    /**
     * Adds a post to the corpus, updating frequencies and creating its vector.
     * @param {Post} post The post object to add.
     */
    addPost(post) {
        if (this.postVectors.has(post.id)) return; // Already processed

        this.postCount++;
        const tokens = this.tokenizeAndClean(post.content);
        const uniqueTokens = new Set(tokens);

        // Update document frequencies
        for (const token of uniqueTokens) {
            this.documentFrequencies.set(token, (this.documentFrequencies.get(token) || 0) + 1);
        }

        // We must recalculate all vectors when document frequencies change
        this.recalculateAllVectors();
    }

    /**
     * Removes a post from the corpus and updates frequencies.
     * @param {Post} post The post object to remove.
     */
    removePost(post) {
        if (!this.postVectors.has(post.id)) return;

        this.postCount--;
        const tokens = this.tokenizeAndClean(post.content);
        const uniqueTokens = new Set(tokens);

        // Decrement document frequencies
        for (const token of uniqueTokens) {
            const currentFreq = this.documentFrequencies.get(token);
            if (currentFreq === 1) {
                this.documentFrequencies.delete(token);
            } else {
                this.documentFrequencies.set(token, currentFreq - 1);
            }
        }

        this.postVectors.delete(post.id);
        this.postMagnitudes.delete(post.id);
        // A full recalculation is needed as all IDF values have changed
        this.recalculateAllVectors();
    }

    /**
     * Recalculates all post vectors. This is necessary when the IDF values change.
     */
    recalculateAllVectors() {
        const { posts } = getServices().stateManager.state;
        for (const post of posts.values()) {
            const tokens = this.tokenizeAndClean(post.content);
            const vector = this.calculateTfidfVector(tokens);
            this.postVectors.set(post.id, vector);
            this.postMagnitudes.set(post.id, this.calculateMagnitude(vector));
        }
    }

    /**
     * Calculates the TF-IDF vector for a set of tokens.
     * @param {string[]} tokens The tokens of a single document.
     * @returns {Map<string, number>} The TF-IDF vector.
     */
    calculateTfidfVector(tokens) {
        const vector = new Map();
        if (tokens.length === 0) return vector;

        const termFrequencies = new Map();
        for (const token of tokens) {
            termFrequencies.set(token, (termFrequencies.get(token) || 0) + 1);
        }

        for (const [term, count] of termFrequencies) {
            const tf = count / tokens.length;
            const docFreq = this.documentFrequencies.get(term) || 1;
            const idf = Math.log(this.postCount / docFreq);
            vector.set(term, tf * idf);
        }
        return vector;
    }

    /**
     * Calculates the magnitude (length) of a vector.
     * @param {Map<string, number>} vector The input vector.
     * @returns {number} The magnitude.
     */
    calculateMagnitude(vector) {
        let sumOfSquares = 0;
        for (const score of vector.values()) {
            sumOfSquares += score * score;
        }
        return Math.sqrt(sumOfSquares);
    }

    /**
     * Calculates the cosine similarity between two post vectors.
     * @param {string} postIdA The ID of the first post.
     * @param {string} postIdB The ID of the second post.
     * @returns {number} The similarity score (0 to 1).
     */
    getCosineSimilarity(postIdA, postIdB) {
        const vecA = this.postVectors.get(postIdA);
        const vecB = this.postVectors.get(postIdB);
        const magA = this.postMagnitudes.get(postIdA);
        const magB = this.postMagnitudes.get(postIdB);

        if (!vecA || !vecB || !magA || !magB) return 0;

        let dotProduct = 0;
        for (const [term, scoreA] of vecA) {
            if (vecB.has(term)) {
                dotProduct += scoreA * vecB.get(term);
            }
        }

        return dotProduct / (magA * magB);
    }
}

// Export a singleton instance
export const contentSimilarity = new ContentSimilarity();
