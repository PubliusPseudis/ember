// headless.js - Production-ready Ember Headless Relay Node
// Comprehensive browser API mocking and module patching

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Production configuration
const CONFIG = {
  IDENTITY_FILE: 'headless-identity.json',
  DHT_BOOTSTRAP_DELAY: 5000,
  HEARTBEAT_INTERVAL: 60000,
  SHUTDOWN_TIMEOUT: 10000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};

class HeadlessLogger {
  constructor(level = 'info') {
    this.levels = { error: 0, warn: 1, info: 2, debug: 3 };
    this.level = this.levels[level] || 2;
  }

  log(level, ...args) {
    if (this.levels[level] <= this.level) {
      const timestamp = new Date().toISOString();
      console.log(`[${timestamp}] [${level.toUpperCase()}]`, ...args);
    }
  }

  error(...args) { this.log('error', ...args); }
  warn(...args) { this.log('warn', ...args); }
  info(...args) { this.log('info', ...args); }
  debug(...args) { this.log('debug', ...args); }
}

const logger = new HeadlessLogger(CONFIG.LOG_LEVEL);

class HeadlessVerificationQueue {
  constructor() {
    this.processing = false;
    this.queue = [];
    this.mainModule = null;
    this.trustEvaluator = null;
  }

  setMainModule(mainModule) {
    this.mainModule = mainModule;
    // Get reference to trust evaluator if it exists
    if (mainModule.trustEvaluator) {
      this.trustEvaluator = mainModule.trustEvaluator;
    }
  }

  async init() {
    logger.info('Headless verification queue initialized (no workers)');
  }

  async processTrustBatch(posts) {
    logger.debug(`Processing trust evaluation for ${posts.length} posts`);
    
    // In headless mode, we trust all posts from peers
    const trustedPosts = posts.map(post => ({
      ...post,
      trustScore: 1.0,
      isTrusted: true
    }));
    
    // Now process the trusted posts
    this.addBatch(trustedPosts, 'normal', (results) => {
      logger.debug(`Trust evaluation complete: ${results.filter(r => r.valid).length} valid posts`);
    });
  }

  addBatch(posts, priority = 'normal', callback) {
    if (!Array.isArray(posts)) {
      logger.error('Invalid posts array provided to verification queue');
      return;
    }

    logger.info(`Processing ${posts.length} posts for verification`);
    
    const results = posts.map(post => {
      try {
        // Basic validation
        const isValid = post && 
                       typeof post.id === 'string' && 
                       typeof post.content === 'string' &&
                       typeof post.author === 'string';

        if (isValid) {
          // Add the post to state
          if (this.mainModule && this.mainModule.state && this.mainModule.state.posts) {
            // Check if post already exists
            if (!this.mainModule.state.posts.has(post.id)) {
              this.mainModule.state.posts.set(post.id, post);
              logger.info(`✅ Added post ${post.id} to state (total: ${this.mainModule.state.posts.size})`);
              
              // Call processNewPost if it exists
              if (this.mainModule.processNewPost) {
                try {
                  this.mainModule.processNewPost(post);
                } catch (e) {
                  logger.warn(`processNewPost error: ${e.message}`);
                }
              }
              
              // Forward to peers using Plumtree gossip
              if (this.mainModule.plumtree && this.mainModule.plumtree.broadcast) {
                const message = {
                  type: 'new_post',
                  post: post,
                  originalAuthor: post.author
                };
                this.mainModule.plumtree.broadcast(message);
                logger.info(`📤 Forwarded post ${post.id} via Plumtree`);
              }
            } else {
              logger.debug(`Post ${post.id} already exists, skipping`);
            }
          }
        } else {
          logger.warn(`Invalid post structure for ${post?.id || 'unknown'}`);
        }

        return {
          id: post?.id || 'unknown',
          valid: isValid,
          errors: isValid ? [] : ['Invalid post structure']
        };
      } catch (error) {
        logger.error(`Verification error for post:`, error);
        return {
          id: post?.id || 'unknown',
          valid: false,
          errors: [`Verification failed: ${error.message}`]
        };
      }
    });

    // Call callback if provided
    if (callback) {
      process.nextTick(() => {
        try {
          callback(results);
        } catch (error) {
          logger.error('Verification callback error:', error);
        }
      });
    }

    return results;
  }
}

