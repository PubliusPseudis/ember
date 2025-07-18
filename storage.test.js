import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';
import { StateManager } from './storage.js';
import { state } from './state.js';
import 'fake-indexeddb/auto';

// Mock the Post class with proper fromJSON validation
jest.unstable_mockModule('../models/post.js', () => ({
  __esModule: true,
  Post: {
    fromJSON: (data) => {
      // Mimic the validation from the real Post.fromJSON
      if (!data || typeof data !== 'object') {
        throw new Error('Invalid post data: must be an object');
      }
      
      const requiredFields = ['id', 'content', 'timestamp', 'author'];
      for (const field of requiredFields) {
        if (!(field in data)) {
          throw new Error(`Invalid post data: missing required field "${field}"`);
        }
      }
      
      // Return a post-like object with all necessary properties
      return {
        ...data,
        carriers: new Set(data.carriers || []),
        replies: new Set(data.replies || []),
        verified: true,
        trustScore: 0,
        attesters: new Set(),
        attestationTimestamps: new Map()
      };
    }
  },
}));

describe('StateManager', () => {
  let stateManager;

  // Before each test, create a fresh mock DB and StateManager instance
  beforeEach(async () => {
    // Clear fake-indexeddb before each test
    const dbs = await indexedDB.databases();
    await Promise.all(dbs.map(db => indexedDB.deleteDatabase(db.name)));

    stateManager = new StateManager({
      imageStore: { chunks: new Map([['chunk1', 'data1']]) },
      peerManager: {
        scores: new Map([['peer1', { reputationScore: 100 }]]),
        getScore: jest.fn(),
      },
      renderPost: jest.fn(),
    });
    await stateManager.init();

    // Reset global state
    state.posts = new Map();
    state.myIdentity = { 
      handle: 'test-user',
      nodeId: new Uint8Array(20),
      secretKey: new Uint8Array(64),
      publicKey: new Uint8Array(32),
      encryptionSecretKey: new Uint8Array(32),
      encryptionPublicKey: new Uint8Array(32)
    };
    state.explicitlyCarrying = new Set();
    global.notify = jest.fn();
  });

  afterEach(() => {
    if (stateManager.db) {
      stateManager.db.close();
    }
    jest.clearAllMocks();
  });

  describe('Initialization and Data Clearing', () => {
  
    test('init should create all required object stores', () => {
      const storeNames = Array.from(stateManager.db.objectStoreNames);
      expect(storeNames).toContain('posts');
      expect(storeNames).toContain('imageChunks');
      expect(storeNames).toContain('userState');
      expect(storeNames).toContain('peerScores');
      expect(storeNames).toContain('dhtRoutingTable');
      expect(storeNames).toContain('dhtStorage');
      expect(storeNames).toContain('pendingMessages');
      expect(storeNames).toContain('messageReceipts');
    });

test('clearLocalData should clear everything when confirmed', async () => {
  // Spy on window.confirm and mock its return value
  const confirmSpy = jest.spyOn(window, 'confirm').mockImplementation(() => true);
  
  const deleteDbSpy = jest.spyOn(indexedDB, 'deleteDatabase');
  const clearStorageSpy = jest.spyOn(localStorage, 'clear');
  
  // Mock console.error to suppress the jsdom navigation error
  const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

  try {
    await stateManager.clearLocalData();
  } catch (error) {
    // Ignore navigation errors from jsdom
    if (!error.message.includes('Not implemented: navigation')) {
      throw error;
    }
  }

  expect(confirmSpy).toHaveBeenCalled();
  expect(deleteDbSpy).toHaveBeenCalledWith('EmberNetwork');
  expect(clearStorageSpy).toHaveBeenCalled();
  
  confirmSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});
  });

  describe('Post Storage', () => {
    test('should save and load posts correctly', async () => {
      const now = Date.now();
      const mockPost = { 
        id: 'p1', 
        author: 'test',
        content: 'Test post content',
        timestamp: now,
        carriers: new Set(['test-user']),
        replies: new Set(),
        verified: true,
        toJSON: () => ({ 
          id: 'p1', 
          author: 'test',
          content: 'Test post content',
          timestamp: now,
          carriers: ['test-user'],
          replies: [],
          depth: 0
        }) 
      };
      state.posts.set('p1', mockPost);
      state.explicitlyCarrying.add('p1');
      
      await stateManager.savePosts();
      state.posts.clear(); // Clear memory
      
      await stateManager.loadPosts();
      expect(state.posts.has('p1')).toBe(true);
      expect(state.explicitlyCarrying.has('p1')).toBe(true);
    }, 10000);

    test('loadPosts should filter out posts older than 24 hours', async () => {
      const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      const mockPost = { 
        id: 'p1', 
        timestamp: oldTimestamp, 
        carriers: new Set(['a']),
        content: 'Old post content',
        author: 'test',
        toJSON: () => ({ 
          id: 'p1', 
          timestamp: oldTimestamp, 
          carriers: ['a'],
          content: 'Old post content',
          author: 'test'
        }) 
      };
      state.posts.set('p1', mockPost);
      
      await stateManager.savePosts();
      state.posts.clear();
    
      await stateManager.loadPosts();
      expect(state.posts.has('p1')).toBe(false);
    });
  });

  describe('Component State Storage', () => {
    test('should save and load image chunks', async () => {
      await stateManager.saveImageChunks();
      stateManager.imageStore.chunks.clear(); // Clear memory
      await stateManager.loadImageChunks();
      expect(stateManager.imageStore.chunks.has('chunk1')).toBe(true);
    });

    test('should save and load user state', async () => {
      await stateManager.saveUserState();
      const savedIdentity = { ...state.myIdentity };
      state.myIdentity = null; // Clear memory
      
      await stateManager.loadUserState();
      expect(state.myIdentity).toBeTruthy();
      expect(state.myIdentity.handle).toBe('test-user');
    });

    test('should save and load peer scores', async () => {
      await stateManager.savePeerScores();
      stateManager.peerManager.scores.clear(); // Clear memory
      await stateManager.loadPeerScores();
      expect(stateManager.peerManager.scores.has('peer1')).toBe(true);
    });

    test('should save and load DHT state', async () => {
      state.dht = {
        serialize: () => ({ buckets: [[{id: 'p1'}]], storage: [['k1', 'v1']] }),
        deserialize: jest.fn(),
      };

      await stateManager.saveDHTState();

      state.dht = { deserialize: jest.fn() };
      await stateManager.loadDHTState();
      expect(state.dht.deserialize).toHaveBeenCalled();
    });
  });

  describe('Pending Messages Logic', () => {
    test('should store and retrieve pending messages by recipient', async () => {
      const messageId = await stateManager.storePendingMessage('alice', 'Hi', 'bob');
      expect(messageId).toBeTruthy();
      const messages = await stateManager.getPendingMessagesFor('alice');
      expect(messages.length).toBe(1);
      expect(messages[0].sender).toBe('bob');
    });

    test('should retrieve pending messages by sender', async () => {
      await stateManager.storePendingMessage('alice', 'Hi', 'bob');
      const messages = await stateManager.getPendingMessagesFrom('bob');
    
      expect(messages.length).toBe(1);
      expect(messages[0].recipient).toBe('alice');
    });

    test('should update message attempt count and fail after 10 attempts', async () => {
      const messageId = await stateManager.storePendingMessage('alice', 'Hi', 'bob');
      for (let i = 0; i < 10; i++) {
        await stateManager.updateMessageAttempt(messageId);
      }
      
      const transaction = stateManager.db.transaction(['pendingMessages'], 'readonly');
      const store = transaction.objectStore('pendingMessages');
      const request = store.get(messageId);
      
      const finalMsg = await new Promise(resolve => request.onsuccess = () => resolve(request.result));

      expect(finalMsg.attempts).toBe(10);
      expect(finalMsg.status).toBe('failed');
    });
  });
});
