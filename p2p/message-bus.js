// p2p/message-bus.js
class MessageBus {
  constructor() {
    this.handlers = new Map();
    this.sendPeerFn = null;
  }
  
  // Register the sendPeer function
  setSendPeer(fn) {
    this.sendPeerFn = fn;
  }
  
  // Wrapper for sendPeer
  sendPeer(wire, msg) {
    if (!this.sendPeerFn) {
      throw new Error('sendPeer not initialized');
    }
    return this.sendPeerFn(wire, msg);
  }
  
  // Register message handlers
  registerHandler(type, handler) {
    this.handlers.set(type, handler);
  }
  
  // Handle incoming messages
  async handleMessage(type, data, fromWire) {
    const handler = this.handlers.get(type);
    if (handler) {
      return await handler(data, fromWire);
    }
  }
}

export const messageBus = new MessageBus();
