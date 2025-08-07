// FILE: services/activity-profile.js
import { state } from '../state.js';

class ActivityProfile {
    constructor() {
        this.authorAffinities = new Map(); // handle -> score
        this.positiveInteractions = new Set(); // Set of post IDs
        this.similarUsers = new Set(); // Set of handles
        this.updateInterval = null;
    }

    start() {
        if (this.updateInterval) clearInterval(this.updateInterval);
        
        // Periodically find users with similar topic interests.
        this.updateInterval = setInterval(() => this.findSimilarUsers(), 5 * 60 * 1000); // every 5 mins
        this.findSimilarUsers(); // Run once on start
    }

    stop() {
        if (this.updateInterval) clearInterval(this.updateInterval);
    }


    /**
     * Returns the set of post IDs the user has positively engaged with.
     * @returns {Set<string>}
     */
    getPositiveInteractionPostIds() {
        return this.positiveInteractions;
    }


    /**
     * Updates affinity for an author based on user actions.
     *  @param {Post} post The post object of the interaction.
     * @param {'upvote' | 'reply'} action The action taken by the user.
     */
    updateAuthorAffinity(post, action) {
        if (post.author === state.myIdentity.handle) return; // Don't track affinity for self
        
        this.positiveInteractions.add(post.id); 
        
        let score = this.authorAffinities.get(post.author) || 0;
        const increment = action === 'upvote' ? 1 : 2; // Replies are a stronger signal
         this.authorAffinities.set(post.author, score + increment);
    }

    /**
     * Finds users with similar topic subscriptions by checking peer profiles.
     */
    async findSimilarUsers() {
        if (!state.dht || state.peers.size === 0) return;

        const myTopics = state.subscribedTopics;
        if (myTopics.size === 0) return;

        const newSimilarUsers = new Set();
        const peers = Array.from(state.peers.values()).slice(0, 30); // Check up to 30 peers

        for (const peer of peers) {
            if (peer.handle) {
                try {
                    const profileData = await state.dht.get(`profile:${peer.handle}`);
                    const profile = profileData ? (profileData.value || profileData) : null;
                    
                    if (profile && profile.subscriptions) {
                        const userTopics = new Set(profile.subscriptions);
                        const intersection = new Set([...myTopics].filter(t => userTopics.has(t)));
                        
                        // If we share 2+ topics, or they have few topics and we share one, they're similar.
                        const similarityThreshold = Math.min(2, Math.floor(myTopics.size / 2));
                        if (intersection.size >= Math.max(1, similarityThreshold)) {
                           newSimilarUsers.add(peer.handle);
                        }
                    }
                } catch (e) { /* Ignore errors */ }
            }
        }
        
        if (newSimilarUsers.size > 0) {
            this.similarUsers = newSimilarUsers;
            console.log(`[ActivityProfile] Found ${this.similarUsers.size} similar users.`);
        }
    }
}

// Export a singleton instance
export const activityProfile = new ActivityProfile();
