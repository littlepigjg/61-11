const EventEmitter = require('events');
const crypto = require('crypto');

const DEFAULT_TIMEOUT_MS = 6000;
const DEFAULT_CHECK_INTERVAL_MS = 2000;

class ListenerManager extends EventEmitter {
  constructor(options = {}) {
    super();
    this.channelListeners = new Map();
    this.userConnections = new Map();
    this.timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.checkIntervalMs = options.checkIntervalMs || DEFAULT_CHECK_INTERVAL_MS;
    this._checkTimer = null;
    this._startStaleCheck();
  }

  generateId() {
    return crypto.randomUUID();
  }

  addListener(channelId, userId = null, replaceUser = false) {
    if (!this.channelListeners.has(channelId)) {
      this.channelListeners.set(channelId, new Map());
    }
    const listeners = this.channelListeners.get(channelId);

    if (replaceUser && userId) {
      const toRemove = [];
      for (const [connId, info] of listeners.entries()) {
        if (info.userId === userId) {
          toRemove.push(connId);
        }
      }
      for (const connId of toRemove) {
        listeners.delete(connId);
        const userSet = this.userConnections.get(userId);
        if (userSet) {
          userSet.delete(connId);
          if (userSet.size === 0) {
            this.userConnections.delete(userId);
          }
        }
      }
    }

    const connectionId = this.generateId();

    listeners.set(connectionId, {
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      userId: userId
    });

    if (userId) {
      if (!this.userConnections.has(userId)) {
        this.userConnections.set(userId, new Set());
      }
      this.userConnections.get(userId).add(connectionId);
    }

    this.emit('listenersChange', channelId, this.getListenerCount(channelId));
    return connectionId;
  }

  touch(connectionId, channelId = null) {
    if (channelId) {
      const listeners = this.channelListeners.get(channelId);
      if (listeners && listeners.has(connectionId)) {
        listeners.get(connectionId).lastActiveAt = Date.now();
        return true;
      }
      return false;
    }

    for (const listeners of this.channelListeners.values()) {
      if (listeners.has(connectionId)) {
        listeners.get(connectionId).lastActiveAt = Date.now();
        return true;
      }
    }
    return false;
  }

  removeListener(channelId, connectionId) {
    const listeners = this.channelListeners.get(channelId);
    if (!listeners) return 0;

    const info = listeners.get(connectionId);
    if (info && info.userId) {
      const userSet = this.userConnections.get(info.userId);
      if (userSet) {
        userSet.delete(connectionId);
        if (userSet.size === 0) {
          this.userConnections.delete(info.userId);
        }
      }
    }

    if (listeners.has(connectionId)) {
      listeners.delete(connectionId);
      if (listeners.size === 0) {
        this.channelListeners.delete(channelId);
      }
      this.emit('listenersChange', channelId, this.getListenerCount(channelId));
    }

    return this.getListenerCount(channelId);
  }

  removeAllForUser(userId) {
    const affectedChannels = new Set();
    for (const [channelId, listeners] of this.channelListeners.entries()) {
      for (const [connectionId, info] of listeners.entries()) {
        if (info.userId === userId) {
          listeners.delete(connectionId);
          affectedChannels.add(channelId);
        }
      }
      if (listeners.size === 0) {
        this.channelListeners.delete(channelId);
      }
    }
    this.userConnections.delete(userId);
    for (const ch of affectedChannels) {
      this.emit('listenersChange', ch, this.getListenerCount(ch));
    }
    return affectedChannels;
  }

  removeStaleConnections() {
    const now = Date.now();
    const removed = [];
    for (const [channelId, listeners] of this.channelListeners.entries()) {
      for (const [connectionId, info] of listeners.entries()) {
        if (now - info.lastActiveAt > this.timeoutMs) {
          listeners.delete(connectionId);
          removed.push({ channelId, connectionId });
          if (info.userId) {
            const userSet = this.userConnections.get(info.userId);
            if (userSet) {
              userSet.delete(connectionId);
              if (userSet.size === 0) {
                this.userConnections.delete(info.userId);
              }
            }
          }
        }
      }
      if (listeners.size === 0) {
        this.channelListeners.delete(channelId);
      }
    }
    for (const { channelId } of removed) {
      this.emit('listenersChange', channelId, this.getListenerCount(channelId));
    }
    return removed;
  }

  getListenerCount(channelId) {
    const listeners = this.channelListeners.get(channelId);
    return listeners ? listeners.size : 0;
  }

  getUniqueUserCount(channelId) {
    const listeners = this.channelListeners.get(channelId);
    if (!listeners) return 0;
    const userIds = new Set();
    for (const info of listeners.values()) {
      if (info.userId) {
        userIds.add(info.userId);
      }
    }
    return userIds.size;
  }

  getAllCounts() {
    const result = {};
    for (const [channelId] of this.channelListeners.entries()) {
      result[channelId] = this.getListenerCount(channelId);
    }
    return result;
  }

  hasListeners(channelId) {
    return this.getListenerCount(channelId) > 0;
  }

  getConnectionInfo(connectionId, channelId = null) {
    if (channelId) {
      const listeners = this.channelListeners.get(channelId);
      return listeners ? listeners.get(connectionId) || null : null;
    }
    for (const listeners of this.channelListeners.values()) {
      if (listeners.has(connectionId)) {
        return listeners.get(connectionId);
      }
    }
    return null;
  }

  clearChannel(channelId) {
    const listeners = this.channelListeners.get(channelId);
    if (listeners) {
      for (const info of listeners.values()) {
        if (info.userId) {
          const userSet = this.userConnections.get(info.userId);
          if (userSet) {
            userSet.delete(channelId);
            if (userSet.size === 0) {
              this.userConnections.delete(info.userId);
            }
          }
        }
      }
      this.channelListeners.delete(channelId);
      this.emit('listenersChange', channelId, 0);
    }
  }

  _startStaleCheck() {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(() => {
      try {
        this.removeStaleConnections();
      } catch (e) {
      }
    }, this.checkIntervalMs);
    if (this._checkTimer.unref) {
      this._checkTimer.unref();
    }
  }

  _stopStaleCheck() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  shutdown() {
    this._stopStaleCheck();
    for (const channelId of Array.from(this.channelListeners.keys())) {
      this.emit('listenersChange', channelId, 0);
    }
    this.channelListeners.clear();
    this.userConnections.clear();
  }
}

module.exports = ListenerManager;
