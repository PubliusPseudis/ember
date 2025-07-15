import { state } from '../state.js';
import { notify } from '../ui.js';
import wasmVDF from '../vdf-wrapper.js';

export class ProgressiveVDF {
  constructor() {
    this.spamCache = new Map();
    this.userPostTimes = new Map();
  }
  
  // Get device-specific iteration count for target time
getIterationsForTime(targetTimeMs) {
  if (!state.myIdentity?.deviceCalibration?.iterationsPerMs) {
    // Fallback for identities created before calibration
    console.warn("[VDF] No calibration data, using fallback iterations");
    return Math.max(2000, Math.floor(targetTimeMs * 3)); // Increased minimum and multiplier
  }
  
  const iterationsPerMs = state.myIdentity.deviceCalibration.iterationsPerMs;
  const targetIterations = Math.floor(iterationsPerMs * targetTimeMs);
  
  console.log(`[VDF] Target time: ${targetTimeMs}ms, device speed: ${iterationsPerMs.toFixed(2)} iter/ms, iterations: ${targetIterations}`);
  
  return Math.max(2000, targetIterations); // Increased minimum to 2000 iterations
}
  
  // Calculate target time based on content and user behavior  
  calculateTargetTime(content, userId) {
    let baseTimeMs = 1000; // Base 1 second
    
    // Check user's recent posting frequency
    const now = Date.now();
    const userTimes = this.userPostTimes.get(userId) || [];
    const recentPosts = userTimes.filter(t => now - t < 3600000); // Last hour
    
    if (recentPosts.length > 10) {
      baseTimeMs *= 8; // Heavy poster: 8 seconds
    } else if (recentPosts.length > 5) {
      baseTimeMs *= 4; // Frequent poster: 4 seconds
    } else if (recentPosts.length > 2) {
      baseTimeMs *= 2; // Active poster: 2 seconds
    }
    
    // Check for spam patterns
    const contentLower = content.toLowerCase();
    const spamPatterns = [
      /(.)\1{4,}/, // Repeated characters
      /https?:\/\/[^\s]+/g, // Multiple URLs
      /\b(viagra|casino|forex|crypto)\b/i,
    ];
    
    const spamScore = spamPatterns.reduce((score, pattern) => {
      const matches = contentLower.match(pattern);
      return score + (matches ? matches.length : 0);
    }, 0);
    
    if (spamScore > 2) baseTimeMs *= 3; // Spam-like content: longer delay
    
    // Short posts get higher difficulty (likely spam)
    if (content.length < 20) baseTimeMs *= 2;
    
    // Cap maximum time to 30 seconds
    return Math.min(baseTimeMs, 30000);
  }
  
  async computeAdaptiveProof(content, userId, customInput = null) {
    const now = Date.now();
    
    // Calculate target time based on user behavior and content
    const targetTimeMs = this.calculateTargetTime(content, userId);
    
    // Convert time to device-specific iterations
    const iterations = this.getIterationsForTime(targetTimeMs);
    
    // Update user post times
    const times = this.userPostTimes.get(userId) || [];
    times.push(now);
    if (times.length > 20) times.shift(); // Keep last 20
    this.userPostTimes.set(userId, times);
    
    console.log(`[VDF] User ${userId}: target ${targetTimeMs}ms → ${iterations} iterations`);
    
    const estimatedTime = Math.round(targetTimeMs / 1000);
    notify(`Computing proof of work... (~${estimatedTime}s)`, Math.max(3000, targetTimeMs));
    
    // Use custom input if provided, otherwise create default
    const vdfInput = customInput || (content + userId + now);
    
    const startTime = performance.now();
    
    try {
      const result = await wasmVDF.computeVDFProofWithTimeout(
        vdfInput,
        BigInt(iterations)
      );
      
      const actualTime = performance.now() - startTime;
      console.log(`[VDF] Completed ${iterations} iterations in ${actualTime.toFixed(0)}ms (target: ${targetTimeMs}ms)`);
      
      return result;
    } catch (error) {
      console.error(`[VDF] Failed after ${performance.now() - startTime}ms:`, error);
      throw error;
    }
  }
  
  // For replies, use shorter times
  async computeReplyProof(content, userId, customInput = null) {
    // Replies get reduced time penalty
    const baseTime = this.calculateTargetTime(content, userId);
    const replyTime = Math.max(500, Math.floor(baseTime * 0.5)); // Half time for replies, minimum 0.5s
    
    const iterations = this.getIterationsForTime(replyTime);
    
    console.log(`[VDF] Reply proof: ${replyTime}ms → ${iterations} iterations`);
    
    const vdfInput = customInput || (content + userId + Date.now());
    
    return await wasmVDF.computeVDFProofWithTimeout(
      vdfInput,
      BigInt(iterations)
    );
  }
}
