import { state } from '../state.js';

export class PeerManager {
  constructor() {
    this.scores = new Map();
    
    // Reputation thresholds
    this.REPUTATION_LEVELS = {
      UNTRUSTED: 0,
      NEW: 10,
      BASIC: 50,
      TRUSTED: 100,
      HIGHLY_TRUSTED: 500
    };
    
    // Action weights for reputation calculation
    this.ACTION_WEIGHTS = {
      CONNECTION: 1,
      MESSAGE: 0.1,
      POST: 5,
      VALID_POST: 10,
      INVALID_POST: -50,
      ATTESTATION: 2,
      CORRECT_ATTESTATION: 20,
      FALSE_ATTESTATION: -100,
      UPTIME_HOUR: 1
    };
  }
  
  // Initialize or get peer data
  getPeerData(peerId) {
    if (!this.scores.has(peerId)) {
      this.scores.set(peerId, {
        // Basic metrics
        messages: 0,
        posts: 0,
        validPosts: 0,
        invalidPosts: 0,
        
        // Attestation metrics
        attestations: 0,
        correctAttestations: 0,
        falseAttestations: 0,
        
        // Connection metrics
        firstSeen: Date.now(),
        uptime: Date.now(),
        disconnections: 0,
        
        // Quality metrics
        quality: 1.0,
        reputationScore: 0,
        lastCalculated: 0
      });
    }
    return this.scores.get(peerId);
  }
  
  updateScore(peerId, action, value = 1) {
    const data = this.getPeerData(peerId);
    
    switch(action) {
      case 'connection':
        data.uptime = Date.now();
        data.reputationScore += this.ACTION_WEIGHTS.CONNECTION * value;
        break;
        
      case 'disconnection':
        data.disconnections += 1;
        data.quality *= 0.95; // Small quality penalty for disconnections
        break;
        
      case 'message':
        data.messages += value;
        break;
        
      case 'post':
        data.posts += value;
        data.reputationScore += this.ACTION_WEIGHTS.POST * value;
        break;
        
      case 'valid_post':
        data.validPosts += value;
        data.reputationScore += this.ACTION_WEIGHTS.VALID_POST * value;
        break;
        
      case 'invalid_post':
        data.invalidPosts += value;
        data.reputationScore += this.ACTION_WEIGHTS.INVALID_POST * value;
        data.quality *= 0.8; // Significant quality penalty
        break;
        
      case 'attestation':
        data.attestations += value;
        data.reputationScore += this.ACTION_WEIGHTS.ATTESTATION * value;
        break;
        
      case 'correct_attestation':
        data.correctAttestations += value;
        data.reputationScore += this.ACTION_WEIGHTS.CORRECT_ATTESTATION * value;
        data.quality = Math.min(1.5, data.quality * 1.02); // Slight quality boost
        break;
        
      case 'false_attestation':
        data.falseAttestations += value;
        data.reputationScore += this.ACTION_WEIGHTS.FALSE_ATTESTATION * value;
        data.quality *= 0.5; // Major quality penalty
        break;
        
      case 'data':
        // Legacy support for data transfer tracking
        break;
        
      case 'error':
        data.quality *= 0.9;
        break;
    }
    
    // Ensure reputation doesn't go below 0
    data.reputationScore = Math.max(0, data.reputationScore);
    
    // Mark as needing recalculation
    data.lastCalculated = 0;
  }
  
  // Calculate comprehensive reputation score
  getScore(peerId) {
    const data = this.getPeerData(peerId);
    
    // Recalculate if needed (cached for 1 minute)
    if (Date.now() - data.lastCalculated > 60000) {
      // Calculate uptime bonus
      const ageHours = (Date.now() - data.firstSeen) / (1000 * 60 * 60);
      const uptimeBonus = ageHours * this.ACTION_WEIGHTS.UPTIME_HOUR;
      
      // Calculate attestation accuracy
      const totalAttestationAttempts = data.correctAttestations + data.falseAttestations;
      const attestationAccuracy = totalAttestationAttempts > 0 
        ? data.correctAttestations / totalAttestationAttempts 
        : 0.5; // Default to neutral if no attestations
      
      // Calculate post validity rate
      const totalPostAttempts = data.validPosts + data.invalidPosts;
      const postValidityRate = totalPostAttempts > 0
        ? data.validPosts / totalPostAttempts
        : 0.5; // Default to neutral
      
      // Combine all factors
      const baseScore = data.reputationScore + uptimeBonus;
      const accuracyMultiplier = (attestationAccuracy * 0.5) + (postValidityRate * 0.5);
      const finalScore = baseScore * data.quality * accuracyMultiplier;
      
      // Cache the calculated score
      data.calculatedScore = Math.max(0, finalScore);
      data.lastCalculated = Date.now();
      
      console.log(`[PeerManager] Calculated reputation for ${peerId}:`, {
        baseScore: baseScore.toFixed(2),
        quality: data.quality.toFixed(2),
        attestationAccuracy: (attestationAccuracy * 100).toFixed(1) + '%',
        postValidityRate: (postValidityRate * 100).toFixed(1) + '%',
        finalScore: data.calculatedScore.toFixed(2)
      });
    }
    
    return data.calculatedScore || 0;
  }
  
  // Get reputation level for a peer
  getReputationLevel(peerId) {
    const score = this.getScore(peerId);
    
    if (score >= this.REPUTATION_LEVELS.HIGHLY_TRUSTED) return 'HIGHLY_TRUSTED';
    if (score >= this.REPUTATION_LEVELS.TRUSTED) return 'TRUSTED';
    if (score >= this.REPUTATION_LEVELS.BASIC) return 'BASIC';
    if (score >= this.REPUTATION_LEVELS.NEW) return 'NEW';
    return 'UNTRUSTED';
  }
  
  // Check if peer is trusted enough to accept attestations
  canTrustAttestations(peerId) {
    const level = this.getReputationLevel(peerId);
    return level === 'TRUSTED' || level === 'HIGHLY_TRUSTED';
  }
  
  // Get best peers by reputation
  getBestPeers(count = 10) {
    return Array.from(state.peers.entries())
      .map(([id, peer]) => ({ 
        id, 
        peer, 
        score: this.getScore(id),
        level: this.getReputationLevel(id)
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, count)
      .map(item => item.peer);
  }
  
  // Get reputation statistics
  getReputationStats() {
    const stats = {
      totalPeers: 0,
      untrusted: 0,
      new: 0,
      basic: 0,
      trusted: 0,
      highlyTrusted: 0
    };
    
    for (const [peerId] of state.peers) {
      stats.totalPeers++;
      const level = this.getReputationLevel(peerId).toLowerCase().replace('_', '');
      stats[level]++;
    }
    
    return stats;
  }
  
  // Debug method to see all peer reputations
  debugReputations() {
    const peers = [];
    
    for (const [peerId] of state.peers) {
      const data = this.getPeerData(peerId);
      const score = this.getScore(peerId);
      
      peers.push({
        id: peerId.substring(0, 8) + '...',
        score: score.toFixed(2),
        level: this.getReputationLevel(peerId),
        posts: data.posts,
        validPosts: data.validPosts,
        attestations: data.attestations,
        accuracy: data.attestations > 0 
          ? ((data.correctAttestations / (data.correctAttestations + data.falseAttestations)) * 100).toFixed(1) + '%'
          : 'N/A'
      });
    }
    
    return peers.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
  }
}
