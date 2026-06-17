const fs = require('fs');
const { execSync, spawn } = require('child_process');
const EventEmitter = require('events');
const StreamDistributor = require('./stream-distributor');
const ListenerManager = require('./listener-manager');
const { generateFFmpegFadeFilters, FADE_TYPES } = require('./fade-processor');

let ffmpeg = null;
let ffmpegAvailable = false;

try {
  ffmpeg = require('fluent-ffmpeg');
  try {
    execSync('ffmpeg -version 2>nul', { stdio: 'ignore' });
    ffmpegAvailable = true;
    console.log('[INFO] ffmpeg 已检测到，将使用硬件转码和服务端音量控制');
  } catch (e) {
    console.log('[WARN] 未检测到系统 ffmpeg，将使用原始音频透传模式（音量调节在客户端生效）');
  }
} catch (e) {
  console.log('[WARN] fluent-ffmpeg 未安装，将使用原始音频透传模式');
}

class AudioStreamer extends EventEmitter {
  constructor(channelManager) {
    super();
    this.channelManager = channelManager;
    this.distributors = new Map();
    this.currentProcesses = new Map();
    this.currentReadStreams = new Map();
    this.playbackState = new Map();
    this._isPlaying = new Map();
    this.listenerManager = new ListenerManager();
    this._connectionMap = new Map();
    this.trackDurations = new Map();
    this.fadeTimers = new Map();
    this._pendingNextTrack = new Map();

    this.listenerManager.on('listenersChange', (channelId, count) => {
      const channel = this.channelManager.getChannel(channelId);
      if (channel) {
        channel.listeners = count;
        this.channelManager.emit('listeners', channelId, count);
      }
    });

    this.channelManager.on('play', (channelId, track) => {
      this._startPlayback(channelId, track, 0);
    });

    this.channelManager.on('pause', (channelId) => {
      this._stopPlayback(channelId, true);
    });

    this.channelManager.on('resume', (channelId) => {
      const track = this.channelManager.getCurrentTrack(channelId);
      const state = this.playbackState.get(channelId);
      if (track && state) {
        this._startPlayback(channelId, track, state.position || 0);
      } else if (track) {
        this._startPlayback(channelId, track, 0);
      }
    });

    this.channelManager.on('volume', (channelId, volume) => {
      if (!ffmpegAvailable) return;
      const track = this.channelManager.getCurrentTrack(channelId);
      const state = this.playbackState.get(channelId);
      if (this._isPlaying.get(channelId) && track) {
        const position = state ? state.position : 0;
        this._stopPlayback(channelId, true);
        this._startPlayback(channelId, track, position);
      }
    });

    this.channelManager.on('fadeConfigChange', (channelId, fadeConfig) => {
      const track = this.channelManager.getCurrentTrack(channelId);
      const state = this.playbackState.get(channelId);
      if (this._isPlaying.get(channelId) && track) {
        const position = state ? state.position : 0;
        this._stopPlayback(channelId, true);
        this._startPlayback(channelId, track, position);
      }
      this.emit('fadeConfigChange', channelId, fadeConfig);
    });
  }