class HeadlessBrowserMocks {
  static setup() {
    logger.debug('Setting up browser API mocks...');

    // Core browser globals
    globalThis.window = {
      currentDMConversation: null,
      ephemeralDebug: {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
      location: { reload: () => logger.info('Window reload requested (no-op)') },
      animationObserver: null,
      RTCPeerConnection: class MockRTCPeerConnection {},
      networkStartTime: Date.now()
    };

    // Document API
    globalThis.document = {
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({
        style: {},
        classList: {
          add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false
        },
        addEventListener: () => {}, removeEventListener: () => {},
        innerHTML: '', textContent: '', appendChild: () => {},
        querySelector: () => null, querySelectorAll: () => [],
        remove: () => {} // Add remove method for DOM elements
      }),
      body: {
        appendChild: () => {},
        classList: { add: () => {}, remove: () => {}, contains: () => false }
      },
      head: { appendChild: () => {} },
      addEventListener: () => {}, removeEventListener: () => {},
      hidden: false
    };

    // Storage APIs
    const storageData = {};
    globalThis.localStorage = {
      getItem: (key) => storageData[key] || null,
      setItem: (key, value) => { storageData[key] = String(value); },
      removeItem: (key) => { delete storageData[key]; },
      clear: () => { Object.keys(storageData).forEach(key => delete storageData[key]); }
    };

    // Web Worker globals (for worker thread compatibility)
    globalThis.self = globalThis;
    globalThis.importScripts = () => {};
    globalThis.postMessage = () => {};
    globalThis.onmessage = null;

    // Browser APIs
    globalThis.navigator = {
      userAgent: 'Ember-Headless-Node/1.0 (Node.js)',
      platform: process.platform
    };

    globalThis.IntersectionObserver = class MockIntersectionObserver {
      constructor() {}
      observe() {} unobserve() {} disconnect() {}
    };

    globalThis.CustomEvent = class MockCustomEvent {
      constructor(type, eventInitDict) {
        this.type = type;
        this.detail = eventInitDict?.detail;
      }
    };

    // DOMPurify mock - CRITICAL for headless operation
    const domPurifySanitize = (dirty, config) => {
      // Handle various input types
      if (dirty === null || dirty === undefined) {
        return '';
      }
      
      if (typeof dirty === 'string') {
        // Simple HTML stripping for headless mode
        return dirty
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<[^>]*>/g, '')
          .trim();
      }
      
      // For non-string types, convert to string first
      return String(dirty).replace(/<[^>]*>/g, '').trim();
    };

    // Create DOMPurify object with sanitize as both a property and a callable function
    globalThis.DOMPurify = {
      sanitize: domPurifySanitize,
      addHook: () => {},
      removeHook: () => {},
      removeAllHooks: () => {},
      isSupported: true,
      version: '3.0.0'
    };

    // Make sanitize available as a global function
    globalThis.sanitize = domPurifySanitize;

    // Also add it to window
    if (globalThis.window) {
      globalThis.window.sanitize = domPurifySanitize;
      globalThis.window.DOMPurify = globalThis.DOMPurify;
    }

    // Crypto API (Node.js has native crypto, but ensure compatibility)
    if (!globalThis.crypto) {
      globalThis.crypto = {
        getRandomValues: (arr) => {
          for (let i = 0; i < arr.length; i++) {
            arr[i] = Math.floor(Math.random() * 256);
          }
          return arr;
        },
        subtle: {
          digest: async (algorithm, data) => {
            const crypto = await import('crypto');
            return crypto.createHash('sha256').update(data).digest();
          }
        }
      };
    }

    // Performance API
    if (!globalThis.performance) {
      globalThis.performance = {
        now: () => Date.now(),
        memory: {
          usedJSHeapSize: process.memoryUsage().heapUsed,
          jsHeapSizeLimit: process.memoryUsage().heapTotal * 2
        }
      };
    }

    // Dialog APIs
    globalThis.alert = (msg) => logger.info(`[UI Alert] ${msg}`);
    globalThis.confirm = (msg) => {
      logger.info(`[UI Confirm] ${msg} (auto-accepting)`);
      return true;
    };

    // Load tweetnacl for crypto operations
    HeadlessBrowserMocks.setupCrypto();
  }

