// --- IMPORTS ---
import { state, debugPostRemoval } from '../main.js';
import { dropPost } from '../ui.js';
import { HierarchicalBloomFilter, BloomFilter, isReply } from '../utils.js';


export class MemoryManager {
  constructor() {
    this.checkInterval = 30000;
    this.targetMemoryUsage = 0.7;
    this.criticalMemoryUsage = 0.85;
    this.postScores = new Map();
    this.startMonitoring();
  }
  
  calculatePostPriority(post) {
    const now = Date.now();
    const age = (now - post.timestamp) / (1000 * 60 * 60); // hours
    const isExplicitlyCarried = state.explicitlyCarrying.has(post.id);
    const carrierCount = post.carriers.size;
    const replyCount = post.replies.size;
    
    // Calculate heat score
    const heat = carrierCount + (replyCount * 2);
    
    // Priority formula
    let priority = heat / Math.pow(age + 1, 1.5); // Decay over time
    
    // Boost for explicit carries
    if (isExplicitlyCarried) priority *= 100;
    
    // Boost for posts we authored
    if (post.author === state.myIdentity.handle) priority *= 10;
    
  // Boost for replies in active threads
  if (post.parentId) {
    const parent = state.posts.get(post.parentId);
    if (parent && parent.carriers.size > 0) {
      priority *= 5; // Keep replies to carried posts
    }
  }
  
  return priority;
}

  
  async getMemoryUsage() {
    if (performance.memory) {
      return {
        used: performance.memory.usedJSHeapSize,
        total: performance.memory.jsHeapSizeLimit,
        ratio: performance.memory.usedJSHeapSize / performance.memory.jsHeapSizeLimit
      };
    }
    
    // Fallback: estimate based on post count
    const avgPostSize = 2048; // 2KB average
    const estimatedUsage = state.posts.size * avgPostSize;
    return {
      used: estimatedUsage,
      total: 100 * 1024 * 1024, // 100MB assumed limit
      ratio: estimatedUsage / (100 * 1024 * 1024)
    };
  }
  
  async checkMemory() {
    const memory = await this.getMemoryUsage();
    
    // Update post scores periodically
    if (Math.random() < 0.1 || memory.ratio > this.targetMemoryUsage) {
      this.updatePostScores();
    }
    
    if (memory.ratio > this.criticalMemoryUsage) {
      console.warn(`Critical memory usage: ${Math.round(memory.ratio * 100)}%`);
      await this.emergencyCleanup();
    } else if (memory.ratio > this.targetMemoryUsage) {
      console.log(`High memory usage: ${Math.round(memory.ratio * 100)}%`);
      await this.adaptiveCleanup(memory.ratio);
    }
  }
  
  updatePostScores() {
    this.postScores.clear();
    for (const [id, post] of state.posts) {
      this.postScores.set(id, this.calculatePostPriority(post));
    }
  }
  
      async adaptiveCleanup(memoryRatio) {
        const targetRatio = 0.5;
        const reductionFactor = targetRatio / memoryRatio;
        const targetPostCount = Math.floor(state.posts.size * reductionFactor);
        
        // Sort posts by priority
        const sortedPosts = Array.from(state.posts.entries())
            .map(([id, post]) => ({
                id,
                post,
                priority: this.postScores.get(id) || this.calculatePostPriority(post)
            }))
            .sort((a, b) => b.priority - a.priority);
        
        // Keep only the highest priority posts, but NEVER remove replies
        const toKeep = new Set();
        let keptCount = 0;
        
        for (const { id, post } of sortedPosts) {
            if (keptCount < targetPostCount || isReply(post) || state.explicitlyCarrying.has(id)) {
                toKeep.add(id);
                if (!isReply(post)) {  // Only count non-replies against target
                    keptCount++;
                }
            }
        }
        
        // Remove low priority posts (but never replies)
        for (const [id, post] of state.posts) {
            if (!toKeep.has(id) && !isReply(post) && !state.explicitlyCarrying.has(id)) {
                // Only drop if no one else is carrying AND it's not a reply
                if (post.carriers.size === 0) {
                    if (!debugPostRemoval(id, 'adaptive cleanup')) {
                        state.posts.delete(id);
                        dropPost(id);
                    }
                }
            }
        }
        
        // Clean up bloom filters if they're too large
        if (state.seenMessages instanceof HierarchicalBloomFilter) {
          // Check the actual size of stored timestamps
          if (state.seenMessages.timestamps && state.seenMessages.timestamps.size > 50000) {
            state.seenMessages.cleanup();
            console.log("Cleaned up message bloom filter");
          }
        } else if (state.seenMessages.bits && state.seenMessages.bits.length > 50000) {
          state.seenMessages = new BloomFilter(100000, 4);
          console.log("Reset message bloom filter");
        }
        
        if (state.seenPosts.bits.length > 50000) {
            state.seenPosts = new BloomFilter(100000, 4);
            console.log("Reset post bloom filter");
        }
    }
    
    async emergencyCleanup() {
        // Keep only explicitly carried posts, very recent posts, AND ALL REPLIES
        const oneHourAgo = Date.now() - (60 * 60 * 1000);
        const toKeep = new Set();
        
        for (const [id, post] of state.posts) {
            if (state.explicitlyCarrying.has(id) || 
                post.timestamp > oneHourAgo ||
                post.author === state.myIdentity.handle ||
                isReply(post)) { // NEW: Always keep replies
                toKeep.add(id);
            }
        }
            
        // Remove everything else (except replies)
        for (const id of state.posts.keys()) {
            if (!toKeep.has(id)) {
                const post = state.posts.get(id);
                // Only drop if no one is carrying AND it's not a reply
                if (post && post.carriers.size === 0 && !isReply(post)) {
                    if (!debugPostRemoval(id, 'emergency cleanup')) {
                        state.posts.delete(id);
                        dropPost(id);
                    }
                }
            }
        }
        
        // Force garbage collection if available
        if (window.gc) {
            window.gc();
        }
        
        console.log(`Emergency cleanup: kept ${toKeep.size} posts`);
    }
  
  startMonitoring() {
    
    // More frequent checks during high activity
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        this.checkMemory();
      }
    });
  }
}
