const { PassThrough } = require('stream');

class StreamDistributor {
  constructor() {
    this.clients = new Set();
    this.mainStream = new PassThrough();
    this.buffer = [];
    this.maxBufferSize = 1024 * 1024 * 5;
    this.isDestroyed = false;

    this.mainStream.on('data', (chunk) => {
      if (this.isDestroyed) return;

      this.buffer.push(chunk);
      let totalSize = this.buffer.reduce((sum, c) => sum + c.length, 0);
      while (totalSize > this.maxBufferSize && this.buffer.length > 1) {
        totalSize -= this.buffer.shift().length;
      }

      this.clients.forEach(client => {
        if (client.writable) {
          try {
            client.write(chunk);
          } catch (e) {}
        }
      });
    });

    this.mainStream.on('end', () => {
      this.clients.forEach(client => {
        try {
          client.end();
        } catch (e) {}
      });
    });

    this.mainStream.on('error', (err) => {
      console.error('Main stream error:', err);
    });
  }

  getWritableStream() {
    return this.mainStream;
  }

  addClient() {
    if (this.isDestroyed) return null;

    const clientStream = new PassThrough();

    this.buffer.forEach(chunk => {
      try {
        clientStream.write(chunk);
      } catch (e) {}
    });

    this.clients.add(clientStream);

    const cleanup = () => {
      this.clients.delete(clientStream);
    };

    clientStream.on('close', cleanup);
    clientStream.on('error', cleanup);
    clientStream.on('finish', cleanup);

    return clientStream;
  }

  getClientCount() {
    return this.clients.size;
  }

  removeClient(clientStream) {
    if (!this.clients.has(clientStream)) return false;
    this.clients.delete(clientStream);
    try {
      clientStream.end();
    } catch (e) {}
    try {
      clientStream.destroy();
    } catch (e) {}
    return true;
  }

  destroy() {
    this.isDestroyed = true;

    try {
      this.mainStream.destroy();
    } catch (e) {}

    this.clients.forEach(client => {
      try {
        client.destroy();
      } catch (e) {}
    });

    this.clients.clear();
    this.buffer = [];
  }
}

module.exports = StreamDistributor;
