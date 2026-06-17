class DJPanel {
  constructor() {
    this.currentChannel = null;
    this.ws = null;
    this.playlist = [];
    this.currentIndex = -1;
    this.isPlaying = false;
    this.fadeConfig = null;

    this.channelList = document.getElementById('channelList');
    this.djChannelName = document.getElementById('djChannelName');
    this.statusBadge = document.getElementById('statusBadge');
    this.nowPlaying = document.getElementById('nowPlaying');
    this.playPauseBtn = document.getElementById('playPauseBtn');
    this.prevBtn = document.getElementById('prevBtn');
    this.nextBtn = document.getElementById('nextBtn');
    this.channelVolume = document.getElementById('channelVolume');
    this.djListenerCount = document.getElementById('djListenerCount');
    this.playlistCount = document.getElementById('playlistCount');
    this.playlistEl = document.getElementById('playlist');

    this.fadeEnabled = document.getElementById('fadeEnabled');
    this.fadeType = document.getElementById('fadeType');
    this.fadeInDuration = document.getElementById('fadeInDuration');
    this.fadeOutDuration = document.getElementById('fadeOutDuration');
    this.preFadeOutStart = document.getElementById('preFadeOutStart');
    this.crossfadeDuration = document.getElementById('crossfadeDuration');
    this.fadeInValue = document.getElementById('fadeInValue');
    this.fadeOutValue = document.getElementById('fadeOutValue');
    this.preFadeOutValue = document.getElementById('preFadeOutValue');
    this.crossfadeValue = document.getElementById('crossfadeValue');
    this.applyFadeBtn = document.getElementById('applyFadeBtn');
    this.fadeStatusValue = document.getElementById('fadeStatusValue');

    this.init();
  }

  async init() {
    await this.loadChannels();
    this.bindEvents();
  }

  async loadChannels() {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels`);
      const channels = await response.json();
      this.renderChannels(channels);
    } catch (err) {
      console.error('Failed to load channels:', err);
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

  selectChannel(channelId) {
    if (this.currentChannel === channelId) return;

    if (this.ws) {
      this.ws.close();
    }

    this.currentChannel = channelId;
    this.connectWebSocket(channelId);
    this.loadPlaylist(channelId);
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
        this.handleStatus(data);
        break;
      case 'trackChange':
        this.handleTrackChange(data);
        break;
      case 'statusChange':
        this.handleStatusChange(data);
        break;
      case 'listenersChange':
        this.handleListenersChange(data);
        break;
      case 'volumeChange':
        this.handleVolumeChange(data);
        break;
      case 'fadeConfigChange':
        this.handleFadeConfigChange(data);
        break;
      case 'fadeStateChange':
        this.handleFadeStateChange(data);
        break;
    }
  }

  handleStatus(data) {
    this.djChannelName.textContent = data.name;
    this.isPlaying = data.isPlaying;
    this.currentIndex = data.currentIndex || -1;

    if (data.currentTrack) {
      this.nowPlaying.textContent = data.currentTrack.title;
    } else {
      this.nowPlaying.textContent = '--';
    }

    this.djListenerCount.textContent = data.listeners;

    if (data.playlist) {
      this.playlist = data.playlist;
      this.playlistCount.textContent = data.playlist.length;
      this.renderPlaylist();
    }

    this.updatePlayPauseButton();
    this.updateStatusBadge();
    this.channelVolume.value = Math.round((data.volume || 1) * 100);

    if (data.fade) {
      this.fadeConfig = data.fade;
      this.updateFadeUI(data.fade);
    }
  }

  handleTrackChange(data) {
    if (data.track) {
      this.nowPlaying.textContent = data.track.title;
      const idx = this.playlist.findIndex(t => t.filename === data.track.filename);
      if (idx >= 0) {
        this.currentIndex = idx;
      }
    }
    this.isPlaying = data.isPlaying;
    this.updatePlayPauseButton();
    this.updateStatusBadge();
    this.renderPlaylist();
  }

  handleStatusChange(data) {
    this.isPlaying = data.isPlaying;
    this.updatePlayPauseButton();
    this.updateStatusBadge();
  }

  handleListenersChange(data) {
    this.djListenerCount.textContent = data.listeners;
    this.loadChannels();
  }

  handleVolumeChange(data) {
    this.channelVolume.value = Math.round(data.volume * 100);
  }

  handleFadeConfigChange(data) {
    if (data.fade) {
      this.fadeConfig = data.fade;
      this.updateFadeUI(data.fade);
    }
  }

  handleFadeStateChange(data) {
    if (data.fadeState) {
      const { type, duration } = data.fadeState;
      this.fadeStatusValue.classList.remove('fading-in', 'fading-out');
      
      if (type === 'fadeIn') {
        this.fadeStatusValue.textContent = `淡入中 (${duration}s)`;
        this.fadeStatusValue.classList.add('fading-in');
      } else if (type === 'fadeOut') {
        this.fadeStatusValue.textContent = `淡出中 (${duration}s)`;
        this.fadeStatusValue.classList.add('fading-out');
      }

      setTimeout(() => {
        this.fadeStatusValue.classList.remove('fading-in', 'fading-out');
        this.fadeStatusValue.textContent = '播放中';
      }, duration * 1000);
    }
  }

  updateFadeUI(fadeConfig) {
    this.fadeEnabled.checked = fadeConfig.enabled;
    this.fadeType.value = fadeConfig.fadeType;
    this.fadeInDuration.value = fadeConfig.fadeInDuration;
    this.fadeOutDuration.value = fadeConfig.fadeOutDuration;
    this.preFadeOutStart.value = fadeConfig.preFadeOutStart;
    this.crossfadeDuration.value = fadeConfig.crossfadeDuration;
    
    this.fadeInValue.textContent = fadeConfig.fadeInDuration.toFixed(1);
    this.fadeOutValue.textContent = fadeConfig.fadeOutDuration.toFixed(1);
    this.preFadeOutValue.textContent = fadeConfig.preFadeOutStart.toFixed(1);
    this.crossfadeValue.textContent = fadeConfig.crossfadeDuration.toFixed(1);
  }

  collectFadeConfig() {
    return {
      enabled: this.fadeEnabled.checked,
      fadeType: this.fadeType.value,
      fadeInDuration: parseFloat(this.fadeInDuration.value),
      fadeOutDuration: parseFloat(this.fadeOutDuration.value),
      preFadeOutStart: parseFloat(this.preFadeOutStart.value),
      crossfadeDuration: parseFloat(this.crossfadeDuration.value)
    };
  }

  applyFadeConfig() {
    if (!this.currentChannel) return;
    
    const config = this.collectFadeConfig();
    this.sendControl('setFade', config);
    
    this.applyFadeBtn.textContent = '已应用 ✓';
    setTimeout(() => {
      this.applyFadeBtn.textContent = '应用设置';
    }, 1500);
  }

  updatePlayPauseButton() {
    if (this.isPlaying) {
      this.playPauseBtn.textContent = '⏸';
    } else {
      this.playPauseBtn.textContent = '▶';
    }
  }

  updateStatusBadge() {
    this.statusBadge.classList.remove('playing', 'paused', 'stopped');
    if (this.isPlaying) {
      this.statusBadge.textContent = '播放中';
      this.statusBadge.classList.add('playing');
    } else if (this.currentIndex >= 0) {
      this.statusBadge.textContent = '已暂停';
      this.statusBadge.classList.add('paused');
    } else {
      this.statusBadge.textContent = '已停止';
      this.statusBadge.classList.add('stopped');
    }
  }

  async loadPlaylist(channelId) {
    try {
      const response = await fetch(`${CONFIG.API_BASE}/api/channels/${channelId}/playlist`);
      const playlist = await response.json();
      this.playlist = playlist;
      this.playlistCount.textContent = playlist.length;
      this.renderPlaylist();
    } catch (err) {
      console.error('Failed to load playlist:', err);
    }
  }

  renderPlaylist() {
    if (this.playlist.length === 0) {
      this.playlistEl.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">播放列表为空</div>';
      return;
    }

    this.playlistEl.innerHTML = this.playlist.map(track => `
      <div class="playlist-item ${track.index === this.currentIndex ? 'current' : ''}" data-index="${track.index}">
        <span class="track-index">${track.index === this.currentIndex ? '♪' : track.index + 1}</span>
        <span class="track-title">${track.title}</span>
      </div>
    `).join('');

    this.playlistEl.querySelectorAll('.playlist-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.dataset.index);
        this.playTrack(index);
      });
    });
  }

  sendControl(command, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      action: 'control',
      channelId: this.currentChannel,
      command: command,
      params: params
    }));
  }

  playTrack(index) {
    this.sendControl('play', { index });
    this.currentIndex = index;
  }

  togglePlayPause() {
    if (this.isPlaying) {
      this.sendControl('pause');
    } else {
      if (this.currentIndex >= 0) {
        this.sendControl('resume');
      } else {
        this.sendControl('play');
      }
    }
  }

  nextTrack() {
    this.sendControl('next');
  }

  prevTrack() {
    this.sendControl('prev');
  }

  setVolume(value) {
    this.sendControl('volume', { volume: value / 100 });
  }

  bindEvents() {
    this.playPauseBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      this.togglePlayPause();
    });

    this.nextBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      this.nextTrack();
    });

    this.prevBtn.addEventListener('click', () => {
      if (!this.currentChannel) return;
      this.prevTrack();
    });

    this.channelVolume.addEventListener('input', (e) => {
      if (!this.currentChannel) return;
      this.setVolume(parseInt(e.target.value));
    });

    this.fadeInDuration.addEventListener('input', (e) => {
      this.fadeInValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    this.fadeOutDuration.addEventListener('input', (e) => {
      this.fadeOutValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    this.preFadeOutStart.addEventListener('input', (e) => {
      this.preFadeOutValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    this.crossfadeDuration.addEventListener('input', (e) => {
      this.crossfadeValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    this.applyFadeBtn.addEventListener('click', () => {
      this.applyFadeConfig();
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  new DJPanel();
});