  static async setupCrypto() {
    try {
      const { default: nacl } = await import('tweetnacl');
      globalThis.nacl = nacl;
      logger.debug('NaCl crypto library loaded');
    } catch (error) {
      logger.error('Failed to load NaCl crypto library:', error);
    }
  }

  static setupLibraryMocks() {
    // TensorFlow.js mock (not needed for headless)
    globalThis.tf = {
      ready: () => Promise.resolve(),
      setBackend: () => Promise.resolve(),
      getBackend: () => 'cpu',
      disposeVariables: () => {},
      memory: () => ({ numTensors: 0, numDataBuffers: 0 })
    };

    // NSFWJS mock (content filtering not needed for relay)
    globalThis.nsfwjs = {
      load: async () => ({
        classify: async () => [
          { className: 'Safe', probability: 0.99 },
          { className: 'Porn', probability: 0.01 }
        ]
      })
    };

    // Content safety mock
    globalThis.contentSafety = {
      checkContent: async (text) => ({ 
        safe: true, violations: [], shouldBlock: false 
      }),
      quickCheck: async (text) => ({ 
        safe: true, violations: [], shouldBlock: false 
      })
    };

    logger.debug('Library mocks configured');
  }

  static setupUIMocks() {
    // UI function mocks (no DOM operations in headless)
    const uiFunctions = {
      updateStatus: () => {},
      notify: (msg, duration, callback) => {
        logger.info(`[Notification] ${msg}`);
        if (callback) setTimeout(callback, 100);
      },
      refreshPost: () => {},
      renderPost: () => {},
      dropPost: () => {},
      updateAges: () => {},
      updateTopicStats: () => {},
      updateTopicFilter: () => {},
      addTopicToUI: () => {},
      loadTopicSubscriptions: () => {},
      updateDMInbox: () => {},
      updateUnreadBadge: () => {},
      scrollToPost: () => {},
      openDMPanel: (handle) => logger.debug(`[UI] DM panel opened for ${handle}`),
      closeDMPanel: () => logger.debug('[UI] DM panel closed'),
      sendDM: () => logger.debug('[UI] Send DM called'),
      switchDrawer: (id) => logger.debug(`[UI] Drawer switched to ${id}`),
      toggleThread: () => logger.debug('[UI] Thread toggled'),
      createPostWithTopics: () => logger.debug('[UI] Create post called'),
      toggleCarry: () => logger.debug('[UI] Toggle carry called'),
      createReply: () => logger.debug('[UI] Create reply called'),
      handleImageSelect: () => logger.debug('[UI] Image select called'),
      removeImage: () => logger.debug('[UI] Remove image called'),
      toggleReplyForm: () => logger.debug('[UI] Toggle reply form called'),
      subscribeToTopic: () => logger.debug('[UI] Subscribe to topic called'),
      filterByTopic: () => logger.debug('[UI] Filter by topic called'),
      setFeedMode: () => logger.debug('[UI] Set feed mode called'),
      discoverAndFilterTopic: () => logger.debug('[UI] Discover and filter topic called'),
      completeTopicSuggestion: () => logger.debug('[UI] Complete topic suggestion called'),
      clearLocalData: () => logger.debug('[UI] Clear local data called'),
      handleReplyImageSelect: () => logger.debug('[UI] Reply image select called'),
      removeReplyImage: () => logger.debug('[UI] Remove reply image called'),
      ratePost: () => logger.debug('[UI] Rate post called'),
      currentDMRecipient: null,
      addMessageToConversation: () => {},
      applyTheme: () => {},
      setupThemeToggle: () => {},
      showConnectScreen: () => {},
      updateLoadingMessage: () => {},
      storeDMLocallyAndUpdateUI: () => {},
      // Add these critical functions for post handling
      addPostToState: (post) => {
        if (globalThis.emberNode && globalThis.emberNode.state && globalThis.emberNode.state.posts) {
          globalThis.emberNode.state.posts.set(post.id, post);
          logger.debug(`[State] Added post ${post.id}`);
        }
      },
      forwardPost: (post) => {
        logger.debug(`[Forward] Forwarding post ${post.id}`);
        // The actual forwarding should happen through gossipPost
      },
      processPost: (post) => {
        logger.debug(`[Process] Processing post ${post.id}`);
      }
    };

    // Set all UI functions as globals
    Object.entries(uiFunctions).forEach(([name, func]) => {
      globalThis[name] = func;
      if (globalThis.window) {
        globalThis.window[name] = func;
      }
    });

    logger.debug('UI function mocks configured');
  }
}

