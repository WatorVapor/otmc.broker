import { ClientAcl } from './client_acl.mjs';


class ClientTopic {
  constructor(socket) {
    this.socket = socket;
    this.subscriptions = new Set();
  }

  addSubscription(topic) {
    this.subscriptions.add(topic);
  }
  removeSubscription(topic) {
    this.subscriptions.delete(topic);
  }

  hasSubscription(topic) {
    return this.subscriptions.has(topic);
  }  
}

export { ClientTopic };
