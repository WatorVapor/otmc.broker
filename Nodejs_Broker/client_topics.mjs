const subscriptions = new Map();

class ClientTopic {
  constructor() {
  }

  addSubscription(topic,clientId) {
    console.log('ClientTopic:addSubscription:topic=<', topic, '>');
    console.log('ClientTopic:addSubscription:clientId=<', clientId, '>');
    if(subscriptions.has(topic)) {
      subscriptions.get(topic).add(clientId);
      return;
    } else {
      subscriptions.set(topic, new Set([clientId]));
    }
  }
  removeSubscription(topic,clientId) {
    console.log('ClientTopic:removeSubscription:topic=<', topic, '>');
    console.log('ClientTopic:removeSubscription:clientId=<', clientId, '>');
    subscriptions.delete(topic);
  }

  getSubscriptions(topic) {
    console.log('ClientTopic:getSubscriptions:topic=<', topic, '>');
    if(subscriptions.has(topic)) {
      const targetSubs = subscriptions.get(topic);
      console.log('ClientTopic:getSubscriptions:targetSubs=<', targetSubs, '>');
      return Array.from(targetSubs);
    }
    return [];
  }

}

export { ClientTopic };