  async _getTrackDuration(trackPath) {
    if (this.trackDurations.has(trackPath)) {
      return this.trackDurations.get(trackPath);
    }

    if (!ffmpegAvailable) {
      this.trackDurations.set(trackPath, 0);
      return 0;
    }

    try {
      return new Promise((resolve) => {
        const ffprobe = spawn('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          trackPath
        ]);

        let duration = '';
        ffprobe.stdout.on('data', (data) => {
          duration += data.toString();
        });

        ffprobe.on('close', (code) => {
          if (code === 0) {
            const parsedDuration = parseFloat(duration.trim());
            if (!isNaN(parsedDuration) && parsedDuration > 0) {
              this.trackDurations.set(trackPath, parsedDuration);
              resolve(parsedDuration);
            } else {
              this.trackDurations.set(trackPath, 0);
              resolve(0);
            }
          } else {
            this.trackDurations.set(trackPath, 0);
            resolve(0);
          }
        });

        ffprobe.on('error', () => {
          this.trackDurations.set(trackPath, 0);
          resolve(0);
        });
      });
    } catch (e) {
      this.trackDurations.set(trackPath, 0);
      return 0;
    }
  }

  _clearFadeTimer(channelId) {
    const timer = this.fadeTimers.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.fadeTimers.delete(channelId);
    }
  }

  _scheduleNextTrack(channelId, track, trackDuration, fadeConfig) {
    this._clearFadeTimer(channelId);
    this._pendingNextTrack.delete(channelId);

    if (!fadeConfig || !fadeConfig.enabled || trackDuration <= 0) {
      return;
    }

    const { fadeOutDuration, preFadeOutStart } = fadeConfig;
    const nextTrackStartTime = Math.max(0, trackDuration - fadeOutDuration - preFadeOutStart) * 1000;

    if (nextTrackStartTime <= 0) return;

    const timer = setTimeout(() => {
      if (this._isPlaying.get(channelId)) {
        this._pendingNextTrack.set(channelId, true);
        process.nextTick(() => {
          if (this._isPlaying.get(channelId) && this._pendingNextTrack.get(channelId)) {
            this.channelManager.next(channelId);
          }
        });
      }
    }, nextTrackStartTime);

    this.fadeTimers.set(channelId, timer);
  }

  async _startPlayback(channelId, track, startPosition = 0) {
    const channel = this.channelManager.getChannel(channelId);
    if (!channel) return;

    this._clearFadeTimer(channelId);

    let distributor = this.distributors.get(channelId);
    if (!distributor) {
      distributor = new StreamDistributor();
      this.distributors.set(channelId, distributor);
    }

    this._isPlaying.set(channelId, true);
    this.playbackState.set(channelId, {
      track: track,
      position: startPosition,
      startTime: Date.now()
    });

    const trackDuration = await this._getTrackDuration(track.path);

    this.playbackState.set(channelId, {
      track: track,
      position: startPosition,
      startTime: Date.now(),
      duration: trackDuration
    });

    if (ffmpegAvailable) {
      this._playTrackWithFFmpeg(channelId, track, startPosition, channel.volume, trackDuration, channel.fade);
    } else {
      this._playTrackRaw(channelId, track, trackDuration, channel.fade);
    }

    this.emit('fadeStateChange', channelId, {
      type: 'fadeIn',
      duration: channel.fade.fadeInDuration,
      trackDuration: trackDuration
    });

    if (startPosition === 0 && channel.fade && channel.fade.enabled) {
      this._scheduleNextTrack(channelId, track, trackDuration, channel.fade);
    }
  }

  _playTrackWithFFmpeg(channelId, track, startPosition, volume, trackDuration = 0, fadeConfig = null) {
    const distributor = this.distributors.get(channelId);
    if (!distributor) return;
    if (!this._isPlaying.get(channelId)) return;

    this._cleanupProcess(channelId);
    this._cleanupReadStream(channelId);

    try {
      const writable = distributor.getWritableStream();
      let command = ffmpeg(track.path)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate('128k')
        .audioFrequency(44100)
        .audioChannels(2)
        .format('mp3');

      if (startPosition > 0) {
        command = command.seekInput(startPosition);
      }

      const filters = [];

      filters.push(`volume=${volume}`);

      if (fadeConfig && fadeConfig.enabled) {
        const fadeFilters = generateFFmpegFadeFilters(fadeConfig, trackDuration, startPosition);
        for (const filter of fadeFilters) {
          if (filter.options) {
            let filterStr = `${filter.filter}=`;
            const opts = [];
            for (const [key, value] of Object.entries(filter.options)) {
              opts.push(`${key}=${value}`);
            }
            filterStr += opts.join(':');
            filters.push(filterStr);
          }
        }
      }

      if (filters.length > 0) {
        command = command.audioFilters(filters);
      }

      command.on('error', (err) => {
        if (err.message && (err.message.includes('SIGKILL') || err.message.includes('Output stream'))) {
          return;
        }
        if (!this._isPlaying.get(channelId)) return;
        if (!this.distributors.has(channelId)) return;
        this._clearFadeTimer(channelId);
        this._pendingNextTrack.delete(channelId);
        process.nextTick(() => {
          if (this._isPlaying.get(channelId)) {
            this.channelManager.next(channelId);
          }
        });
      });

      command.on('end', () => {
        if (!this._isPlaying.get(channelId)) return;
        if (!this.distributors.has(channelId)) return;
        this._clearFadeTimer(channelId);
        this._pendingNextTrack.delete(channelId);
        process.nextTick(() => {
          if (this._isPlaying.get(channelId)) {
            this.channelManager.next(channelId);
          }
        });
      });

      const ffstream = command.pipe();
      this.currentProcesses.set(channelId, { command, ffstream });

      let bytesRead = 0;
      ffstream.on('data', (chunk) => {
        bytesRead += chunk.length;
        const state = this.playbackState.get(channelId);
        if (state) {
          const bitrateBytesPerSec = 128 * 1024 / 8;
          state.position = startPosition + (bytesRead / bitrateBytesPerSec);
          
          if (fadeConfig && fadeConfig.enabled && trackDuration > 0) {
            const fadeOutStart = trackDuration - fadeConfig.fadeOutDuration - fadeConfig.preFadeOutStart;
            if (state.position >= fadeOutStart && state.position < (fadeOutStart + 0.1)) {
              this.emit('fadeStateChange', channelId, {
                type: 'fadeOut',
                duration: fadeConfig.fadeOutDuration,
                remainingTime: trackDuration - state.position
              });
            }
          }
        }
      });

      ffstream.pipe(writable, { end: false });

    } catch (err) {
      console.error(`Failed to play track for channel ${channelId}:`, err.message);
    }
  }

  _playTrackRaw(channelId, track, trackDuration = 0, fadeConfig = null) {
    const distributor = this.distributors.get(channelId);
    if (!distributor) return;
    if (!this._isPlaying.get(channelId)) return;

    this._cleanupProcess(channelId);
    this._cleanupReadStream(channelId);

    try {
      const readStream = fs.createReadStream(track.path);
      this.currentReadStreams.set(channelId, readStream);

      readStream.on('end', () => {
        if (!this._isPlaying.get(channelId)) return;
        if (!this.distributors.has(channelId)) return;
        this._clearFadeTimer(channelId);
        this._pendingNextTrack.delete(channelId);
        process.nextTick(() => {
          if (this._isPlaying.get(channelId)) {
            this.channelManager.next(channelId);
          }
        });
      });

      readStream.on('error', (err) => {
        console.error(`Read stream error for channel ${channelId}:`, err.message);
        if (!this._isPlaying.get(channelId)) return;
        this._clearFadeTimer(channelId);
        this._pendingNextTrack.delete(channelId);
        process.nextTick(() => {
          if (this._isPlaying.get(channelId)) {
            this.channelManager.next(channelId);
          }
        });
      });

      const writable = distributor.getWritableStream();
      
      const ext = track.filename.split('.').pop().toLowerCase();
      if (ext === 'wav' && fadeConfig && fadeConfig.enabled && trackDuration > 0) {
        const { FadeTransform } = require('./fade-processor');
        const channel = this.channelManager.getChannel(channelId);
        const fadeTransform = new FadeTransform(
          fadeConfig,
          trackDuration,
          channel ? channel.sampleRate : 44100,
          2,
          16
        );
        fadeTransform.setBaseVolume(channel ? channel.volume : 1.0);
        
        let bytesRead = 0;
        fadeTransform.on('data', (chunk) => {
          bytesRead += chunk.length;
          const state = this.playbackState.get(channelId);
          if (state) {
            const bitrateBytesPerSec = 44100 * 2 * 2;
            state.position = bytesRead / bitrateBytesPerSec;
          }
        });
        
        readStream.pipe(fadeTransform).pipe(writable, { end: false });
      } else {
        readStream.pipe(writable, { end: false });
      }

    } catch (err) {
      console.error(`Failed to play track for channel ${channelId}:`, err.message);
    }
  }

  _cleanupProcess(channelId) {
    const proc = this.currentProcesses.get(channelId);
    if (proc) {
      try {
        const distributor = this.distributors.get(channelId);
        if (distributor) {
          try {
            proc.ffstream.unpipe(distributor.getWritableStream());
          } catch (e) {}
        }
        try {
          proc.ffstream.destroy();
        } catch (e) {}
        try {
          proc.command.kill('SIGKILL');
        } catch (e) {}
      } catch (e) {}
      this.currentProcesses.delete(channelId);
    }
  }

  _cleanupReadStream(channelId) {
    const readStream = this.currentReadStreams.get(channelId);
    if (readStream) {
      try {
        const distributor = this.distributors.get(channelId);
        if (distributor) {
          try {
            readStream.unpipe(distributor.getWritableStream());
          } catch (e) {}
        }
        readStream.destroy();
      } catch (e) {}
      this.currentReadStreams.delete(channelId);
    }
  }

  _stopPlayback(channelId, keepState = false) {
    this._isPlaying.set(channelId, false);

    this._clearFadeTimer(channelId);
    this._pendingNextTrack.delete(channelId);

    this._cleanupProcess(channelId);
    this._cleanupReadStream(channelId);

    if (!keepState) {
      const distributor = this.distributors.get(channelId);
      if (distributor) {
        try {
          distributor.destroy();
        } catch (e) {}
        this.distributors.delete(channelId);
      }
      this.playbackState.delete(channelId);
    }
  }

  createClientStream(channelId, userId = null, replaceUser = false) {
    if (replaceUser && userId) {
      this.removeStreamsForUserOnChannel(channelId, userId);
    }

    let distributor = this.distributors.get(channelId);
    if (!distributor) {
      distributor = new StreamDistributor();
      this.distributors.set(channelId, distributor);
      const channel = this.channelManager.getChannel(channelId);
      if (channel && channel.isPlaying && channel.currentTrack) {
        const state = this.playbackState.get(channelId);
        this._startPlayback(channelId, channel.currentTrack, state ? state.position : 0);
      }
    }

    const clientStream = distributor.addClient();
    if (!clientStream) return null;

    const connectionId = this.listenerManager.addListener(channelId, userId);
    this._connectionMap.set(clientStream, { channelId, connectionId, touchTimer: null });

    const handleData = () => {
      const info = this._connectionMap.get(clientStream);
      if (info) {
        this.listenerManager.touch(info.connectionId, channelId);
      }
    };

    let touchCount = 0;
    clientStream.on('data', () => {
      touchCount++;
      if (touchCount % 20 === 0) {
        handleData();
      }
    });

    const info = this._connectionMap.get(clientStream);
    if (info) {
      info.touchTimer = setInterval(() => {
        this.listenerManager.touch(info.connectionId, channelId);
      }, 5000);
    }

    const handleClose = () => {
      const info = this._connectionMap.get(clientStream);
      if (info) {
        if (info.touchTimer) {
          clearInterval(info.touchTimer);
        }
        this.listenerManager.removeListener(info.channelId, info.connectionId);
        this._connectionMap.delete(clientStream);
      }
    };

    clientStream.once('close', handleClose);
    clientStream.once('error', handleClose);
    clientStream.once('finish', handleClose);

    return { stream: clientStream, connectionId };
  }

  removeStreamsForUserOnChannel(channelId, userId) {
    if (!userId) return 0;
    let removed = 0;
    const distributor = this.distributors.get(channelId);
    for (const [stream, info] of this._connectionMap.entries()) {
      if (info.channelId !== channelId) continue;
      const connInfo = this.listenerManager.getConnectionInfo(info.connectionId, info.channelId);
      if (connInfo && connInfo.userId === userId) {
        removed++;
        try {
          if (info.touchTimer) {
            clearInterval(info.touchTimer);
          }
        } catch (e) {}
        try {
          if (distributor) {
            distributor.removeClient(stream);
          }
        } catch (e) {}
        try {
          stream.destroy();
        } catch (e) {}
        this._connectionMap.delete(stream);
        this.listenerManager.removeListener(info.channelId, info.connectionId);
      }
    }
    return removed;
  }

  hasStream(channelId) {
    return this.distributors.has(channelId);
  }

  getListenerCount(channelId) {
    return this.listenerManager.getListenerCount(channelId);
  }

  removeAllStreamsForUser(userId) {
    if (!userId) return 0;
    const channelConnections = new Map();
    for (const [stream, info] of this._connectionMap.entries()) {
      const connInfo = this.listenerManager.getConnectionInfo(info.connectionId, info.channelId);
      if (connInfo && connInfo.userId === userId) {
        if (!channelConnections.has(info.channelId)) {
          channelConnections.set(info.channelId, []);
        }
        channelConnections.get(info.channelId).push({ stream, info });
      }
    }
    for (const [channelId, items] of channelConnections.entries()) {
      const distributor = this.distributors.get(channelId);
      for (const { stream, info } of items) {
        try {
          if (info.touchTimer) {
            clearInterval(info.touchTimer);
          }
        } catch (e) {}
        try {
          if (distributor) {
            distributor.removeClient(stream);
          }
        } catch (e) {}
        try {
          stream.destroy();
        } catch (e) {}
        this._connectionMap.delete(stream);
      }
    }
    this.listenerManager.removeAllForUser(userId);
    return channelConnections.size;
  }

  shutdown() {
    for (const channelId of this.distributors.keys()) {
      this._stopPlayback(channelId, false);
    }
    this.listenerManager.shutdown();
  }
}

module.exports = AudioStreamer;