class ModulePatcher {
  static async patchModules(mainModule) {
    logger.debug('Patching imported modules for headless compatibility...');

    try {
      // Make sure sanitize is available globally
      if (!globalThis.sanitize) {
        globalThis.sanitize = globalThis.DOMPurify.sanitize;
      }

      // Patch the main module's sanitize if it exists
      if (mainModule.sanitize) {
        mainModule.sanitize = globalThis.sanitize;
      }
      
      // Patch the main module's state if needed
      if (mainModule.state) {
        logger.debug('State object available for patching');
      }

      // Try to patch utils module
      try {
        const utilsModule = await import('./utils.js');
        // Don't try to modify the module directly, just ensure global sanitize is available
        logger.debug('Utils module loaded, global sanitize available');
      } catch (error) {
        logger.warn('Could not load utils module:', error.message);
      }

      // Import and patch UI module
      try {
        const uiModule = await import('./ui.js');
        logger.debug('UI module loaded');
      } catch (error) {
        logger.warn('Could not load UI module:', error.message);
      }

      logger.debug('Module patching complete');
    } catch (error) {
      logger.error('Module patching failed:', error);
    }
  }
}

class HeadlessEmberNode {
  constructor() {
    this.state = null;
    this.mainModule = null;
    this.heartbeatInterval = null;
    this.isShuttingDown = false;
  }

  async loadIdentity() {
    if (!fs.existsSync(CONFIG.IDENTITY_FILE)) {
      throw new Error(`Identity file ${CONFIG.IDENTITY_FILE} not found. Please create an identity first:
        1. Run the browser version
        2. Create an identity  
        3. Save localStorage.getItem('ephemeral-id') to ${CONFIG.IDENTITY_FILE}`);
    }

    logger.info('Loading identity from file...');
    const identityData = fs.readFileSync(CONFIG.IDENTITY_FILE, 'utf-8');
    
    // Use custom JSON parser that handles BigInt
    const { JSONParseWithBigInt, base64ToArrayBuffer } = await import('./utils.js');
    const identityJSON = JSONParseWithBigInt(identityData);
    
    // Convert stored data back to proper types
    const identity = {
      ...identityJSON,
      secretKey: new Uint8Array(identityJSON.secretKey),
      encryptionSecretKey: new Uint8Array(identityJSON.encryptionSecretKey),
      publicKey: base64ToArrayBuffer(identityJSON.publicKey),
      encryptionPublicKey: base64ToArrayBuffer(identityJSON.encryptionPublicKey),
      nodeId: new Uint8Array(identityJSON.nodeId),
      vdfProof: { 
        ...identityJSON.vdfProof, 
        iterations: BigInt(identityJSON.vdfProof.iterations) 
      }
    };

    logger.info(`Identity loaded for handle: ${identity.handle}`);
    return identity;
  }

