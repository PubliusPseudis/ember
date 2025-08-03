// FILE: state.js
import { HierarchicalBloomFilter } from './utils.js';

// This file ONLY defines and exports the shared state object.
export const state = {
  posts: new Map(),
  peers: new Map(),
  peerIdentities: new Map(),
  myIdentity: null,
  client: null,
  provisionalIdentities: new Map(),
  explicitlyCarrying: new Set(),
  viewing: new Set(),
  toxicityClassifier: null,
  imageClassifier: null,
  seenMessages: new HierarchicalBloomFilter(),
  seenPosts: new HierarchicalBloomFilter(),
  dht: null,
  hyparview: null,
  scribe: null,
  identityRegistry: null,
  subscribedTopics: new Set([]),
  topicFilter: '',
  feedMode: 'all',
  pendingVerification: new Map(),
  viewingProfile: null,
  profileCache: new Map(),
  dmPermissions: new Map(), // NEW: Map<handle, {status: 'approved'|'pending_outgoing'|'pending_incoming'|'blocked', timestamp: number}>
};
