import { CONFIG } from './config.js';

export class BloomFilter {
  constructor(size = 100000, numHashes = 4) {
    this.size = size;
    this.numHashes = numHashes;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }
  
  add(item) {
    for (let i = 0; i < this.numHashes; i++) {
      const hash = this.hash(item + i) % this.size;
      const byte = Math.floor(hash / 8);
      const bit = hash % 8;
      this.bits[byte] |= (1 << bit);
    }
  }
  
  has(item) {
    for (let i = 0; i < this.numHashes; i++) {
      const hash = this.hash(item + i) % this.size;
      const byte = Math.floor(hash / 8);
      const bit = hash % 8;
      if ((this.bits[byte] & (1 << bit)) === 0) return false;
    }
    return true;
  }
  
  hash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash = hash & hash;
    }
    return Math.abs(hash);
  }
}

export class HierarchicalBloomFilter {
  constructor() {
    this.levels = [
      { filter: new BloomFilter(10000, 3), maxAge: 3600000, name: 'recent' },     // 1 hour
      { filter: new BloomFilter(50000, 4), maxAge: 86400000, name: 'daily' },     // 24 hours
      { filter: new BloomFilter(100000, 5), maxAge: 604800000, name: 'weekly' }   // 7 days
    ];
    this.timestamps = new Map();
  }
  
  add(item) {
    const now = Date.now();
    
    // Add to all levels
    this.levels.forEach(level => {
      level.filter.add(item);
    });
    
    // Track timestamp
    this.timestamps.set(item, now);
    
    // Cleanup old timestamps periodically
    if (this.timestamps.size > 10000) {
      this.cleanup();
    }
  }
  
  has(item) {
    const timestamp = this.timestamps.get(item);
    if (!timestamp) return false;
    
    const age = Date.now() - timestamp;
    
    // Check appropriate level based on age
    for (const level of this.levels) {
      if (age <= level.maxAge) {
        return level.filter.has(item);
      }
    }
    
    return false;
  }
  
    cleanup() {
      const now = Date.now();
      const maxAge = this.levels[this.levels.length - 1].maxAge;
      
      // Count items before cleanup
      const beforeSize = this.timestamps.size;
      
      // Remove old timestamps
      for (const [item, timestamp] of this.timestamps) {
        if (now - timestamp > maxAge) {
          this.timestamps.delete(item);
        }
      }
      
      // If we removed more than 50% of items, reset bloom filters
    if (this.timestamps.size < beforeSize / 2) {
        console.log(`Resetting bloom filters (cleaned ${beforeSize - this.timestamps.size} items)`);
        // Re-add remaining items to new filters
        const remainingItems = Array.from(this.timestamps.keys());
        this.levels.forEach(level => {
            level.filter = new BloomFilter(
                level.filter.size, 
                level.filter.numHashes
            );
        });
        // Re-add all remaining items
        remainingItems.forEach(item => {
            this.levels.forEach(level => level.filter.add(item));
        });
      }
    }

  reset() {
    this.levels.forEach(level => {
      level.filter = new BloomFilter(
        level.filter.size, 
        level.filter.numHashes
      );
    });
    this.timestamps.clear();
  }
  
  getStats() {
    return {
      totalItems: this.timestamps.size,
      levels: this.levels.map(level => ({
        name: level.name,
        size: level.filter.bits.length * 8,
        maxAge: level.maxAge
      }))
    };
  }
}


export const wait = ms => new Promise(r => setTimeout(r, ms));
    
export async function waitForWebTorrent() {
      if (CONFIG.LOCAL_MODE) return;
      const t0 = performance.now();
      while (typeof WebTorrent === "undefined") {
        if (performance.now() - t0 > 10_000) throw new Error("WebTorrent failed to load in 10 s");
        await wait(100);
      }
    }


export const generateId = () => Math.random().toString(36).substr(2, 9);
export function sanitize(content) {
  // 1 · Trim early
  if (content.length > CONFIG.MAX_POST_SIZE) {
    content = content.slice(0, CONFIG.MAX_POST_SIZE);
  }

  // 2 · Use DOMPurify when available
  if (window.DOMPurify) {
    const purified = DOMPurify.sanitize(content, {
      ALLOWED_TAGS: [ 'b', 'i', 'em', 'strong', 'a', 'code', 'br' ],
      ALLOWED_ATTR: [ 'href', 'target', 'rel' ],   // ← array form
      ALLOW_URI_WITHOUT_PROTOCOL: true,            // allow “example.com”
      RETURN_TRUSTED_TYPE: false
    });

    // 3 · Optional: force safe link behaviour
    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel',   'noopener noreferrer');
      }
    });

    return purified;
  }

  // 4 · Fallback: plain-text escape
  const d = document.createElement('div');
  d.textContent = content;
  return d.innerHTML;
}

export function timeAgo(ts) {
      const s = ~~((Date.now() - ts) / 1000);
      if (s < 5) return "just now";
      if (s < 60) return `${s}s ago`;
      const m = ~~(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = ~~(m / 60);
      if (h < 24) return `${h}h ago`;
      return `${~~(h / 24)}d ago`;
    }
    
export function notify(msg, dur = 3000) {
      const n = document.createElement("div");
      n.className = "notification";
      n.textContent = msg;
      document.body.appendChild(n);
      setTimeout(() => {
        n.style.animationDirection = "reverse";
        setTimeout(() => n.remove(), 300);
      }, dur);
    }


export function arrayBufferToBase64(buffer) {
    if (!buffer) return null;
    if (typeof buffer === 'string') return buffer; // Already base64
    
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

export const base64ToArrayBuffer = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
};
export function normalizePeerId(id) {
  if (!id) return null;

  if (typeof id === 'string') {
    return id;
  } else if (id instanceof Uint8Array) {
    return Array.from(id).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (id && id.constructor && id.constructor.name === 'Buffer') {
    const uint8 = new Uint8Array(id);
    return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (id && (id.type === 'Buffer' || id.data)) {
    const uint8 = new Uint8Array(id.data || id);
    return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
  } else if (ArrayBuffer.isView(id)) {
    const uint8 = new Uint8Array(id.buffer, id.byteOffset, id.byteLength);
    return Array.from(uint8).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  console.error('Unknown peer ID type:', typeof id, id);
  return null;
}

export function hexToUint8Array (hex) {
  if (hex.length % 2) throw new Error('hex length must be even');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export const JSONStringifyWithBigInt = (obj) => {
    return JSON.stringify(obj, (key, value) => {
        if (typeof value === 'bigint') {
            return value.toString() + 'n'; // Add 'n' suffix to identify BigInts
        }
        return value;
    });
};

export const JSONParseWithBigInt = (str) => {
    return JSON.parse(str, (key, value) => {
        if (typeof value === 'string' && /^\d+n$/.test(value)) {
            return BigInt(value.slice(0, -1));
        }
        return value;
    });
};
export const isReply = (post) => post && post.parentId;