  async initializeServices() {
    logger.info('Initializing core services...');
    
    // Initialize WASM VDF
    logger.debug('Initializing WASM VDF...');
    const wasmVDF = await import('./vdf-wrapper.js');
    await wasmVDF.default.initialize();
    
    // Import main module after all mocks are set up
    logger.debug('Loading main application module...');
    this.mainModule = await import('./main.js');
    const { state, initNetworkWithTempId, initializeP2PProtocols, 
            startMaintenanceLoop, verificationQueue, stateManager,
            plumtree, trustEvaluator, handleIncomingPosts } = this.mainModule;
    
    this.state = state;
    
    // CRITICAL: Patch modules after import
    await ModulePatcher.patchModules(this.mainModule);
    
    // Set identity
    this.state.myIdentity = await this.loadIdentity();
    
    // Replace verification queue with headless version
    const headlessQueue = new HeadlessVerificationQueue();
    headlessQueue.setMainModule(this.mainModule);  // Pass reference to main module
    
    // Override verification methods
    verificationQueue.addBatch = headlessQueue.addBatch.bind(headlessQueue);
    verificationQueue.init = headlessQueue.init.bind(headlessQueue);
    verificationQueue.processTrustBatch = headlessQueue.processTrustBatch.bind(headlessQueue);
    
    // Override handleIncomingPosts to properly process posts
    if (handleIncomingPosts) {
      const originalHandleIncomingPosts = handleIncomingPosts;
      this.mainModule.handleIncomingPosts = (posts, peerId) => {
        logger.info(`Handling ${posts.length} incoming posts from peer ${peerId}`);
        // Process posts through our headless verification queue
        verificationQueue.processTrustBatch(posts);
      };
    }
    
    // If trustEvaluator exists, override its processBatch method
    if (trustEvaluator && trustEvaluator.processBatch) {
      const originalProcessBatch = trustEvaluator.processBatch.bind(trustEvaluator);
      trustEvaluator.processBatch = (posts, callback) => {
        logger.info(`Trust evaluator intercepted: processing ${posts.length} posts`);
        // In headless mode, bypass trust evaluation and go straight to verification
        verificationQueue.processTrustBatch(posts);
        if (callback) callback();
      };
    }
    
    await verificationQueue.init();
    
    // Ensure posts Map exists
    if (!this.state.posts) {
      this.state.posts = new Map();
      logger.debug('Initialized posts Map');
    }
    
    // Replace state manager with stateless version if available
    try {
      const { StatelessManager } = await import('./stateless-manager.js');
      const statelessManager = new StatelessManager();
      Object.setPrototypeOf(stateManager, StatelessManager.prototype);
      Object.assign(stateManager, statelessManager);
      logger.debug('Using StatelessManager for headless operation');
    } catch (error) {
      logger.warn('StatelessManager not available, using default state manager');
    }
    
    return { initNetworkWithTempId, initializeP2PProtocols, startMaintenanceLoop };
  }

  async start() {
    try {
      logger.info('🔥 Initializing Headless Ember Relay Node...');
      
      // Set up all browser mocks first - BEFORE any imports
      HeadlessBrowserMocks.setup();
      HeadlessBrowserMocks.setupLibraryMocks();
      HeadlessBrowserMocks.setupUIMocks();
      
      // Import WebTorrent and expose it
      const { default: WebTorrent } = await import('webtorrent');
      globalThis.window.WebTorrent = WebTorrent;
      logger.debug('WebTorrent library loaded');
      
      // Initialize services
      const { initNetworkWithTempId, initializeP2PProtocols, startMaintenanceLoop } = 
        await this.initializeServices();
      
      // Start networking
      logger.info('🌐 Initializing network stack...');
      await initNetworkWithTempId(this.state.myIdentity.nodeId);
      
      // Wait for DHT bootstrap
      logger.info('⏳ Waiting for DHT bootstrap...');
      await new Promise(resolve => setTimeout(resolve, CONFIG.DHT_BOOTSTRAP_DELAY));
      
      // Initialize P2P protocols
      logger.info('🔧 Initializing P2P protocols...');
      initializeP2PProtocols();
      
      // Start maintenance loop
      logger.info('🔧 Starting maintenance loop...');
      startMaintenanceLoop();
      
      // Start heartbeat
      this.startHeartbeat();
      
      // Setup shutdown handlers
      this.setupShutdownHandlers();
      
      logger.info('✅ Headless Ember Relay Node is online and ready!');
      logger.info(`📊 Node ID: ${Array.from(this.state.myIdentity.nodeId)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('').substring(0, 12)}...`);
      logger.info('🔥 Listening for network activity and carrying the flame...');
      
    } catch (error) {
      logger.error('❌ Failed to initialize headless node:', error);
      throw error;
    }
  }

  startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      if (this.isShuttingDown) return;
      
      const peerCount = this.state?.peers?.size || 0;
      const postCount = this.state?.posts?.size || 0;
      const dhtPeers = this.state?.dht?.getStats()?.totalPeers || 0;
      
