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
    console.log('ClientTopic:getSubscriptions:subscriptions=<', subscriptions, '>');
    if(subscriptions.has(topic)) {
      const targetSubs = subscriptions.get(topic);
      console.log('ClientTopic:getSubscriptions:targetSubs=<', targetSubs, '>');
      return Array.from(targetSubs);
    }
    return this.mathPatternSubscriptions(topic);
  }

  mathPatternSubscriptions(topic) {
    console.log('ClientTopic:mathPatternSubscriptions:topic=<', topic, '>');
    const result = [];
    for(const [subscribedTopic, clients] of subscriptions.entries()) {
      console.log('ClientTopic:mathPatternSubscriptions:subscribedTopic=<', subscribedTopic, '>');
      const levels = topic.split('/');
      const subLevels = subscribedTopic.split('/');
      let match = true;
      for(let i = 0; i < subLevels.length; i++) {
        if(subLevels[i] === '#') {
          break;
        }
        if(subLevels[i] === '+') {
          continue;
        }
        if(levels[i] !== subLevels[i]) {
          match = false;
          break;
        }
      }
      if(match) {
        result.push(...clients);
      }
    }
    console.log('ClientTopic:mathPatternSubscriptions:result=<', result, '>');
    return result;
  }

}

export { ClientTopic };
