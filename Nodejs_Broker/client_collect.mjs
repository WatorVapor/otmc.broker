const gClients = new Map();
const pendingChallenges = new Map();

class ClientCollector {
  constructor() {
  }
  addClient(clientId, client) {
    gClients.set(clientId, client);
  }

  removeClient(clientId) {
    gClients.delete(clientId);
  }

  getClient(clientId) {
    return gClients.get(clientId);
  }

  getAllClients() {
    return Array.from(gClients.values());
  }

  addChallenge(clientId, challenge) {
    pendingChallenges.set(clientId, challenge);
  }

  getChallenge(clientId) {
    return pendingChallenges.get(clientId);
  }

  removeChallenge(clientId) {
    pendingChallenges.delete(clientId);
  }

  getAllChallenges() {
    return Array.from(pendingChallenges.entries());
  }

  clear() {
    gClients.clear();
    pendingChallenges.clear();
  }

  hasClient(clientId) {
    return gClients.has(clientId);
  }

  hasChallenge(clientId) {
    return pendingChallenges.has(clientId);
  }

  getClientCount() {
    return gClients.size;
  }
}

export { ClientCollector };

