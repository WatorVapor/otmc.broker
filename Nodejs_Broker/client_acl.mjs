
const Acl = new Map();

class ClientAcl {
  constructor() {
  }
  addAcl(clientId, acl) {
    Acl.set(clientId, acl);
  }

  removeAcl(clientId) {
    Acl.delete(clientId);
  }

  getAcl(clientId) {
    return Acl.get(clientId);
  }

  getAllAcls() {
    return Array.from(Acl.values());
  }

  clear() {
    Acl.clear();
  }
}

export { ClientAcl };

