const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

class ChannelManager extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.channels = new Map();
    this.musicBaseDir = path.resolve(config.musicBaseDir);
  }

  init() {
    if (!fs.existsSync(this.musicBaseDir)) {
      fs.mkdirSync(this.musicBaseDir, { recursive: true });
    }

    for (const channelConfig of this.config.channels) {
      const channelDir = path.join(this.musicBaseDir, channelConfig.dir);
      if (!fs.existsSync(channelDir)) {
        fs.mkdirSync(channelDir, { recursive: true });
      }

      const channel = {
        id: channelConfig.id,
        name: channelConfig.name,
        description: channelConfig.description,
        dir: channelDir,
        bitrate: channelConfig.bitrate,
        sampleRate: channelConfig.sampleRate,
        playlist: [],
        currentTrack: null,
        currentIndex: -1,
        isPlaying: false,
        volume: 1.0,
        listeners: 0,
        mode: 'sequential'
      };

      this.channels.set(channel.id, channel);
      this.loadPlaylist(channel.id);
    }
  }

  getChannel(channelId) {
    return this.channels.get(channelId);
  }

  getAllChannels() {
    return Array.from(this.channels.values()).map(ch => ({
      id: ch.id,
      name: ch.name,
      description: ch.description,
      isPlaying: ch.isPlaying,
      currentTrack: ch.currentTrack,
      listeners: ch.listeners,
      volume: ch.volume
    }));
  }

  loadPlaylist(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return [];

    const audioExtensions = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma'];
    const files = fs.readdirSync(channel.dir)
      .filter(f => audioExtensions.includes(path.extname(f).toLowerCase()))
      .map(f => ({
        filename: f,
        path: path.join(channel.dir, f),
        title: path.basename(f, path.extname(f))
      }));

    channel.playlist = files;
    return files;
  }

  getPlaylist(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return [];
    return channel.playlist;
  }

  play(channelId, trackIndex = null) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    if (channel.playlist.length === 0) {
      this.loadPlaylist(channelId);
      if (channel.playlist.length === 0) {
        channel.isPlaying = false;
        channel.currentTrack = null;
        return null;
      }
    }

    if (trackIndex !== null) {
      channel.currentIndex = trackIndex;
    } else if (channel.currentIndex < 0 || channel.currentIndex >= channel.playlist.length) {
      channel.currentIndex = 0;
    }

    channel.currentTrack = channel.playlist[channel.currentIndex];
    channel.isPlaying = true;
    this.emit('play', channelId, channel.currentTrack);
    return channel.currentTrack;
  }

  pause(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    channel.isPlaying = false;
    this.emit('pause', channelId);
    return true;
  }

  resume(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    if (channel.currentTrack) {
      channel.isPlaying = true;
      this.emit('resume', channelId);
      return true;
    }
    return false;
  }

  next(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.playlist.length === 0) return null;

    channel.currentIndex = (channel.currentIndex + 1) % channel.playlist.length;
    channel.currentTrack = channel.playlist[channel.currentIndex];
    channel.isPlaying = true;
    this.emit('play', channelId, channel.currentTrack);
    return channel.currentTrack;
  }

  prev(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel || channel.playlist.length === 0) return null;

    channel.currentIndex = (channel.currentIndex - 1 + channel.playlist.length) % channel.playlist.length;
    channel.currentTrack = channel.playlist[channel.currentIndex];
    channel.isPlaying = true;
    this.emit('play', channelId, channel.currentTrack);
    return channel.currentTrack;
  }

  setVolume(channelId, volume) {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    channel.volume = Math.max(0, Math.min(1, volume));
    this.emit('volume', channelId, channel.volume);
    return true;
  }

  addListener(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return -1;

    channel.listeners++;
    this.emit('listeners', channelId, channel.listeners);
    return channel.listeners;
  }

  removeListener(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return -1;

    channel.listeners = Math.max(0, channel.listeners - 1);
    this.emit('listeners', channelId, channel.listeners);
    return channel.listeners;
  }

  getCurrentTrack(channelId) {
    const channel = this.channels.get(channelId);
    if (!channel) return null;
    return channel.currentTrack;
  }
}

module.exports = ChannelManager;
