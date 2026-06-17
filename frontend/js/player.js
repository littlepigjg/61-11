class RadioPlayer {
  constructor() {
    this.currentChannel = null;
    this.ws = null;
    this.audio = document.getElementById('audioPlayer');
    this.playBtn = document.getElementById('playBtn');
    this.volumeSlider = document.getElementById('volumeSlider');
    this.channelList = document.getElementById('channelList');
    this.currentChannelName = document.getElementById('currentChannelName');
    this.currentTrack = document.getElementById('currentTrack');
    this.listenerCount = document.getElementById('listenerCount');
    this.ffmpegAvailable = true;
    this.serverVolume = 1.0;
    this.localVolume = 0.8;
    this._heartbeatTimer = null;
    this._pageHidden = false;
    this._isPlaying = false;

    this.audio.volume = this.localVolume;

    this.init();
  }

  async init() {
    await this.loadSystemConfig();
    this.notifyLeave();
    await this.loadChannels();
    this.bindEvents();
  }

  async loadSystemConfig() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/config`);
      const config = await response.json();
      this.ffmpegAvailable = config.ffmpegAvailable;
    } catch (err) {
      this.ffmpegAvailable = false;
    }
  }

  async loadChannels() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels`);
      const channels = await response.json();
      this.renderChannels(channels);
    } catch (err) {
      console.error('Failed to load channels:', err);
      this.channelList.innerHTML = '<p style="color:#888">无法加载频道列表</p>';
    }
  }

  renderChannels(channels) {
    this.channelList.innerHTML = channels.map(ch => `
      <div class="channel-item ${this.currentChannel === ch.id ? 'active' : ''}" data-id="${ch.id}">
        <h3><span class="channel-status ${ch.isPlaying ? 'playing' : ''}"></span>${ch.name}</h3>
        <p>${ch.description}</p>
        <div class="channel-meta">
          <span>👥 ${ch.listeners} 人在线</span>
          <span>${ch.isPlaying ? '播放中' : '已停止'}</span>
        </div>
      </div>
    `).join('');

    this.channelList.querySelectorAll('.channel-item').forEach(item => {
      item.addEventListener('click', () => {
        const channelId = item.dataset.id;
        this.selectChannel(channelId);
      });
    });
  }

  async selectChannel(channelId) {
    if (this.currentChannel === channelId) return;

    this._disconnectAudioStream();
    this.notifyLeave();

    if (this.ws) {
      try { this.ws.close(); } catch (e) {}
      this.ws = null;
    }

    this.currentChannel = channelId;
    this.connectWebSocket(channelId);
    this.updatePlayerUI(channelId);
    this.loadChannels();
  }

  connectWebSocket(channelId) {
    this.ws = new WebSocket(CONFIG.WS_URL);

    this.ws.onopen = () => {
      this.ws.send(JSON.stringify({
        action: 'join',
        channelId: channelId
      }));
    };

    this.ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      this.handleWebSocketMessage(data);
    };

    this.ws.onclose = () => {
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  handleWebSocketMessage(data) {
    switch (data.type) {
      case 'status':
        this.ffmpegAvailable = data.ffmpegAvailable !== undefined ? data.ffmpegAvailable : this.ffmpegAvailable;
        this.serverVolume = data.volume || 1.0;
        this._applyCombinedVolume();
        this.updateStatus(data);
        break;
      case 'trackChange':
        this.updateTrack(data.track);
        this.updatePlayingState(data.isPlaying);
        break;
      case 'statusChange':
        this.updatePlayingState(data.isPlaying);
        break;
      case 'listenersChange':
        this.updateListeners(data.listeners);
        this.loadChannels();
        break;
      case 'volumeChange':
        this.serverVolume = data.volume;
        this._applyCombinedVolume();
        break;
    }
  }

  _applyCombinedVolume() {
    if (this.ffmpegAvailable) {
      this.audio.volume = this.localVolume;
    } else {
      this.audio.volume = Math.max(0, Math.min(1, this.localVolume * this.serverVolume));
    }
  }

  updateStatus(data) {
    this.currentChannelName.textContent = data.name;
    if (data.currentTrack) {
      this.currentTrack.textContent = data.currentTrack.title;
    } else {
      this.currentTrack.textContent = '--';
    }
    this.listenerCount.textContent = data.listeners;
    this.updatePlayingState(data.isPlaying);
    this.playBtn.disabled = !data.currentTrack;
  }

  updateTrack(track) {
    if (track) {
      this.currentTrack.textContent = track.title;
    }
  }

  updatePlayingState(isPlaying) {
    this._isPlaying = isPlaying;
    const playIcon = this.playBtn.querySelector('.play-icon');
    if (isPlaying) {
      playIcon.textContent = '⏸';
    } else {
      playIcon.textContent = '▶';
    }
  }

  updateListeners(count) {
    this.listenerCount.textContent = count;
  }

  updatePlayerUI(channelId) {
    document.querySelectorAll('.channel-item').forEach(item => {
      item.classList.toggle('active', item.dataset.id === channelId);
    });
  }

  _connectAudioStream() {
    if (!this.currentChannel) return;
    const streamUrl = `${CONFIG.API_BASE}/stream/${this.currentChannel}`;
    this.audio.src = streamUrl;
    this.playBtn.disabled = false;
  }

  _disconnectAudioStream() {
    try {
      this.audio.pause();
    } catch (e) {}
    try {
      this.audio.removeAttribute('src');
      this.audio.src = '';
      this.audio.load();
    } catch (e) {}
    this._stopHeartbeat();
  }

  notifyLeave() {
    try {
      const payload = JSON.stringify({
        channelId: this.currentChannel
      });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(
          `${CONFIG.API_BASE}/api/listeners/leave`,
          new Blob([payload], { type: 'application/json' })
        );
      } else {
        fetch(`${CONFIG.API_BASE}/api/listeners/leave`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          keepalive: true,
          body: payload
        }).catch(() => {});
      }
    } catch (e) {
    }
  }

  _startHeartbeat() {
    if (this._heartbeatTimer) return;
    this._heartbeatTimer = setInterval(() => {
      if (this._pageHidden || !this.currentChannel || this.audio.paused) return;
      try {
        fetch(`${CONFIG.API_BASE}/api/listeners/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            channelId: this.currentChannel
          })
        }).catch(() => {});
      } catch (e) {
      }
    }, 5000);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  bindEvents() {
    this.playBtn.addEventListener('click', () => {
      if (this.audio.paused || this.audio.src === '') {
        if (!this.audio.src) {
          this._connectAudioStream();
        }
        this.audio.play().then(() => {
        }).catch(err => {
          console.error('Play failed:', err);
        });
      } else {
        this.audio.pause();
        this._disconnectAudioStream();
        this.notifyLeave();
      }
    });

    this.audio.addEventListener('play', () => {
      this.updatePlayingState(true);
      this._startHeartbeat();
    });

    this.audio.addEventListener('pause', () => {
      this.updatePlayingState(false);
    });

    this.volumeSlider.addEventListener('input', (e) => {
      this.localVolume = e.target.value / 100;
      this._applyCombinedVolume();
    });

    this.audio.addEventListener('error', (e) => {
      console.error('Audio error:', e);
    });

    this.audio.addEventListener('waiting', () => {
    });

    this.audio.addEventListener('stalled', () => {
    });

    window.addEventListener('beforeunload', () => {
      this._disconnectAudioStream();
      this.notifyLeave();
    });

    window.addEventListener('pagehide', () => {
      this._disconnectAudioStream();
      this.notifyLeave();
    });

    window.addEventListener('unload', () => {
      this._disconnectAudioStream();
      this.notifyLeave();
    });

    document.addEventListener('visibilitychange', () => {
      this._pageHidden = document.hidden;
      if (this._pageHidden) {
        this._stopHeartbeat();
      } else if (!this.audio.paused && this.currentChannel) {
        this._startHeartbeat();
      }
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new RadioPlayer();
});
