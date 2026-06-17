const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/channels/pop/play',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

console.log('Starting playback test...');

const req = http.request(options, (res) => {
  console.log(`Play API status: ${res.statusCode}`);

  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    console.log('Play response:', data);
    console.log('\nNow testing stream...');

    const streamOptions = {
      hostname: 'localhost',
      port: 3000,
      path: '/stream/pop',
      method: 'GET'
    };

    const streamReq = http.request(streamOptions, (streamRes) => {
      console.log(`Stream status: ${streamRes.statusCode}`);
      console.log('Content-Type:', streamRes.headers['content-type']);

      let totalBytes = 0;
      let chunkCount = 0;

      streamRes.on('data', (chunk) => {
        totalBytes += chunk.length;
        chunkCount++;
        if (chunkCount <= 3) {
          console.log(`  Chunk ${chunkCount}: ${chunk.length} bytes`);
        }
      });

      streamRes.on('end', () => {
        console.log(`\nStream ended. Total: ${totalBytes} bytes in ${chunkCount} chunks`);
      });

      streamRes.on('error', (err) => {
        console.error('Stream error:', err.message);
      });

      setTimeout(() => {
        console.log(`\nAfter 3 seconds: ${totalBytes} bytes received`);
        streamReq.destroy();
        process.exit(0);
      }, 3000);
    });

    streamReq.on('error', (err) => {
      console.error('Stream request error:', err.message);
    });

    streamReq.end();
  });
});

req.on('error', (error) => {
  console.error('Request error:', error.message);
});

req.write(JSON.stringify({}));
req.end();

setTimeout(() => {
  console.log('Timeout - checking server status...');
}, 10000);
