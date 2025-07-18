import { jest, describe, beforeEach, afterEach, test, expect } from '@jest/globals';

// 1. Mock all dependencies before they are imported
jest.unstable_mockModule('../vdf-wrapper.js', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn().mockResolvedValue(),
    computeVDFProofWithTimeout: jest.fn().mockResolvedValue({ y: 'mock-y', pi: 'mock-pi', l: 'mock-l', r: 'mock-r', iterations: 1000n }),
  },
}));
jest.unstable_mockModule('../ui.js', () => ({
  __esModule: true,
  notify: jest.fn(),
}));
jest.unstable_mockModule('../services/callbacks.js', () => ({
  __esModule: true,
  serviceCallbacks: {
    broadcastProfileUpdate: jest.fn(),
    initializeUserProfileSection: jest.fn(),
  },
}));

// 2. Dynamically import the modules for the test
const { createNewIdentity } = await import('../identity/identity-flow.js');
const { state } = await import('../state.js');
const wasmVDF = (await import('../vdf-wrapper.js')).default;
const { notify } = await import('../ui.js');

// 3. Begin the test suite
describe('Identity Flow', () => {
  let overlay;

  // Set a generous timeout.
  jest.setTimeout(10000); // 10 seconds is plenty without fake timers.

  // Setup DOM and mocks before each test
  beforeEach(() => {
    // NOTE: We are NO LONGER using fake timers.
    document.body.innerHTML = `
      <div id="identity-creation-overlay" style="display: none;">
        <div id="identity-step-0-disclaimer" style="display: block;">
          <button id="acknowledge-button">Acknowledge</button>
        </div>
        <div id="identity-step-2-pow" style="display: none;"></div>
        <div id="identity-step-3-prompt" style="display: none;"></div>
      </div>
    `;
    overlay = document.getElementById('identity-creation-overlay');
    global.state = state;
    state.peers = new Map([['peer1', {}]]);
    state.identityRegistry = {
      lookupHandle: jest.fn().mockResolvedValue(null),
      registerIdentity: jest.fn().mockResolvedValue({}),
    };
   state.dht = { nodeId: null, bootstrap: jest.fn().mockResolvedValue() };
    localStorage.clear();
  });

  // Cleanup after each test
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Step 1: Disclaimer', () => {
    test('should show the disclaimer overlay on start', () => {
      createNewIdentity();
      expect(overlay.style.display).toBe('flex');
      expect(document.getElementById('identity-step-0-disclaimer').style.display).toBe('block');
    });

    test('should proceed to handle selection after acknowledgement', async () => {
      const identityPromise = createNewIdentity();
      document.getElementById('acknowledge-button').click();
      // Let the event handler run
      await new Promise(process.nextTick);
      expect(document.getElementById('identity-step-0-disclaimer').style.display).toBe('none');
      expect(document.getElementById('identity-step-3-prompt').style.display).toBe('block');
      // We don't await the main promise here as it hasn't resolved yet.
    });
  });

  describe('Step 2: Handle Selection', () => {
    beforeEach(async () => {
      createNewIdentity();
      document.getElementById('acknowledge-button').click();
      await new Promise(process.nextTick);
    });

    test('should show error for handles that are too short', async () => {
      const input = document.getElementById('identity-handle-input');
      input.value = 'ab';
      input.dispatchEvent(new Event('input'));
      // Wait for the debounced check
      await new Promise(resolve => setTimeout(resolve, 600));
      const availabilityDiv = document.getElementById('handle-availability');
      expect(availabilityDiv.textContent).toContain('must be at least 3 characters');
      expect(document.getElementById('identity-confirm-button').disabled).toBe(true);
    });

    test('should show error for handles with invalid characters', async () => {
      const input = document.getElementById('identity-handle-input');
      input.value = 'test@user';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 600));
      const availabilityDiv = document.getElementById('handle-availability');
      expect(availabilityDiv.textContent).toContain('Only letters, numbers, and underscores');
      expect(document.getElementById('identity-confirm-button').disabled).toBe(true);
    });

    test('should show error and disable button for a taken handle', async () => {
      state.identityRegistry.lookupHandle.mockResolvedValue({ handle: 'taken_user' });
      const input = document.getElementById('identity-handle-input');
      input.value = 'taken_user';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 600));
      const availabilityDiv = document.getElementById('handle-availability');
      expect(availabilityDiv.textContent).toContain('Handle already taken');
      expect(document.getElementById('identity-confirm-button').disabled).toBe(true);
    });

    test('should enable button for an available handle', async () => {
      const input = document.getElementById('identity-handle-input');
      input.value = 'available_user';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 600));
      const availabilityDiv = document.getElementById('handle-availability');
      expect(availabilityDiv.textContent).toContain('✓ Handle available!');
      expect(document.getElementById('identity-confirm-button').disabled).toBe(false);
    });
  });

  describe('Step 3: Registration', () => {
    test('should compute VDF and register identity successfully', async () => {
      const identityPromise = createNewIdentity();

      // Simulate user flow
      document.getElementById('acknowledge-button').click();
      await new Promise(process.nextTick);
      const input = document.getElementById('identity-handle-input');
      input.value = 'final_user';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 600));
      document.getElementById('identity-confirm-button').click();
      
      await identityPromise; // Await the main promise to resolve
      
      expect(wasmVDF.computeVDFProofWithTimeout).toHaveBeenCalled();
      expect(state.identityRegistry.registerIdentity).toHaveBeenCalled();
      expect(localStorage.setItem).toHaveBeenCalledWith('ephemeral-id', expect.any(String));
      expect(overlay.style.display).toBe('none');
    });

    test('should show handle selection again if registration fails on the backend', async () => {
      state.identityRegistry.registerIdentity.mockRejectedValue(new Error('Handle was just taken!'));
      
      const identityPromise = createNewIdentity();

      // Simulate user flow
      document.getElementById('acknowledge-button').click();
      await new Promise(process.nextTick);
      const input = document.getElementById('identity-handle-input');
      input.value = 'final_user';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 600));
      document.getElementById('identity-confirm-button').click();
      
      await expect(identityPromise).rejects.toThrow('Handle was just taken!');
      
      // Allow DOM updates to happen after rejection
      await new Promise(process.nextTick);
      
      expect(document.getElementById('identity-step-2-pow').style.display).toBe('none');
      expect(document.getElementById('identity-step-3-prompt').style.display).toBe('block');
      expect(notify).toHaveBeenCalledWith('Handle was just taken!');
    });

    test('should show an error message if VDF computation fails', async () => {
      wasmVDF.computeVDFProofWithTimeout.mockRejectedValue(new Error('VDF engine crashed'));
      
      const identityPromise = createNewIdentity();
      
      // Simulate user flow
      document.getElementById('acknowledge-button').click();
      await new Promise(process.nextTick);
      const input = document.getElementById('identity-handle-input');
      input.value = 'final_user';
      input.dispatchEvent(new Event('input'));
      await new Promise(resolve => setTimeout(resolve, 600));
      document.getElementById('identity-confirm-button').click();
      
      await expect(identityPromise).rejects.toThrow('VDF engine crashed');

      // Allow DOM updates to happen after rejection
      await new Promise(process.nextTick);

      const powDiv = document.getElementById('identity-step-2-pow');
      expect(powDiv.textContent).toContain('Registration Failed');
      expect(powDiv.textContent).toContain('VDF engine crashed');
    });
  });
});
