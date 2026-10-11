const subscriptions = new Map();

class ClientTopic {
  constructor(socket) {
    this.socket = socket;
  }

  addSubscription(topic) {
    subscriptions.add(topic);
  }
  removeSubscription(topic) {
    subscriptions.delete(topic);
  }

  getSubscriptions() {
    return Array.from(subscriptions);
  }

  hasSubscription(topic) {
    return subscriptions.has(topic);
  }  
}

export { ClientTopic };
