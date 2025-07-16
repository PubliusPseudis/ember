// services/callbacks.js
export const serviceCallbacks = {
  debugPostRemoval: null,
  dropPost: null,
  notify: null,
  renderPost: null,
  broadcastProfileUpdate: null,
  initializeUserProfileSection: null
};

export function setServiceCallbacks(callbacks) {
  Object.assign(serviceCallbacks, callbacks);
}