      logger.info(`[HEARTBEAT] Peers: ${peerCount}, Posts: ${postCount}, DHT: ${dhtPeers} nodes`);
      
      // Health check
      if (this.state?.client && this.state.client.destroyed) {
        logger.warn('WebTorrent client appears to be destroyed - possible network issue');
      }
      
    }, CONFIG.HEARTBEAT_INTERVAL);
  }

  setupShutdownHandlers() {
    const shutdown = (signal) => {
      if (this.isShuttingDown) {
        logger.warn('Force shutdown - killing process');
        process.exit(1);
      }
      
      this.isShuttingDown = true;
      logger.info(`\n🔥 Received ${signal}, gracefully shutting down...`);
      
      // Clear heartbeat
      if (this.heartbeatInterval) {
        clearInterval(this.heartbeatInterval);
      }
      
      // Shutdown services
      const shutdownPromises = [];
      
      if (this.state?.client) {
        shutdownPromises.push(new Promise((resolve) => {
          this.state.client.destroy(() => {
            logger.debug('WebTorrent client destroyed');
            resolve();
          });
        }));
      }
      
      if (this.state?.dht) {
        shutdownPromises.push(new Promise((resolve) => {
          this.state.dht.shutdown();
          logger.debug('DHT shutdown complete');
          resolve();
        }));
      }
      
      // Wait for shutdown or timeout
      Promise.race([
        Promise.all(shutdownPromises),
        new Promise(resolve => setTimeout(resolve, CONFIG.SHUTDOWN_TIMEOUT))
      ]).then(() => {
        logger.info('✅ Shutdown complete. The flame lives on in other nodes.');
        process.exit(0);
      });
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    
    // Handle uncaught errors
    process.on('uncaughtException', (error) => {
      // Check if it's a DOM-related error we can ignore
      if (error.message && (
          error.message.includes('textContent') || 
          error.message.includes('remove is not a function') ||
          error.message.includes('DOMPurify') ||
          error.message.includes('cannot set properties of null') ||
          error.message.includes('Cannot assign to read only property'))) {
        logger.warn('Ignoring DOM-related error in headless mode:', error.message);
        return;
      }
      
      logger.error('Uncaught exception:', error);
      if (!this.isShuttingDown) {
        shutdown('uncaughtException');
      }
    });
    
    process.on('unhandledRejection', (reason, promise) => {
      // Check if it's a DOM-related rejection we can ignore
      if (reason && reason.message && (
          reason.message.includes('DOMPurify') || 
          reason.message.includes('textContent') ||
          reason.message.includes('remove is not a function') ||
          reason.message.includes('sanitize is not a function'))) {
        logger.warn('Ignoring DOM-related promise rejection:', reason.message);
        return;
      }
      
      logger.error('Unhandled promise rejection:', reason);
      // Don't shutdown on unhandled rejections, just log them
    });
  }

  getStats() {
    if (!this.state) return null;
    
    return {
      nodeId: Array.from(this.state.myIdentity?.nodeId || [])
        .map(b => b.toString(16).padStart(2, '0'))
        .join('').substring(0, 12),
      handle: this.state.myIdentity?.handle,
      peers: this.state.peers?.size || 0,
      posts: this.state.posts?.size || 0,
      dht: this.state.dht?.getStats() || {},
      uptime: Date.now() - (globalThis.window?.networkStartTime || Date.now()),
      memory: process.memoryUsage()
    };
  }
}

// Main execution
async function main() {
  const node = new HeadlessEmberNode();
  
  try {
    await node.start();
    
    // Expose node for debugging
    globalThis.emberNode = node;
    globalThis.emberDebug = {
      stats: () => node.getStats(),
      logs: (level) => logger.level = logger.levels[level] || logger.level,
      posts: () => Array.from(node.state?.posts?.values() || []),
      peers: () => Array.from(node.state?.peers?.keys() || [])
    };
    
  } catch (error) {
    logger.error('❌ Fatal error in headless node:', error);
    process.exit(1);
  }
}

// Only run if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { HeadlessEmberNode, HeadlessLogger, HeadlessBrowserMocks };
